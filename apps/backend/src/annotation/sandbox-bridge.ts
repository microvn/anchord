// In-iframe sandbox bridge (annotation-core S-001 + GAP-004, hardened by C-009/C-002/C-001).
//
// WHAT THIS IS. The /v/:id route serves untrusted, AI-generated HTML inside an iframe
// that runs scripts on an OPAQUE origin (`sandbox allow-scripts`, no allow-same-origin —
// see render/sandbox.ts). The FE viewer cannot reach into that iframe (cross-origin), so
// to turn a user's in-iframe text selection into an annotation anchor we inject a tiny
// bridge script that runs INSIDE the sandbox and talks to the parent over a dedicated
// MessageChannel. This module owns (a) re-exporting the pure anchor walk/placement logic
// (now sourced from @anchord/anchor — S-005) and (b) the bridge script string + its
// injection into the served HTML.
//
// S-005 — ANCHOR LOGIC IS NO LONGER HAND-MIRRORED. The selection→anchor + the locate ladder
// (exact → nearest → whitespace-normalized → fuzzy) live in ONE pure module, `@anchord/anchor`.
// This file imports it server-side AND inlines its browser-IIFE compile (ANCHOR_IIFE, generated
// from packages/anchor/src/iife-entry.ts → window.__anchordAnchor) into the bridge script. So the
// in-iframe matcher and the FE markdown matcher are the SAME ladder (C-008) — the iframe gained the
// markdown path's whitespace-normalize + fuzzy tiers, closing GAP-005. The bridge GLUE (MessageChannel
// handshake, wrapTextRange DOM mutation, drawHighlight, focusAnno, mark-click relay, MARK_STYLESHEET,
// the S-007 storage shim) stays here.
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

import { ANCHOR_IIFE } from "./anchor-iife.generated";

// S-005: re-export the canonical anchor surface from the shared module so existing backend importers
// (and tests) keep importing it from here, while the SINGLE implementation lives in @anchord/anchor.
export {
  selectionToAnchor,
  placeAnchor,
  placeAnchorAll,
  unwrapAnnoMarks,
  SNIPPET_CAP,
  BLOCK_SELECTOR,
} from "@anchord/anchor";
export type { PlaceResult } from "@anchord/anchor";

// --- The bridge script (string injected into the served iframe HTML) ---

