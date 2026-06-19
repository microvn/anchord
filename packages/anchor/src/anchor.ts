// Selection→anchor + placement (S-005 / C-008). PURE: only the minimal structural DOM surface from
// types.ts — no React, no app/server imports, no `lib.dom`. The SAME functions type-check
// server-side (happy-dom / jsdom) AND compile to the in-iframe IIFE that runs in the opaque sandbox.

import {
  type Anchor,
  type AnchorSegment,
  type DocumentLike,
  type ElementLike,
  type NodeLike,
  type PlaceResult,
  type SelectionLike,
  type UnwrapDocumentLike,
  type UnwrapNodeLike,
  BLOCK_SELECTOR,
  ELEMENT_NODE,
  TEXT_NODE,
  SNIPPET_CAP,
  CONTEXT_CAP,
} from "./types";
import { locateRange } from "./locate";

// Extra structural members the selection→anchor walk needs (a real browser, happy-dom and jsdom all
// provide them). Kept here so types.ts stays the minimal placement surface; this is the richer walk
// surface. We keep them loose (members we actually touch) so any DOM impl satisfies them.
interface WalkNode extends NodeLike {
  firstChild: WalkNode | null;
  nextSibling: WalkNode | null;
  childNodes: ArrayLike<WalkNode>;
  /** Upper-cased tag name for an element node (`P`, `SCRIPT`, …); present on every DOM node. */
  nodeName: string;
}
interface WalkElement extends ElementLike, WalkNode {
  ownerDocument: WalkDocument;
  contains(other: ElementLike | null): boolean;
}
interface WalkDocument extends DocumentLike {}

/** Element node names whose text content is NOT part of the doc's readable text (C-011). */
const NON_TEXT_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

/**
 * extractText — THE ONE canonical text extractor (C-011). Walks `el`'s descendant text nodes in
 * document order, concatenating their content, but SKIPS the subtrees of script/style/noscript/
 * template (their text is not readable doc text). Comments are NOT text nodes so they never appear.
 * Entities are already decoded (this reads the DOM's `textContent`, not raw markup).
 *
 * This is the same text `selectionToAnchor` / `charOffsetWithin` see (they sum text-node lengths in
 * the same order), so an offset computed at create resolves to the same text at placement — whether
 * the caller is the FE markdown walk, the in-iframe bridge, or the backend re-anchor (which runs it
 * over a happy-dom parse of the new HTML instead of a divergent string-regex strip).
 *
 * NOTE: it does NOT collapse whitespace — that normalization lives in the locate ladder
 * (`normalizeWithMap`), applied to BOTH sides at match time, so the stored offset stays a raw index
 * into this verbatim text.
 */
export function extractText(el: ElementLike): string {
  let out = "";
  for (const t of textNodesOf(el as unknown as WalkNode)) out += t.textContent ?? "";
  return out;
}

/**
 * textNodesOf — every Text descendant of `root` in document order, via MANUAL recursive descent
 * (NOT createTreeWalker, which happy-dom 15 won't descend into nested elements with). Skips the
 * subtrees of script/style/noscript/template (C-011). The single text-node order used by extractText,
 * charToTextPosition, and the bridge's wrap — so an offset is consistent across all of them.
 */
function textNodesOf(root: WalkNode): WalkNode[] {
  const out: WalkNode[] = [];
  const visit = (n: WalkNode): void => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === TEXT_NODE) out.push(c);
      else if (c.nodeType === ELEMENT_NODE && !NON_TEXT_TAGS.has(c.nodeName)) visit(c);
    }
  };
  visit(root);
  return out;
}

/** The block id of an element, or null. injectBlockIds stamps a plain block as `id="block-{tag}-{n}"`
 *  and only falls back to `data-block-id` when the element ALREADY has an author id — so a block is
 *  addressable by EITHER form (a markdown block gets the `id` form). data-block-id wins. */
function blockIdOf(e: ElementLike): string | null {
  // data-block-id wins (the don't-clobber form) and may carry ANY value (a markdown block's author
  // id, or the server `block-…` form). A plain `id` only counts when it's the server `block-…` form
  // (an author's arbitrary `id` is NOT an addressable block).
  const dbi = e.getAttribute("data-block-id");
  if (dbi) return dbi;
  const id = e.getAttribute("id");
  return id && id.startsWith("block-") ? id : null;
}

/** Nearest ancestor element (incl. self) carrying a block id (data-block-id OR id="block-…"). */
function closestBlock(node: NodeLike | null): WalkElement | null {
  let el: NodeLike | null = node;
  while (el) {
    if (el.nodeType === ELEMENT_NODE && blockIdOf(el as ElementLike)) return el as WalkElement;
    el = el.parentNode;
  }
  return null;
}

