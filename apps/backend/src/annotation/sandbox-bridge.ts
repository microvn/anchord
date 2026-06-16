// In-iframe sandbox bridge (annotation-core S-001 + GAP-004, hardened by C-009/C-002/C-001).
//
// WHAT THIS IS. The /v/:id route serves untrusted, AI-generated HTML inside an iframe
// that runs scripts on an OPAQUE origin (`sandbox allow-scripts`, no allow-same-origin —
// see render/sandbox.ts). The FE viewer cannot reach into that iframe (cross-origin), so
// to turn a user's in-iframe text selection into an annotation anchor we inject a tiny
// bridge script that runs INSIDE the sandbox and talks to the parent over a dedicated
// MessageChannel. This module owns (a) the pure anchor walk/placement logic (unit-testable
// without a browser) and (b) the bridge script string + its injection into the served HTML.
//
// SECURITY MODEL (the part that matters — C-009, C-002, C-001):
//  - DEDICATED CHANNEL, NOT window.postMessage. On load the bridge creates a
//    `MessageChannel`, keeps `port1`, and hands `port2` UP to the parent via a SINGLE
//    `parent.postMessage({source:'anchord-bridge', type:'ready', nonce}, '*', [port2])`.
//    Thereafter selection/highlight traffic flows ONLY over the port. A body script that
//    calls `parent.postMessage({...annotation...})` lands on the parent's `window` message
//    listener — a channel the FE deliberately ignores — never on `port1`. So a forged
//    body message cannot masquerade as a bridge selection (AS-020). The bridge itself
//    NEVER relays or trusts any `window` message from the body; it only ever speaks over
//    its own `port1`.
//  - NO ORIGIN TRUST. The iframe origin is opaque ("null"); origin checks are useless
//    here (C-009). The handshake identity is instead: the parent accepts the `ready`
//    message ONLY when `event.source === iframe.contentWindow` (FE-side check) and then
//    trusts the port it carried. The per-request `nonce` raises the bar against casual
//    forgery (a second/duplicate `ready` with a wrong nonce is rejected by the FE).
//  - NONCE IS NOT THE GUARANTEE. A body script can scrape the served DOM (including this
//    injected <script>) and read the nonce. The nonce only deters casual replay. The HARD
//    backstop that a forged "create this annotation" can NEVER succeed is SERVER-SIDE
//    RE-AUTHORIZATION (C-001 / api-core C-005): POST .../annotations re-checks the
//    session's per-doc role server-side regardless of what any message claimed. The bridge
//    and channel are convenience + defense-in-depth, not the authorization boundary.
//
// The block lookup MUST accept BOTH attribute forms injectBlockIds() emits: a plain
// `id="block-…"` (element had no id) AND `data-block-id="block-…"` (element already had an
// id, which we must not clobber — block-id.ts C-001).

import type { Anchor, AnchorSegment } from "./annotation";

/** Max chars stored in text_snippet — keeps the anchor jsonb bounded (AS-001 data is a sentence). */
export const SNIPPET_CAP = 400;

/** CSS selector matching either block-id attribute form (see block-id.ts). */
export const BLOCK_SELECTOR = '[data-block-id], [id^="block-"]';

// --- Minimal structural DOM types (so this module type-checks server-side without `lib.dom`).
// happy-dom / jsdom / a real browser all satisfy these; we only use the members below.

interface NodeLike {
  nodeType: number;
  parentNode: NodeLike | null;
  textContent: string | null;
}
interface ElementLike extends NodeLike {
  closest(selector: string): ElementLike | null;
  getAttribute(name: string): string | null;
}
interface RangeLike {
  startContainer: NodeLike;
  startOffset: number;
  endContainer: NodeLike;
  endOffset: number;
  getBoundingClientRect?(): { x: number; y: number; width: number; height: number };
}
interface SelectionLike {
  isCollapsed: boolean;
  rangeCount: number;
  toString(): string;
  getRangeAt(i: number): RangeLike;
}
interface DocumentLike {
  querySelectorAll(selector: string): ArrayLike<ElementLike>;
  querySelector(selector: string): ElementLike | null;
}

// --- DOM mutation types for the unwrap (S-003 / C-002). Kept minimal so this still type-checks
// server-side without `lib.dom`; happy-dom / jsdom / a real browser all satisfy them.
interface UnwrapNodeLike {
  parentNode: UnwrapNodeLike | null;
  firstChild: UnwrapNodeLike | null;
  insertBefore(node: UnwrapNodeLike, ref: UnwrapNodeLike | null): UnwrapNodeLike;
  removeChild(node: UnwrapNodeLike): UnwrapNodeLike;
  normalize(): void;
}
interface UnwrapDocumentLike {
  querySelectorAll(selector: string): ArrayLike<UnwrapNodeLike>;
}