/**
 * bridgeScript — the IIFE injected into the sandboxed iframe. It is a STRING because it runs inside
 * the browser sandbox, not on the server. It is built in TWO parts:
 *   1. ANCHOR_IIFE — the browser-IIFE compile of the shared @anchord/anchor module, defining
 *      `window.__anchordAnchor = { selectionToAnchor, placeAnchorAll, unwrapAnnoMarks, BLOCK_SELECTOR }`.
 *      This is the SAME locate ladder the FE markdown path uses (S-005 / C-008) — no hand-mirrored
 *      drift, and the iframe gains the whitespace-normalize + fuzzy tiers (closes GAP-005).
 *   2. the bridge GLUE below — the transport (MessageChannel handshake), the DOM-mutation wrap
 *      (wrapTextRange, which uses real-browser Range/surroundContents and so cannot be pure), the
 *      draw (drawHighlight applying the app class + hue + lifecycle state), focusAnno, the mark-click
 *      relay, and the selection/scroll posting — all of which CALL the anchor namespace from part 1.
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
  // Part 1: the shared anchor module, compiled to a browser IIFE (defines window.__anchordAnchor).
  // Part 2: the bridge glue, which reads selectionToAnchor / placeAnchorAll / unwrapAnnoMarks /
  // BLOCK_SELECTOR off that namespace. Both are in the SAME injected <script>.
  return `${ANCHOR_IIFE}
(function(){
  "use strict";
  var A = window.__anchordAnchor;
  var BLOCK_SELECTOR = A.BLOCK_SELECTOR;
  var NONCE = ${nonceLiteral};

  // --- placement (highlight): RANGE-DRIVEN (S-006 / C-007) ---
  // Every Text descendant of root in document order, via MANUAL recursive descent (NOT
  // createTreeWalker, which happy-dom 15 won't descend into nested elements with — the shared module
  // walks the same way, so offsets stay consistent). Skips script/style/noscript/template subtrees.
  function textNodesOf(root){
    var out = [];
    function visit(n){
      for (var c = n.firstChild; c; c = c.nextSibling){
        if (c.nodeType === 3) out.push(c);
        else if (c.nodeType === 1 && !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(c.nodeName)) visit(c);
      }
    }
    visit(root);
    return out;
  }
  // S-006/C-007: draw ONE highlight range-driven. The shared resolveAnchorRange resolves the anchor to
  // a single DOM range (start node+offset → end node+offset) using the unified C-008 ladder; we then
  // wrap EVERY text node that range intersects in its OWN <mark> — including container text that lives
  // BETWEEN leaf blocks (the AS-001/AS-002 grid-text miss the old per-leaf-segment draw dropped).
  // Wrapping is REVERSE document order so splitting an earlier node never invalidates later refs, and
  // a whitespace-only slice is SKIPPED so a <mark> never becomes a stray grid/flex item (AS-018).
  // Returns the created <mark>s (>=1) or null when the range can't be resolved (→ couldn't-place).
  function drawRange(anchor, id){
    var r = A.resolveAnchorRange(anchor, document);
    if (!r) return null;
    // Collect every text node in document order; keep those between startNode and endNode inclusive.
    var all = textNodesOf(document.body || document.documentElement || document);
    var si = all.indexOf(r.startNode), ei = all.indexOf(r.endNode);
    if (si === -1 || ei === -1) return null;
    if (si > ei){ var t = si; si = ei; ei = t; }
    var inRange = all.slice(si, ei + 1);
    var marks = [];
    // REVERSE order: replacing an earlier text node would invalidate later node refs otherwise.
    for (var i = inRange.length - 1; i >= 0; i--){
      var node = inRange[i];
      var s = node === r.startNode ? r.startOffset : 0;
      var e = node === r.endNode ? r.endOffset : node.textContent.length;
      if (e <= s) continue;
      // Skip a whitespace-only slice (the newline+indent node BETWEEN a grid/list's children) so its
      // <mark> never becomes a stray grid item that shatters the layout (AS-018).
      if (node.textContent.slice(s, e).trim().length === 0) continue;
      var rr = document.createRange();
      rr.setStart(node, s);
      rr.setEnd(node, e);
      var mark = document.createElement("mark");
      // Stamp the id up front so the extracted draw is self-contained (drawHighlight then layers on
      // class/hue/state). data-anno is what unwrapAllAnnoMarks + focusAnno + the mark-click relay key on.
      mark.setAttribute("data-anno", String(id));
      try { rr.surroundContents(mark); marks.unshift(mark); } catch (e2) {}
    }
    return marks.length ? marks : null;
  }
  // Wrap [start,end) chars of a SINGLE element's text in <mark>s — ONE per intersected text node.
  // Retained for the within-one-block path / regression coverage; the cross-block draw is drawRange.
  // A range that spans multiple text nodes (text broken by <br>/inline tags) CANNOT use
  // Range.surroundContents on the whole range (it THROWS when partially selecting a non-Text node), so
  // we slice PER text node and surround each slice on its own. Skips a whitespace-only slice (AS-018).
  function wrapTextRange(el, start, end){
    var nodes = textNodesOf(el);
    var pos = 0, segs = [];
    for (var k = 0; k < nodes.length; k++){
      var n = nodes[k];
      var len = n.textContent.length;
      var ns = pos, ne = pos + len;
      if (ne > start && ns < end){
        var s = start > ns ? start - ns : 0;
        var e = end < ne ? end - ns : len;
        if (e > s && n.textContent.slice(s, e).trim().length > 0) segs.push({ node: n, s: s, e: e });
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
    var anchor = A.selectionToAnchor(sel, document);
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
  // clear-then-redraw sync. Delegates to the shared unwrapAnnoMarks (mirrors the FE engine).
  function unwrapAllAnnoMarks(){
    A.unwrapAnnoMarks(document);
  }

  // S-001/S-003: draw ONE highlight from a {anchor, annotationId, hue?} item. Returns true if it
  // placed (>=1 mark), false on a placement miss (the caller relays place-failed). Reused by both
  // the single {highlight} handler (back-compat) and the batch {highlights} redraw.
  function drawHighlight(item){
    var marks = drawRange(item.anchor, item.annotationId);
    if (!marks || !marks.length) return false;
    for (var mi = 0; mi < marks.length; mi++){
      var mk = marks[mi];
      // data-anno is already set by drawRange; (re)assert defensively + layer on class/hue/state.
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
      // S-007 (C-009): a filtered mark (its status chip toggled off) is DIMMED — the SAME hook the
      // markdown engine sets (data-anno-filtered). The stylesheet's filtered rule sits LAST so it
      // wins the visual weight over the type/lifecycle styles until the chip is re-activated (AS-023).
      if (item.filtered) mk.setAttribute("data-anno-filtered", "true");
    }
    return true;
  }

  // S-004 (C-005): emphasise the marks for one annotation id (toggle .anno-mark--focus on the
  // matching marks, clear it from the rest) and scroll the FIRST matching mark into view. Mirrors the
  // markdown engine's focus-class sync + scrollToAnno. A null id just clears all emphasis. The parent
  // can't reach the opaque iframe DOM, so this runs in-iframe on a {type:"focus"} port message (C-001).
  function focusAnno(annotationId){
    var marks = document.querySelectorAll("mark[data-anno]");
    var first = null;
    for (var i = 0; i < marks.length; i++){
      var mk = marks[i];
      var match = annotationId != null && mk.getAttribute("data-anno") === String(annotationId);
      if (mk.classList){
        if (match) mk.classList.add("anno-mark--focus"); else mk.classList.remove("anno-mark--focus");
      }
      if (match && !first) first = mk;
    }
    if (first && first.scrollIntoView){
      try { first.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) {}
    }
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
    } else if (msg.type === "focus"){
      // S-004/AS-012 (C-005): the parent focused a rail thread → emphasise + scroll to its mark.
      focusAnno(msg.annotationId);
    }
  };

  // S-004/AS-011 (C-005): a click on a [data-anno] mark relays its id UP the trusted port so the
  // parent focuses the rail thread (the parent can't read this opaque iframe's DOM — C-001). Capture
  // phase + closest() so a click on inner content of a mark still resolves the mark.
  document.addEventListener("click", function(e){
    var t = e.target;
    var mk = t && t.closest ? t.closest("mark[data-anno]") : null;
    if (mk){
      var id = mk.getAttribute("data-anno");
      if (id) port.postMessage({ type: "mark-click", annotationId: id });
    }
  }, true);

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
 * STORAGE_SHIM — render-publish S-007 / C-010. The doc's OWN scripts run on the opaque sandbox
 * origin, where `localStorage` / `sessionStorage` / `caches` / `BroadcastChannel` THROW SecurityError
 * on access. A theme-toggle that reads a saved preference on load thus crashes at its first storage
 * read and aborts (the toggle dies). This shim replaces the THROWING capabilities with harmless,
 * in-memory, per-frame stubs so the doc's scripts run.
 *
 * SECURITY (C-010): the store is a `Map` scoped to THIS frame's realm — values do not persist across
 * a reload and are NEVER bridged to or readable at the app origin or any other doc. It grants a
 * (possibly hostile) doc NOTHING it didn't already have (it can already run arbitrary JS + make its
 * own objects in the isolated realm). It does NOT touch the iframe sandbox attribute or the response
 * CSP — the opaque origin (no `allow-same-origin`) stays the isolation boundary. NEVER bridge this to
 * the app's real `localStorage` (that would be an unbounded app-origin write + a cross-doc channel).
 *
 * SHAPE: a `Proxy` over the Map (not a plain object) so `localStorage['k']`, `localStorage.k = v`, and
 * `'k' in localStorage` route to the store like the real `Storage` exotic object. Each `defineProperty`
 * is wrapped in its own try/catch (a non-configurable `window.localStorage` on some engines would
 * otherwise throw and abort the whole shim), and each stub installs only when the real capability
 * actually throws (so a normal origin is untouched).
 *
 * NOT stubbed: `indexedDB`. A half-stub (`open()` returning `{onsuccess:null}`) silently never fires
 * its callback and throws under the common `idb` wrapper libs — worse than letting it throw. A doc
 * using IndexedDB degrades on its own (render-publish AS-026) without taking down the shimmed set.
 *
 * STATIC: this body has no interpolation — no doc-derived content, no XSS surface.
 */