/**
 * Char offset of (container, containerOffset) within `block`'s concatenated text content. Walks the
 * block's text nodes in document order (TreeWalker SHOW_TEXT), summing lengths until the target is
 * reached. An element-node container (offset = child index) is translated to the text length of the
 * children before that index. Returns the block end if the point isn't found (defensive clamp).
 */
function charOffsetWithin(block: WalkElement, container: NodeLike, containerOffset: number): number {
  if (container.nodeType === ELEMENT_NODE) {
    let acc = 0;
    const kids = (container as WalkNode).childNodes;
    for (let i = 0; i < Math.min(containerOffset, kids.length); i++) acc += (kids[i]!.textContent ?? "").length;
    return offsetOfNode(block, container) + acc;
  }
  return offsetOfNode(block, container) + containerOffset;
}

/** The char offset at which `target`'s text begins within `block`'s concatenated text. */
function offsetOfNode(block: WalkElement, target: NodeLike): number {
  // Manual descent (textNodesOf), NOT createTreeWalker — happy-dom 15's walker won't descend into
  // nested elements, which would mis-sum the offset for a structured block (dl > dt/dd, an AS card).
  let pos = 0;
  for (const node of textNodesOf(block)) {
    if ((node as unknown as NodeLike) === target) return pos;
    // If target is an element ancestor of this text node, the element's start is this text's start.
    if (target.nodeType === ELEMENT_NODE && (target as ElementLike).contains(node as unknown as ElementLike)) return pos;
    pos += (node.textContent ?? "").length;
  }
  return pos;
}

function clampOffset(value: number, max: number): number {
  return Math.max(0, Math.min(value, max));
}

/** The block elements intersected by a cross-block range, in document order, INCLUSIVE of start +
 *  end block. S-006/C-007: the actual START and END blocks are ALWAYS kept (even when they are
 *  containers holding another in-range block) — they carry the real selection endpoints that
 *  resolveAnchorRange resolves the range from, and the dogfood bug was exactly that a container start
 *  block (an AS card whose body also held a Data sub-block) was dropped as a non-leaf, so its own
 *  text went unanchored. Only the STRICTLY-INTERIOR blocks are leaf-filtered (a nested ol > li > p /
 *  table > tr > td carries the same text at each level; keeping only interior leaves avoids
 *  double-counting middle text). */
function blocksBetween(startBlock: WalkElement, endBlock: WalkElement, doc: WalkDocument): WalkElement[] {
  if (startBlock === endBlock) return [startBlock];
  const all = toArray(doc.querySelectorAll(BLOCK_SELECTOR)).filter((e) => blockIdOf(e)) as WalkElement[];
  const si = all.indexOf(startBlock);
  const ei = all.indexOf(endBlock);
  if (si === -1 || ei === -1) return [startBlock, endBlock]; // defensive: endpoints only
  const lo = Math.min(si, ei);
  const hi = Math.max(si, ei);
  const slice = all.slice(lo, hi + 1);
  // Keep both endpoints unconditionally; leaf-filter only the interior blocks.
  return slice.filter((b, idx) => {
    if (idx === 0 || idx === slice.length - 1) return true; // endpoints always kept
    return !slice.some((other) => other !== b && b.contains(other));
  });
}

function toArray<T>(list: ArrayLike<T>): T[] {
  const out: T[] = [];
  for (let i = 0; i < list.length; i++) out.push(list[i]!);
  return out;
}

/**
 * selectionToAnchor — turn a DOM Selection into a stored Anchor. ONE signature `(selection, doc)`,
 * shared by the FE (markdown, app DOM) and the in-iframe bridge.
 *
 * Single-block selection → `{blockId, textSnippet, offset, length, segments:[one]}`.
 * Cross-block selection → the same top-level fields for the START block PLUS `segments[]` (one per
 *   intersected LEAF block — start partial · full middles · end partial).
 * Empty / collapsed / whitespace-only selection, or a start outside any block → null.
 *
 * The snippet is a verbatim slice of the block's textContent (NOT selection.toString(), whose
 * cross-element \t/\n separators would never re-locate via locateRange).
 */