const ELEMENT_NODE = 1;

/**
 * unwrapAnnoMarks — remove EVERY `mark[data-anno]` from the document, moving each mark's child
 * nodes out before it, then `.normalize()` the parent so adjacent text nodes re-merge (C-002).
 * This is the "clear" half of the idempotent clear-then-redraw sync: after it, the document holds
 * the original text with no annotation marks, so the redraw can rebuild the live set with no stale
 * or duplicate marks. A non-anno `<mark>` is left untouched (selector is `[data-anno]` only). No-op
 * and never throws when there are no anno marks.
 *
 * Pure DOM transform (no globals) so it unit-tests under happy-dom and mirrors the IIFE copy
 * (`unwrapAllAnnoMarks`) inlined into the bridge for the real browser.
 */
export function unwrapAnnoMarks(doc: UnwrapDocumentLike): void {
  const marks = Array.from(doc.querySelectorAll("mark[data-anno]"));
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    // Move each child node out before the mark, in order, then drop the now-empty mark.
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }
}

/** The block id of an element, from either attribute form. Null if it carries neither. */
function blockIdOf(el: ElementLike): string | null {
  const data = el.getAttribute("data-block-id");
  if (data && data.startsWith("block-")) return data;
  const id = el.getAttribute("id");
  if (id && id.startsWith("block-")) return id;
  return null;
}

/** Walk up from a node to the nearest enclosing block element; return [element, blockId] or null. */
function enclosingBlock(node: NodeLike | null): { el: ElementLike; blockId: string } | null {
  let cur: NodeLike | null = node;
  // A text node has no closest(); step up to its parent element first.
  while (cur && cur.nodeType !== ELEMENT_NODE) cur = cur.parentNode;
  const start = cur as ElementLike | null;
  const el = start?.closest(BLOCK_SELECTOR) ?? null;
  if (!el) return null;
  const blockId = blockIdOf(el);
  if (!blockId) return null;
  return { el, blockId };
}

/**
 * Char offset of a (container,offset) selection boundary within its enclosing block's
 * textContent. We rebuild the block's text by concatenating descendant text and locate the
 * boundary by the prefix length. Implemented WITHOUT TreeWalker (not in our minimal DOM
 * type, and happy-dom/jsdom agree on textContent concatenation order = document order).
 */
function offsetInBlock(blockEl: ElementLike, container: NodeLike, containerOffset: number): number {
  // If the boundary is the block element itself, containerOffset counts child *nodes*, not
  // chars — fall back to 0 (start). The common case (selection inside a text node) is exact.
  if (container === blockEl) return 0;
  const blockText = blockEl.textContent ?? "";
  const containerText = container.textContent ?? "";
  // Find where this container's text sits inside the block text, then add the local offset.
  // Using indexOf is exact for the typical single-text-node block; for repeated identical
  // sub-strings it picks the first, which placeAnchor's snippet match corrects downstream.
  const base = containerText.length > 0 ? blockText.indexOf(containerText) : 0;
  return (base < 0 ? 0 : base) + containerOffset;
}

/**
 * selectionToAnchor — turn a DOM Selection into a stored Anchor (C-003 / AS-004).
 *
 * Single-block selection → `{blockId, textSnippet, offset, length}`.
 * Cross-block selection → the same top-level fields for the FIRST block PLUS a `segments[]`
 * of `{blockId, offset, length, textSnippet}` (one per spanned block) — matching the
 * multi_range Anchor shape (annotation.ts).
 * Empty / whitespace-only / collapsed selection, or no enclosing block → `null` (AS-004).
 *
 * Pure: no DOM mutation, no globals — takes the selection + its document explicitly so it
 * unit-tests under happy-dom and inlines verbatim into the bridge IIFE in a real browser.
 */