export const STORAGE_SHIM = `(function(){
  "use strict";
  function memStorage(){
    var m = new Map();
    var api = {
      getItem: function(k){ k = String(k); return m.has(k) ? m.get(k) : null; },
      setItem: function(k, v){ m.set(String(k), String(v)); },
      removeItem: function(k){ m.delete(String(k)); },
      clear: function(){ m.clear(); },
      key: function(i){ var ks = Array.from(m.keys()); return (i >= 0 && i < ks.length) ? ks[i] : null; }
    };
    return new Proxy(api, {
      get: function(t, p){
        if (p === "length") return m.size;
        if (p in t) return t[p];
        if (typeof p === "symbol") return undefined;
        var k = String(p); return m.has(k) ? m.get(k) : undefined;
      },
      set: function(t, p, v){ if (p in t) return false; m.set(String(p), String(v)); return true; },
      has: function(t, p){ return (p in t) || m.has(String(p)); },
      deleteProperty: function(t, p){ m.delete(String(p)); return true; },
      ownKeys: function(){ return Array.from(m.keys()); },
      getOwnPropertyDescriptor: function(t, p){
        if (m.has(String(p))) return { value: m.get(String(p)), writable: true, enumerable: true, configurable: true };
        return undefined;
      }
    });
  }
  function def(name, value){
    try { Object.defineProperty(window, name, { value: value, writable: true, configurable: true }); } catch (e) {}
  }
  // per-document + per-session storage — install only when the real API throws (opaque origin).
  try { window.localStorage.getItem("__anchord_probe"); } catch (e) { def("localStorage", memStorage()); }
  try { window.sessionStorage.getItem("__anchord_probe"); } catch (e) { def("sessionStorage", memStorage()); }
  // the cache store — a benign no-op (every method resolves to empty), only if access throws.
  try { void window.caches; } catch (e) {
    function emptyCache(){
      return {
        match: function(){ return Promise.resolve(undefined); },
        add: function(){ return Promise.resolve(); },
        addAll: function(){ return Promise.resolve(); },
        put: function(){ return Promise.resolve(); },
        delete: function(){ return Promise.resolve(false); },
        keys: function(){ return Promise.resolve([]); }
      };
    }
    def("caches", {
      open: function(){ return Promise.resolve(emptyCache()); },
      match: function(){ return Promise.resolve(undefined); },
      has: function(){ return Promise.resolve(false); },
      delete: function(){ return Promise.resolve(false); },
      keys: function(){ return Promise.resolve([]); }
    });
  }
  // the cross-tab channel — a no-op class, only if the real constructor throws.
  try { var __probeBC = new BroadcastChannel("__anchord_probe"); __probeBC.close(); } catch (e) {
    function FakeBroadcastChannel(name){ this.name = String(name); this.onmessage = null; this.onmessageerror = null; }
    FakeBroadcastChannel.prototype.postMessage = function(){};
    FakeBroadcastChannel.prototype.close = function(){};
    FakeBroadcastChannel.prototype.addEventListener = function(){};
    FakeBroadcastChannel.prototype.removeEventListener = function(){};
    FakeBroadcastChannel.prototype.dispatchEvent = function(){ return false; };
    def("BroadcastChannel", FakeBroadcastChannel);
  }
})();`;