export function selectionToAnchor(selection: SelectionLike | null, doc: DocumentLike): Anchor | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  if (selection.toString().trim().length === 0) return null; // covers no-real-chars / whitespace-only

  const wdoc = doc as unknown as WalkDocument;
  const range = selection.getRangeAt(0);
  const startBlock = closestBlock(range.startContainer);
  if (!startBlock) return null; // start isn't inside any addressable block → no anchor
  const endBlock = closestBlock(range.endContainer) ?? startBlock;

  // Single block (start === end, or the end fell outside any block): one segment.
  if (endBlock === startBlock) {
    const blockText = startBlock.textContent ?? "";
    const startOff = clampOffset(charOffsetWithin(startBlock, range.startContainer, range.startOffset), blockText.length);
    const endOff = clampOffset(charOffsetWithin(startBlock, range.endContainer, range.endOffset), blockText.length);
    const lo = Math.min(startOff, endOff);
    const hi = Math.max(startOff, endOff);
    const textSnippet = blockText.slice(lo, hi).slice(0, SNIPPET_CAP);
    if (textSnippet.trim().length === 0) return null;
    const blockId = blockIdOf(startBlock)!;
    // C-004: capture ≤CONTEXT_CAP chars of block text on each side of the selection (W3C
    // TextQuoteSelector). The selection slice is [lo, lo+length) in the block text.
    const prefix = blockText.slice(Math.max(0, lo - CONTEXT_CAP), lo);
    const suffix = blockText.slice(lo + textSnippet.length, lo + textSnippet.length + CONTEXT_CAP);
    return {
      blockId,
      textSnippet,
      offset: lo,
      length: textSnippet.length,
      prefix,
      suffix,
      segments: [{ blockId, offset: lo, length: textSnippet.length, textSnippet, prefix, suffix }],
    };
  }

  // Cross-block: one segment per intersected LEAF block — start partial, full middles, end partial.
  const blocks = blocksBetween(startBlock, endBlock, wdoc);
  const segments: AnchorSegment[] = blocks.map((block) => {
    const blockId = blockIdOf(block)!;
    const blockText = block.textContent ?? "";
    let offset = 0;
    let slice = blockText;
    if (block === startBlock) {
      offset = clampOffset(charOffsetWithin(block, range.startContainer, range.startOffset), blockText.length);
      slice = blockText.slice(offset);
    } else if (block === endBlock) {
      const end = clampOffset(charOffsetWithin(block, range.endContainer, range.endOffset), blockText.length);
      slice = blockText.slice(0, end);
    }
    const textSnippet = slice.slice(0, SNIPPET_CAP);
    // C-004: per-segment context from its own block text, around this segment's span.
    const prefix = blockText.slice(Math.max(0, offset - CONTEXT_CAP), offset);
    const suffix = blockText.slice(offset + textSnippet.length, offset + textSnippet.length + CONTEXT_CAP);
    return { blockId, offset, length: textSnippet.length, textSnippet, prefix, suffix };
  });

  const first = segments[0]!;
  return {
    blockId: first.blockId,
    textSnippet: first.textSnippet,
    offset: first.offset,
    length: first.length,
    prefix: first.prefix,
    suffix: first.suffix,
    segments,
  };
}