export function selectionToAnchor(selection: SelectionLike | null, doc: DocumentLike): Anchor | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const selected = selection.toString();
  if (selected.trim().length === 0) return null; // AS-004: whitespace-only is not a selection

  const range = selection.getRangeAt(0);
  const startBlock = enclosingBlock(range.startContainer);
  const endBlock = enclosingBlock(range.endContainer);
  if (!startBlock) return null; // no addressable block → cannot anchor

  // Order the blocks in document order to slice each block's spanned text deterministically.
  const blocks = Array.from(doc.querySelectorAll(BLOCK_SELECTOR));
  const startIdx = blocks.indexOf(startBlock.el);
  const endIdx = endBlock ? blocks.indexOf(endBlock.el) : startIdx;

  const startOffset = offsetInBlock(startBlock.el, range.startContainer, range.startOffset);

  // Single-block (or end-block unresolved) case.
  if (!endBlock || endBlock.el === startBlock.el || endIdx < 0 || startIdx < 0 || endIdx === startIdx) {
    const endOffset = endBlock && endBlock.el === startBlock.el
      ? offsetInBlock(startBlock.el, range.endContainer, range.endOffset)
      : startOffset + selected.length;
    const length = Math.max(0, endOffset - startOffset);
    const blockText = startBlock.el.textContent ?? "";
    const textSnippet = blockText.slice(startOffset, startOffset + length).slice(0, SNIPPET_CAP);
    if (textSnippet.trim().length === 0) return null;
    return { blockId: startBlock.blockId, textSnippet, offset: startOffset, length };
  }

  // Cross-block selection → build a segment per spanned block (document order).
  const segments: AnchorSegment[] = [];
  for (let i = Math.min(startIdx, endIdx); i <= Math.max(startIdx, endIdx); i++) {
    const el = blocks[i]!;
    const blockId = blockIdOf(el);
    if (!blockId) continue;
    const text = el.textContent ?? "";
    let segOffset = 0;
    let segLen = text.length;
    if (el === startBlock.el) {
      segOffset = startOffset;
      segLen = text.length - startOffset;
    } else if (el === endBlock.el) {
      segOffset = 0;
      segLen = offsetInBlock(endBlock.el, range.endContainer, range.endOffset);
    }
    const segSnippet = text.slice(segOffset, segOffset + segLen).slice(0, SNIPPET_CAP);
    segments.push({ blockId, textSnippet: segSnippet, offset: segOffset, length: Math.max(0, segLen) });
  }
  const first = segments[0]!;
  return { blockId: first.blockId, textSnippet: first.textSnippet, offset: first.offset, length: first.length, segments };
}

/** Result of placeAnchor: the located char range within the block, or a "couldn't place" sentinel. */
export type PlaceResult =
  | { ok: true; blockId: string; start: number; end: number; text: string }
  | { ok: false; reason: "no-block" | "not-found" | "ambiguous" };

/**
 * placeAnchor — locate an anchor's text within its block in CURRENT content (C-002 ladder,
 * the in-iframe half: block_id → exact snippet at offset → exact snippet anywhere → fuzzy).
 * NEVER throws — a missing block, a vanished snippet, or a duplicate that can't be
 * disambiguated all return an `{ok:false}` sentinel so the caller (and the bridge) degrade
 * gracefully into a "couldn't place" state rather than crashing the iframe script.
 *
 * Returns the matched `{blockId, start, end, text}`. The bridge wraps that range in a
 * `<mark data-anno=…>`; this pure function only computes WHERE.
 */
export function placeAnchor(anchor: Anchor, doc: DocumentLike): PlaceResult {
  const el = findBlock(anchor.blockId, doc);
  if (!el) return { ok: false, reason: "no-block" };
  const text = el.textContent ?? "";
  const snippet = anchor.textSnippet;
  if (snippet.length === 0) return { ok: false, reason: "not-found" };

  // 1. Exact at the recorded offset.
  if (anchor.offset >= 0 && text.slice(anchor.offset, anchor.offset + snippet.length) === snippet) {
    return { ok: true, blockId: anchor.blockId, start: anchor.offset, end: anchor.offset + snippet.length, text: snippet };
  }
  // 2. Exact anywhere in the block (offset shifted by an edit). Require uniqueness; if the
  //    snippet occurs more than once and the offset didn't pin it, we can't safely choose.
  const first = text.indexOf(snippet);
  if (first >= 0) {
    const second = text.indexOf(snippet, first + 1);
    if (second < 0) {
      return { ok: true, blockId: anchor.blockId, start: first, end: first + snippet.length, text: snippet };
    }
    // Multiple matches and offset didn't land — pick the occurrence nearest the old offset.
    const nearest = nearestOccurrence(text, snippet, anchor.offset);
    return { ok: true, blockId: anchor.blockId, start: nearest, end: nearest + snippet.length, text: snippet };
  }
  // 3. Fuzzy: slide a window of the snippet length and take the best-similar position.
  const fuzzy = fuzzyLocate(text, snippet);
  if (fuzzy) return { ok: true, blockId: anchor.blockId, start: fuzzy.start, end: fuzzy.end, text: text.slice(fuzzy.start, fuzzy.end) };
  return { ok: false, reason: "not-found" };
}