/**
 * injectStorageShim — render-publish S-007. PREPEND the storage shim so it runs BEFORE the doc's own
 * scripts (unlike `injectBridge`, which APPENDS the bridge after </body> — too late, a head/early
 * body script would already have crashed). Insertion point, in order of preference: just after the
 * first `<head…>` open tag → before the first `<script` → after the first `<body…>` / `<html…>` open
 * → else the very start of the string. Best-effort on malformed input (mirrors injectBlockIds AS-022).
 *
 * The shim carries a `nonce` attribute like the bridge — inert under the current `sandbox allow-scripts`
 * CSP, but load-bearing if a future spec flips to `script-src 'nonce-…'` (render/sandbox.ts note).
 */
export function injectStorageShim(html: string, nonce: string): string {
  const body = STORAGE_SHIM.replace(/<\/(script)/gi, "<\\/$1");
  const tag = `<script nonce="${escapeAttr(nonce)}">${body}</script>`;
  const insertAfter = (re: RegExp): string | null => {
    const m = re.exec(html);
    if (!m) return null;
    const at = m.index + m[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  };
  // after <head> open — earliest point that still precedes head scripts.
  const afterHead = insertAfter(/<head[^>]*>/i);
  if (afterHead) return afterHead;
  // else immediately before the doc's first <script> so the shim runs first.
  const firstScript = /<script[\s/>]/i.exec(html);
  if (firstScript) return html.slice(0, firstScript.index) + tag + html.slice(firstScript.index);
  // else after <body>/<html> open, else prepend to the raw string.
  return insertAfter(/<body[^>]*>/i) ?? insertAfter(/<html[^>]*>/i) ?? tag + html;
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
  // S-004/C-005: hover AND the focused mark share the stronger accent tint (mirrors styles.css's
  // `.anno-mark:hover, .anno-mark--focus`). Emphasis from the parent's thread-focus (postFocus → the
  // in-iframe focusAnno toggling .anno-mark--focus) thus reads the same as the markdown focus.
  ".anno-mark:hover,.anno-mark--focus{background:color-mix(in oklab, #37b3bd 38%, transparent);}",
  // per-type/label hue: tint + underline from the per-mark --mark-hue custom prop.
  ".anno-mark[data-anno-hue]{background:color-mix(in oklab, var(--mark-hue) 26%, transparent);border-bottom-color:var(--mark-hue);}",
  ".anno-mark[data-anno-hue]:hover,.anno-mark[data-anno-hue].anno-mark--focus{background:color-mix(in oklab, var(--mark-hue) 40%, transparent);}",
  // S-002/AS-004: resolved → dim green tint (mirrors styles.css; --green inlined). Placed AFTER the
  // hue rule so a resolved hued mark still dims (later wins at equal specificity).
  '.anno-mark[data-resolved="true"]{background:color-mix(in oklab, #43b873 12%, transparent);border-bottom-color:#43b873;}',
  // S-002/AS-005: redline (delete proposal) → red strikethrough + red tint, NO line below, never an
  // edit of the doc content (--red inlined).
  '.anno-mark[data-anno-kind="redline"]{background:color-mix(in oklab, #f1655d 24%, transparent);border-bottom:none;text-decoration:line-through;text-decoration-color:#f1655d;text-decoration-thickness:1.5px;color:inherit;}',
  '.anno-mark[data-anno-kind="redline"]:hover,.anno-mark[data-anno-kind="redline"].anno-mark--focus{background:color-mix(in oklab, #f1655d 38%, transparent);}',
  // S-002/AS-006: a STALE redline → DISTINCT muted/dashed (no strike, no red tint, dimmed) so it
  // never reads as a confident strike on possibly-wrong text (--subtle inlined). Emitted LAST so it
  // overrides the redline rule above at equal specificity (stale wins) — matching styles.css order.
  '.anno-mark[data-anno-stale="true"]{background:transparent;border-bottom:1.5px dashed #677074;text-decoration:none;opacity:0.7;}',
  // S-007/C-009: a FILTERED mark (its status chip toggled off) → dimmed/de-emphasized. Emitted LAST
  // so it overrides the type/lifecycle styles at equal specificity until the chip is re-activated
  // (mirrors styles.css .anno-mark[data-anno-filtered]).
  '.anno-mark[data-anno-filtered="true"]{background:color-mix(in oklab, currentColor 6%, transparent);border-bottom-color:transparent;text-decoration-color:transparent;opacity:0.4;}',
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