function cssEscape(id: string): string {
  return id.replace(/["\\\]\[#.:>+~*^$=()| ]/g, "\\$&");
}

function findBlock(blockId: string, doc: DocumentLike): ElementLike | null {
  return (
    doc.querySelector(`[data-block-id="${cssEscape(blockId)}"]`) ??
    doc.querySelector(`#${cssEscape(blockId)}`)
  );
}

/**
 * placeAnchor — locate an anchor's text within its block in the CURRENT content using the unified
 * C-008 locate ladder (exact → nearest → normalized → fuzzy → not-found). NEVER throws: a missing
 * block / vanished snippet / below-threshold fuzzy all return an `{ok:false}` sentinel so the caller
 * (the iframe bridge especially) degrades into couldn't-place rather than crashing. Computes WHERE;
 * the caller wraps the range in a `<mark data-anno=…>`.
 */
export function placeAnchor(anchor: Anchor, doc: DocumentLike): PlaceResult {
  const el = findBlock(anchor.blockId, doc);
  if (!el) return { ok: false, reason: "no-block" };
  const text = el.textContent ?? "";
  if (anchor.textSnippet.length === 0) return { ok: false, reason: "not-found" };
  const range = locateRange(text, anchor.textSnippet, anchor.offset);
  if (!range) return { ok: false, reason: "not-found" };
  return { ok: true, blockId: anchor.blockId, start: range.start, end: range.end, text: text.slice(range.start, range.end) };
}

/**
 * placeAnchorAll — place EVERY block an anchor spans, one PlaceResult per segment. A multi_range
 * anchor carries `segments[]` (one per intersected block); a single range has none (place the
 * primary). Never throws — each segment degrades to its own `{ok:false}` sentinel.
 */
export function placeAnchorAll(anchor: Anchor, doc: DocumentLike): PlaceResult[] {
  const segs =
    anchor.segments && anchor.segments.length > 1
      ? anchor.segments
      : [{ blockId: anchor.blockId, textSnippet: anchor.textSnippet, offset: anchor.offset, length: anchor.length }];
  return segs.map((seg) => placeAnchor(seg as Anchor, doc));
}

/** A resolved DOM start/end position pair — the input a Range needs (`setStart`/`setEnd`). */
export interface ResolvedRange {
  startNode: NodeLike;
  startOffset: number;
  endNode: NodeLike;
  endOffset: number;
}

/**
 * Map a char offset within `block`'s text to a (text node, offset-in-node) position. Walks the
 * block's text nodes in document order (the SAME order extractText / charOffsetWithin use), summing
 * lengths until the target char falls inside a node. Clamps to the last text node's end when the
 * offset is past the text (defensive). Returns null only when the block has no text node at all.
 */
function charToTextPosition(block: WalkElement, charOffset: number): { node: NodeLike; offset: number } | null {
  // Manual recursive descent, NOT createTreeWalker(SHOW_TEXT): happy-dom 15's TreeWalker does not
  // descend into nested elements, so a structured block (dl > dt/dd, an AS card) would yield NO text
  // nodes and orphan the range. The manual walk mirrors the markdown engine's textNodesOf — it also
  // excludes script/style/noscript/template subtrees (C-011, same as extractText).
  const nodes = textNodesOf(block);
  let pos = 0;
  let last: WalkNode | null = null;
  for (const node of nodes) {
    const len = (node.textContent ?? "").length;
    // `<=` so an offset landing exactly at a node boundary binds to the END of this node (not the
    // start of the next) — important for an end position so the range includes this node's slice.
    if (charOffset <= pos + len) {
      return { node: node as unknown as NodeLike, offset: Math.max(0, charOffset - pos) };
    }
    pos += len;
    last = node;
  }
  if (last) return { node: last as unknown as NodeLike, offset: (last.textContent ?? "").length };
  return null;
}

/**
 * resolveAnchorRange — S-006/C-007: resolve a (single- or cross-block) anchor to ONE DOM range
 * descriptor. The START comes from the FIRST segment (its snippet located in its block via the
 * unified locate ladder → start char → text node + offset); the END from the LAST segment (snippet
 * located → end char → text node + offset). The in-iframe bridge then builds a real Range from this
 * and wraps EVERY text node the range intersects (range-driven fan-out), so container text living
 * BETWEEN leaf blocks — which the old per-segment placement dropped — is covered too.
 *
 * For a single-block anchor (no segments / one segment), start and end land in the same block — the
 * range is the located snippet, identical to the prior single-block behaviour. Returns null when
 * either endpoint's block is missing or its snippet can't be located (→ couldn't-place; the bridge
 * relays place-failed and the iframe does not crash). NEVER throws.
 */
export function resolveAnchorRange(anchor: Anchor, doc: DocumentLike): ResolvedRange | null {
  const segs =
    anchor.segments && anchor.segments.length > 0
      ? anchor.segments
      : [{ blockId: anchor.blockId, textSnippet: anchor.textSnippet, offset: anchor.offset, length: anchor.length }];
  const first = segs[0]!;
  const last = segs[segs.length - 1]!;

  const firstPlaced = placeAnchor(first as Anchor, doc);
  if (!firstPlaced.ok) return null;
  const lastPlaced = placeAnchor(last as Anchor, doc);
  if (!lastPlaced.ok) return null;

  const startBlock = findBlock(firstPlaced.blockId, doc) as WalkElement | null;
  const endBlock = findBlock(lastPlaced.blockId, doc) as WalkElement | null;
  if (!startBlock || !endBlock) return null;

  const start = charToTextPosition(startBlock, firstPlaced.start);
  const end = charToTextPosition(endBlock, lastPlaced.end);
  if (!start || !end) return null;

  return { startNode: start.node, startOffset: start.offset, endNode: end.node, endOffset: end.offset };
}

/**
 * unwrapAnnoMarks — remove EVERY `mark[data-anno]`, moving each mark's children out before it, then
 * `.normalize()` the parent so split text nodes re-merge. The "clear" half of the idempotent
 * clear-then-redraw sync. A non-anno `<mark>` is left untouched. No-op + never throws when there are
 * no anno marks.
 */
export function unwrapAnnoMarks(doc: UnwrapDocumentLike): void {
  const marks = toArray(doc.querySelectorAll("mark[data-anno]"));
  for (const mark of marks) {
    const parent = (mark as UnwrapNodeLike).parentNode;
    if (!parent) continue;
    while ((mark as UnwrapNodeLike).firstChild) parent.insertBefore((mark as UnwrapNodeLike).firstChild!, mark as UnwrapNodeLike);
    parent.removeChild(mark as UnwrapNodeLike);
    parent.normalize();
  }
}

export { TEXT_NODE };