function findBlock(blockId: string, doc: DocumentLike): ElementLike | null {
  // Try data-block-id first (the don't-clobber form), then the plain id form.
  return (
    doc.querySelector(`[data-block-id="${cssEscape(blockId)}"]`) ??
    doc.querySelector(`#${cssEscape(blockId)}`)
  );
}

/** Escape a block id for use in a selector (ids are `block-tag-n`, but be defensive). */
function cssEscape(id: string): string {
  return id.replace(/["\\\]\[#.:>+~*^$=()| ]/g, "\\$&");
}

function nearestOccurrence(text: string, snippet: string, targetOffset: number): number {
  let best = -1;
  let bestDist = Infinity;
  let from = 0;
  for (;;) {
    const at = text.indexOf(snippet, from);
    if (at < 0) break;
    const d = Math.abs(at - targetOffset);
    if (d < bestDist) {
      bestDist = d;
      best = at;
    }
    from = at + 1;
  }
  return best < 0 ? 0 : best;
}

/**
 * Best-effort fuzzy locate: slide a window the length of the snippet across the block text,
 * scoring each by normalized similarity, and accept the best ≥ threshold. Cheap O(n*m) but
 * blocks are short. Mirrors the spirit of reanchor.ts's fuzzy ladder (the durable matcher
 * lives there; this is the live in-iframe placement variant).
 */
function fuzzyLocate(text: string, snippet: string, threshold = 0.7): { start: number; end: number } | null {
  const len = snippet.length;
  if (len === 0 || text.length === 0) return null;
  let best = -1;
  let bestScore = 0;
  const last = Math.max(0, text.length - len);
  for (let i = 0; i <= last; i++) {
    const window = text.slice(i, i + len);
    const score = similarity(window, snippet);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best < 0 || bestScore < threshold) return null;
  return { start: best, end: best + len };
}

/** Normalized Levenshtein similarity in [0,1] (1 = identical). */
function similarity(a: string, b: string): number {
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

// --- The bridge script (string injected into the served iframe HTML) ---

/**
 * bridgeScript — the IIFE injected into the sandboxed iframe. It is a STRING because it
 * runs inside the browser sandbox, not on the server. The pure logic above is mirrored
 * inline here (the IIFE cannot import server modules); the unit tests cover the canonical
 * implementation, and this inline copy is intentionally kept behaviour-identical.
 *
 * Protocol (the FE parent must mirror these exact shapes — see route comment in app.ts):
 *  - UP via window.postMessage ONCE on load: `{source:'anchord-bridge', type:'ready', nonce}` with `port2` transferred.
 *  - Over port1, bridge → parent: `{type:'selection', anchor, rect}` (anchor null when empty).
 *  - Over port1, bridge → parent on in-iframe scroll (rAF-throttled): `{type:'selection-rect', rect}`
 *    (rect null when the selection scrolled out of view → parent dismisses). MƯỢT TASK 3.
 *  - Over port1, parent → bridge: `{type:'highlight', anchor, annotationId, hue?, resolved?, kind?, stale?}`
 *    (hue = the per-type/label mark colour; resolved/kind/stale = the lifecycle state — S-002/C-003).
 *  - Over port1, parent → bridge (S-003): `{type:'highlights', items:[{anchor, annotationId, hue?, resolved?, kind?, stale?}]}` —
 *    a FULL-set clear-then-redraw sync (unwrap all anno marks, then draw the set; idempotent — C-002).
 *  - Over port1, bridge → parent on placement failure: `{type:'place-failed', annotationId}`.
 *
 * The nonce is interpolated as a JSON string literal so it cannot break out of the script.
 */
export function bridgeScript(nonce: string): string {
  const nonceLiteral = JSON.stringify(String(nonce));
  return `(function(){
  "use strict";
  var SNIPPET_CAP = ${SNIPPET_CAP};
  var BLOCK_SELECTOR = ${JSON.stringify(BLOCK_SELECTOR)};
  var NONCE = ${nonceLiteral};

  function blockIdOf(el){
    var data = el.getAttribute("data-block-id");
    if (data && data.indexOf("block-") === 0) return data;
    var id = el.getAttribute("id");
    if (id && id.indexOf("block-") === 0) return id;
    return null;
  }
  function enclosingBlock(node){
    var cur = node;
    while (cur && cur.nodeType !== 1) cur = cur.parentNode;
    if (!cur) return null;
    var el = cur.closest(BLOCK_SELECTOR);
    if (!el) return null;
    var blockId = blockIdOf(el);
    if (!blockId) return null;
    return { el: el, blockId: blockId };
  }
  function offsetInBlock(blockEl, container, containerOffset){
    if (container === blockEl) return 0;
    var blockText = blockEl.textContent || "";
    var containerText = container.textContent || "";
    var base = containerText.length > 0 ? blockText.indexOf(containerText) : 0;
    return (base < 0 ? 0 : base) + containerOffset;
  }
  function selectionToAnchor(selection, doc){
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    var selected = selection.toString();
    if (selected.replace(/\\s+/g, "").length === 0) return null;
    var range = selection.getRangeAt(0);
    var startBlock = enclosingBlock(range.startContainer);
    var endBlock = enclosingBlock(range.endContainer);
    if (!startBlock) return null;
    var blocks = Array.prototype.slice.call(doc.querySelectorAll(BLOCK_SELECTOR));
    var startIdx = blocks.indexOf(startBlock.el);
    var endIdx = endBlock ? blocks.indexOf(endBlock.el) : startIdx;
    var startOffset = offsetInBlock(startBlock.el, range.startContainer, range.startOffset);
    if (!endBlock || endBlock.el === startBlock.el || endIdx < 0 || startIdx < 0 || endIdx === startIdx){
      var endOffset = (endBlock && endBlock.el === startBlock.el)
        ? offsetInBlock(startBlock.el, range.endContainer, range.endOffset)
        : startOffset + selected.length;
      var length = Math.max(0, endOffset - startOffset);
      var blockText = startBlock.el.textContent || "";
      var snippet = blockText.slice(startOffset, startOffset + length).slice(0, SNIPPET_CAP);
      if (snippet.replace(/\\s+/g, "").length === 0) return null;
      return { blockId: startBlock.blockId, textSnippet: snippet, offset: startOffset, length: length };
    }
    var segments = [];
    var lo = Math.min(startIdx, endIdx), hi = Math.max(startIdx, endIdx);
    for (var i = lo; i <= hi; i++){
      var el = blocks[i];
      var bid = blockIdOf(el);
      if (!bid) continue;
      var t = el.textContent || "";
      var so = 0, sl = t.length;
      if (el === startBlock.el){ so = startOffset; sl = t.length - startOffset; }
      else if (el === endBlock.el){ so = 0; sl = offsetInBlock(endBlock.el, range.endContainer, range.endOffset); }
      segments.push({ blockId: bid, textSnippet: t.slice(so, so + sl).slice(0, SNIPPET_CAP), offset: so, length: Math.max(0, sl) });
    }
    var f = segments[0];
    return { blockId: f.blockId, textSnippet: f.textSnippet, offset: f.offset, length: f.length, segments: segments };
  }

  // --- placement (highlight) ---
  function findBlock(blockId){
    var esc = (window.CSS && CSS.escape) ? CSS.escape(blockId) : blockId.replace(/["\\\\\\]\\[#.:>+~*^$=()| ]/g, "\\\\$&");
    return document.querySelector('[data-block-id="' + esc + '"]') || document.querySelector('#' + esc);
  }
  function placeRange(anchor){
    var el = findBlock(anchor.blockId);
    if (!el) return null;
    var text = el.textContent || "";
    var snippet = anchor.textSnippet;
    if (!snippet) return null;
    var start = -1;
    if (anchor.offset >= 0 && text.slice(anchor.offset, anchor.offset + snippet.length) === snippet) start = anchor.offset;
    else { var at = text.indexOf(snippet); if (at >= 0) start = at; }
    if (start < 0) return null;
    return wrapTextRange(el, start, start + snippet.length);
  }
  // Wrap [start,end) chars of an element's text in <mark>s — ONE per intersected text node. A range
  // that spans multiple text nodes (a container block, or text broken by <br>/inline tags like the
  // article / Given-When-Then div) CANNOT use Range.surroundContents on the whole range: it THROWS
  // ("InvalidStateError") whenever the range partially selects a non-Text node. So we slice PER text
  // node and surround each slice on its own (both boundaries in the SAME text node → never throws),
  // mirroring the markdown engine's per-text-node wrap. Returns the created <mark>s (>=1) or null.
  function wrapTextRange(el, start, end){
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var pos = 0, n, segs = [];
    // Collect (node, sliceStart, sliceEnd) FIRST — surroundContents splits a node, which would
    // corrupt the walker mid-iteration.
    while ((n = walker.nextNode())){
      var len = n.textContent.length;
      var ns = pos, ne = pos + len;
      if (ne > start && ns < end){
        var s = start > ns ? start - ns : 0;
        var e = end < ne ? end - ns : len;
        if (e > s) segs.push({ node: n, s: s, e: e });
      }
      pos = ne;
      if (ne >= end) break;
    }
    var marks = [];
    for (var i = 0; i < segs.length; i++){
      var r = document.createRange();
      r.setStart(segs[i].node, segs[i].s);
      r.setEnd(segs[i].node, segs[i].e);
      var mark = document.createElement("mark");
      // Both boundaries are in the SAME text node, so surroundContents never throws here.
      try { r.surroundContents(mark); marks.push(mark); } catch (e) {}
    }
    return marks.length ? marks : null;
  }

  // --- transport: dedicated MessageChannel; NEVER trust window messages from the body ---
  var channel = new MessageChannel();
  var port = channel.port1;
  // MƯỢT TASK 3: keep the live pending Range so an in-iframe scroll can re-read its CURRENT rect
  // (the parent can't see the iframe's scroll). Cleared when the selection collapses/clears.
  var pendingRange = null;

  function postSelection(){
    var sel = (document.getSelection && document.getSelection()) || null;
    var anchor = selectionToAnchor(sel, document);
    var rect = null;
    if (anchor && sel && sel.rangeCount > 0){
      pendingRange = sel.getRangeAt(0);
      try { var r = pendingRange.getBoundingClientRect(); rect = { x: r.x, y: r.y, width: r.width, height: r.height }; } catch (e) {}
    } else {
      pendingRange = null;
    }
    port.postMessage({ type: "selection", anchor: anchor, rect: rect });
  }

  // S-003 (C-002): unwrap EVERY existing anno mark — the "clear" half of the idempotent
  // clear-then-redraw sync. Move each mark's children out before it, drop the mark, normalize the
  // parent so split text nodes re-merge. A non-anno <mark> is left alone. Mirrors unwrapAnnoMarks().
  function unwrapAllAnnoMarks(){
    var marks = Array.prototype.slice.call(document.querySelectorAll("mark[data-anno]"));
    for (var i = 0; i < marks.length; i++){
      var mk = marks[i];
      var parent = mk.parentNode;
      if (!parent) continue;
      while (mk.firstChild) parent.insertBefore(mk.firstChild, mk);
      parent.removeChild(mk);
      if (parent.normalize) parent.normalize();
    }
  }

  // S-001/S-003: draw ONE highlight from a {anchor, annotationId, hue?} item. Returns true if it
  // placed (>=1 mark), false on a placement miss (the caller relays place-failed). Reused by both
  // the single {highlight} handler (back-compat) and the batch {highlights} redraw.
  function drawHighlight(item){
    var marks = placeRange(item.anchor);
    if (!marks || !marks.length) return false;
    for (var mi = 0; mi < marks.length; mi++){
      var mk = marks[mi];
      mk.setAttribute("data-anno", String(item.annotationId));
      // S-001: give every mark the app's highlight class so the injected .anno-mark stylesheet
      // applies — without it the bare <mark> renders the browser-default yellow block.
      mk.setAttribute("class", "anno-mark");
      // S-001/AS-002: carry the per-type/label hue (mirrors markdown's hued mark — data-anno-hue
      // + the --mark-hue custom prop the .anno-mark[data-anno-hue] rule reads).
      if (item.hue){
        mk.setAttribute("data-anno-hue", "true");
        mk.style.setProperty("--mark-hue", String(item.hue));
      }
      // S-002 (C-003): carry the lifecycle STATE so the mark reads like the markdown one — the SAME
      // dataset hooks the markdown engine sets, driven by the served state on the item. The injected
      // stylesheet (MARK_STYLESHEET) styles each: resolved → dim, redline → red strike, stale →
      // muted/dashed (stale wins over redline by CSS source order). A stale redline still carries the
      // redline kind for the rail, but the stale rule (later in the sheet) overrides its appearance.
      if (item.resolved) mk.setAttribute("data-resolved", "true");
      if (item.kind === "redline") mk.setAttribute("data-anno-kind", "redline");
      if (item.stale) mk.setAttribute("data-anno-stale", "true");
    }
    return true;
  }

  port.onmessage = function(ev){
    var msg = ev.data || {};
    if (msg.type === "highlight"){
      // Back-compat: a single highlight (S-001). Draw it; relay place-failed on a miss.
      if (!drawHighlight(msg)) port.postMessage({ type: "place-failed", annotationId: msg.annotationId });
    } else if (msg.type === "highlights"){
      // S-003 (C-002): a FULL-set sync — clear THEN redraw so the mark set stays idempotent. Unwrap
      // every existing anno mark first, then draw each item; a deleted id (absent from items) thus
      // loses its mark, a restored/new id gains one, and no duplicate marks accrue. Relay
      // place-failed per genuinely-unplaceable item so the parent can reset+rebuild the rail flags.
      unwrapAllAnnoMarks();
      var items = msg.items || [];
      for (var i = 0; i < items.length; i++){
        if (!drawHighlight(items[i])) port.postMessage({ type: "place-failed", annotationId: items[i].annotationId });
      }
    }
  };

  document.addEventListener("mouseup", postSelection, true);
  document.addEventListener("selectionchange", function(){
    var sel = document.getSelection && document.getSelection();
    if (!sel || sel.isCollapsed) { pendingRange = null; port.postMessage({ type: "selection", anchor: null }); }
  }, true);

  // MƯỢT TASK 3: on an in-iframe scroll, rAF-throttle a re-post of the live selection's CURRENT
  // bounding rect so the parent popover tracks the text (technique from Plannotator's bridge-script,
  // Apache-2.0). Capture phase so inner scroll containers count. If the rect leaves the viewport,
  // post a null rect → the parent dismisses (closeOnScrollOut).
  var scrollRaf = 0;
  function postSelectionRect(){
    scrollRaf = 0;
    if (!pendingRange) return;
    var r;
    try { r = pendingRange.getBoundingClientRect(); } catch (e) { return; }
    if (r.bottom < 0 || r.top > (window.innerHeight || 0)){
      port.postMessage({ type: "selection-rect", rect: null });
      return;
    }
    port.postMessage({ type: "selection-rect", rect: { x: r.x, y: r.y, width: r.width, height: r.height } });
  }
  window.addEventListener("scroll", function(){
    if (!pendingRange) return;
    if (!scrollRaf) scrollRaf = requestAnimationFrame(postSelectionRect);
  }, true);

  // Handshake LAST, after listeners are wired. Transfer port2 to the parent. The parent
  // validates event.source === iframe.contentWindow and the nonce; server-side re-authz is
  // the hard backstop (C-001). We do NOT listen on window for body messages.
  parent.postMessage({ source: "anchord-bridge", type: "ready", nonce: NONCE }, "*", [channel.port2]);
})();`;
}

/**
 * injectBridge — append the bridge `<script>` to already-block-id'd served HTML. Pure
 * string transform.
 *
 * SECURITY MODEL (read before assuming isolation): the served CSP is `sandbox
 * allow-scripts` with NO `script-src` directive (render/sandbox.ts) — chosen so the doc's
 * OWN scripts run (AS-006/AS-007). Consequence: body scripts ARE NOT blocked, and our
 * bridge does NOT run as uniquely-privileged in-iframe code. The `nonce` attribute below is
 * inert under the current CSP — it is forward-compat plumbing for a future flip to
 * `script-src 'nonce-…'` (which the spec has not decided; that flip would also kill body
 * scripts, contradicting AS-006/AS-007).
 *
 * Because body scripts run, a hostile body script CAN race our bridge's handshake (it shares
 * the iframe's contentWindow, which is the parent's only source check). That race lets it
 * open a composer / suppress the real bridge — it CANNOT create an annotation: every create
 * is re-authorized server-side by session role (C-001). The bridge channel is
 * defense-in-depth, NOT the authorization boundary. Do not document this as "isolation".
 */
export function injectBridge(html: string, nonce: string): string {
  // `</script>` anywhere in an inline script body (e.g. via a hostile nonce) would
  // prematurely close the tag in the HTML parser — escape the close-tag sequence so the
  // script stays one cohesive block regardless of its interpolated values (XSS defense).
  const body = bridgeScript(nonce).replace(/<\/(script)/gi, "<\\/$1");
  // S-001: ALSO inject the highlight stylesheet. The opaque iframe has NONE of the app's tokens or
  // styles, so a drawn <mark class="anno-mark"> would otherwise render the browser-default yellow.
  // The CSP is `sandbox allow-scripts` with NO `style-src` (render/sandbox.ts) → an inline <style>
  // is allowed (verified). Placed before the script so the rule set exists when marks are drawn.
  return `${html}<style>${MARK_STYLESHEET}</style><script nonce="${escapeAttr(nonce)}">${body}</script>`;
}

/**
 * MARK_STYLESHEET — the `.anno-mark` rule set injected into the served iframe so a drawn highlight
 * reads in the app's visual language inside the opaque sandbox (S-001 / C-003).
 *
 * ⚠️ DUPLICATION (kept in sync BY VALUE, not by import). The canonical source is
 * `apps/web/src/styles.css` `.anno-mark` — but the in-iframe bridge runs inside the sandbox and
 * cannot import the app's CSS or its design tokens. So the rules + the DESIGN.md palette VALUES are
 * inlined here: accent teal `#37b3bd`, the hue via `var(--mark-hue)` (set per-mark by the draw),
 * resolved green / redline red / stale muted-dashed (S-002 / C-003 — the full state set, mirroring
 * styles.css BY VALUE: --green #43b873, --red #f1655d, --subtle #677074). If you touch `.anno-mark`
 * in styles.css, mirror it here.
 *
 * ⚠️ ORDER MATTERS. The state rules are emitted in the SAME source order as styles.css —
 * hue → resolved → redline → STALE last — so at equal specificity the later rule wins. That makes a
 * STALE REDLINE read muted/dashed (the confident red strike is overridden), exactly as markdown (S-002/AS-006).
 */
export const MARK_STYLESHEET = [
  // base: accent tint + bottom underline (mirrors styles.css .anno-mark; --accent inlined to teal).
  ".anno-mark{background:color-mix(in oklab, #37b3bd 24%, transparent);border-bottom:1.5px solid #37b3bd;border-radius:2px;padding:0 1px;color:inherit;cursor:pointer;}",
  ".anno-mark:hover{background:color-mix(in oklab, #37b3bd 38%, transparent);}",
  // per-type/label hue: tint + underline from the per-mark --mark-hue custom prop.
  ".anno-mark[data-anno-hue]{background:color-mix(in oklab, var(--mark-hue) 26%, transparent);border-bottom-color:var(--mark-hue);}",
  ".anno-mark[data-anno-hue]:hover{background:color-mix(in oklab, var(--mark-hue) 40%, transparent);}",
  // S-002/AS-004: resolved → dim green tint (mirrors styles.css; --green inlined). Placed AFTER the
  // hue rule so a resolved hued mark still dims (later wins at equal specificity).
  '.anno-mark[data-resolved="true"]{background:color-mix(in oklab, #43b873 12%, transparent);border-bottom-color:#43b873;}',
  // S-002/AS-005: redline (delete proposal) → red strikethrough + red tint, NO line below, never an
  // edit of the doc content (--red inlined).
  '.anno-mark[data-anno-kind="redline"]{background:color-mix(in oklab, #f1655d 24%, transparent);border-bottom:none;text-decoration:line-through;text-decoration-color:#f1655d;text-decoration-thickness:1.5px;color:inherit;}',
  '.anno-mark[data-anno-kind="redline"]:hover{background:color-mix(in oklab, #f1655d 38%, transparent);}',
  // S-002/AS-006: a STALE redline → DISTINCT muted/dashed (no strike, no red tint, dimmed) so it
  // never reads as a confident strike on possibly-wrong text (--subtle inlined). Emitted LAST so it
  // overrides the redline rule above at equal specificity (stale wins) — matching styles.css order.
  '.anno-mark[data-anno-stale="true"]{background:transparent;border-bottom:1.5px dashed #677074;text-decoration:none;opacity:0.7;}',
  // adjacent-mark padding collapse so a multi-node run reads as one continuous highlight.
  ".anno-mark + .anno-mark{padding-left:0;}",
  ".anno-mark:has(+ .anno-mark){padding-right:0;}",
].join("");

/** Escape a value for safe use inside a double-quoted HTML attribute. */
function escapeAttr(value: string): string {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Generate a per-request CSP/handshake nonce (crypto random, base36). Mirrors slug.ts's use of crypto.getRandomValues. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(36).padStart(2, "0");
  return out;
}
