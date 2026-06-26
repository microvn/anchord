import { test, expect } from "bun:test";
import { Window } from "happy-dom";
import {
  placeAnchorAll,
  bridgeScript,
  injectBridge,
  injectStorageShim,
  STORAGE_SHIM,
  generateNonce,
  unwrapAnnoMarks,
  BLOCK_SELECTOR,
  MARK_STYLESHEET,
} from "./sandbox-bridge";
import { injectBlockIds } from "./block-id";
import { CONTENT_SECURITY_POLICY } from "../render/sandbox";
import { selectionToAnchor, resolveAnchorRange } from "@anchord/anchor";

// annotation-core S-001 / GAP-004 / S-005 — the in-iframe sandbox bridge (C-009/C-002/C-001/C-008).
//
// S-005: the PURE anchor walk/placement logic (selectionToAnchor / placeAnchor / placeAnchorAll /
// unwrapAnnoMarks + the unified locate ladder) now lives in @anchord/anchor — its canonical unit
// tests live in packages/anchor/src/anchor.test.ts. This file keeps only:
//   - the bridge-SERVE assertions (the injected script string + CSP-nonce contract + the compiled
//     anchor IIFE namespace it relies on),
//   - the MARK_STYLESHEET (S-001/S-002/S-004 appearance) assertions,
//   - the storage-shim (render-publish S-007 / C-010) assertions.
// A couple of placement smoke checks remain to prove the re-export from sandbox-bridge is the SAME
// shared implementation (C-009: behaviour-preserving).

function dom(body: string) {
  const win = new Window();
  win.document.body.innerHTML = body;
  return { doc: win.document as unknown as any, win };
}

// ---------------------------------------------------------------------------
// re-export smoke — sandbox-bridge re-exports the shared anchor surface (S-005 / C-009).
// ---------------------------------------------------------------------------

test("S-005: placeAnchorAll re-exported from sandbox-bridge places a single-block anchor (shared impl)", () => {
  const { doc } = dom('<p id="block-p-1">Payment expires after 24h</p>');
  const placed = placeAnchorAll({ blockId: "block-p-1", textSnippet: "expires", offset: 8, length: 7 }, doc);
  expect(placed.length).toBe(1);
  expect(placed[0]!.ok).toBe(true);
});

test("C-002: unwrapAnnoMarks re-exported from sandbox-bridge removes every mark[data-anno]", () => {
  const { doc } = dom(
    '<p id="block-p-1">Payment <mark data-anno="a-1" class="anno-mark">expires</mark> after total</p>',
  );
  unwrapAnnoMarks(doc as any);
  const p = (doc as any).querySelector("p");
  expect(p.querySelectorAll("mark[data-anno]").length).toBe(0);
  expect(p.textContent).toBe("Payment expires after total");
});

test("bridge-serve: BLOCK_SELECTOR matches both block-id attribute forms", () => {
  expect(BLOCK_SELECTOR).toContain("data-block-id");
  expect(BLOCK_SELECTOR).toContain('id^="block-"');
});

// ---------------------------------------------------------------------------
// S-005 — the bridge inlines the compiled @anchord/anchor IIFE + calls it (C-008).
// ---------------------------------------------------------------------------

test("C-008: bridgeScript inlines the shared anchor IIFE (__anchordAnchor) and the glue calls it", () => {
  const script = bridgeScript("n-iife");
  // The compiled @anchord/anchor module defines the namespace the glue reads from.
  expect(script).toContain("__anchordAnchor");
  // The glue sources the anchor + placement from the namespace — NOT a hand-mirrored copy. S-006/
  // C-007: the cross-block draw is now range-driven, so the glue calls A.resolveAnchorRange (the
  // per-leaf A.placeAnchorAll call is superseded — placeAnchorAll stays exported for re-use/tests).
  expect(script).toContain("A.selectionToAnchor");
  expect(script).toContain("A.resolveAnchorRange");
  expect(script).toContain("A.unwrapAnnoMarks");
  // The hand-mirrored anchor functions are GONE (one source now): no inline placeSegment/offsetInBlock.
  expect(script).not.toContain("function placeSegment");
  expect(script).not.toContain("function offsetInBlock");
  expect(script).not.toContain("function enclosingBlock");
});

// ---------------------------------------------------------------------------
// bridge-serve — script contents, single-injection, block-ids preserved, CSP nonce.
// ---------------------------------------------------------------------------

test("bridge-serve: bridgeScript embeds the nonce and the anchord-bridge/ready handshake", () => {
  const script = bridgeScript("test-nonce-abc");
  expect(script).toContain('"test-nonce-abc"'); // nonce baked in as a JSON literal
  expect(script).toContain("anchord-bridge");
  expect(script).toContain('type: "ready"');
  expect(script).toContain("MessageChannel");
  // It must NOT add a window-message listener that relays body messages (C-009/AS-020).
  expect(script).not.toContain("window.addEventListener(\"message\"");
  expect(script).not.toContain("onmessage = function(ev){ parent");
});

test("bridge-serve: the bridge transfers a port and posts selection/place-failed over it", () => {
  const script = bridgeScript("n1");
  expect(script).toContain("channel.port2"); // port2 transferred up in the ready message
  expect(script).toContain('type: "selection"');
  expect(script).toContain('type: "place-failed"');
  expect(script).toContain('"highlight"'); // receives highlight over port1
});

test("bridge-serve: the bridge re-posts a selection-rect on scroll, rAF-throttled (MƯỢT TASK 3)", () => {
  const script = bridgeScript("n2");
  expect(script).toContain('type: "selection-rect"');
  expect(script).toContain("requestAnimationFrame(postSelectionRect)");
  expect(script).toContain('addEventListener("scroll"');
  expect(script).toContain("pendingRange");
});

test("bridge-serve: injectBridge appends exactly ONE script and preserves block-ids", () => {
  const served = injectBlockIds("<h1>Title</h1><p>Body text here</p>");
  const out = injectBridge(served, "nonce-xyz");
  expect(out).toContain('<h1 id="block-h1-1">');
  expect(out).toContain('<p id="block-p-1">Body text here');
  // Exactly one <script> appended.
  const scriptOpens = out.match(/<script\b/g) ?? [];
  expect(scriptOpens.length).toBe(1);
  expect(out).toContain('<script nonce="nonce-xyz">');
  expect(out.indexOf("<script")).toBeGreaterThan(out.indexOf("block-p-1"));
});

test("bridge-serve: injectBridge neutralizes a hostile nonce in BOTH the attribute and script body", () => {
  const out = injectBridge("<p>x</p>", '"><script>alert(1)</script>');
  expect(out).toContain("&quot;&gt;");
  expect(out).not.toContain('nonce=""><script>');
  expect(out).not.toContain("alert(1)</script>");
  expect(out).toContain("alert(1)<\\/script>");
  const closes = out.match(/<\/script>/gi) ?? [];
  expect(closes.length).toBe(1);
});

test("AS-001: injectBridge injects the .anno-mark highlight stylesheet so a drawn mark is not browser-yellow", () => {
  const out = injectBridge(injectBlockIds("<p>Body text here</p>"), "nonce-css");
  expect(out).toContain("<style>");
  expect(out).toContain(".anno-mark");
  expect(out).toContain("#37b3bd");
  expect(out).toContain(".anno-mark[data-anno-hue]");
  expect(out).toContain("var(--mark-hue)");
  expect(out.indexOf("<style>")).toBeLessThan(out.indexOf("<script"));
});

test("AS-002: the in-iframe draw applies class=anno-mark + the hue (data-anno-hue + --mark-hue) on a highlight", () => {
  const script = bridgeScript("n-hue");
  expect(script).toContain('setAttribute("class", "anno-mark")');
  expect(script).toContain('setAttribute("data-anno-hue"');
  expect(script).toContain('setProperty("--mark-hue"');
});

test("C-007: bridgeScript draws range-driven — resolves the anchor to ONE range then wraps every intersected text node", () => {
  const script = bridgeScript("n-range");
  // The draw sources ONE range from the shared resolver (range-driven fan-out), NOT per-leaf segments.
  expect(script).toContain("A.resolveAnchorRange");
  // The per-leaf-segment placement (placeAnchorAll iterating segments + per-block wrap) is GONE.
  expect(script).not.toContain("A.placeAnchorAll");
  // It walks text nodes in document order and wraps in REVERSE (so an earlier wrap doesn't invalidate
  // later node refs), skipping whitespace-only slices (so a <mark> never becomes a stray grid item).
  expect(script).toContain("data-anno");
});

test("AS-017/AS-018: the range-driven draw covers a container's own text + leaves a grid's children intact", () => {
  // Pull the drawRange function out of the bridge script and run it over happy-dom mimicking two
  // mf-spec-render AS cards: card 1 has BOTH grid text AND a Data sub-block; card 2 has only grid
  // text. The OLD per-leaf draw dropped card 1's grid text (it lived in a non-leaf container).
  const src = bridgeScript("n-draw");
  const m = src.match(/function drawRange\(anchor, id\)\{[\s\S]*?\n  \}/);
  const tn = src.match(/function textNodesOf\(root\)\{[\s\S]*?\n  \}/);
  expect(m).toBeTruthy();
  expect(tn).toBeTruthy();
  const win = new Window();
  win.document.body.innerHTML =
    '<div id="block-div-1"><dl class="gwt">\n      <dt>Given</dt><dd>alpha given</dd>\n    </dl>' +
    '<div id="block-div-1d" class="as-data">Data: alpha data</div></div>' +
    '<div id="block-div-2"><dl class="gwt">\n      <dt>Given</dt><dd>bravo given</dd>\n    </dl></div>';
  const doc: any = win.document;
  // Build the anchor from a real selection spanning both cards' grid text.
  const startDD = doc.querySelectorAll("dl.gwt dd")[0].firstChild;
  const endDD = doc.querySelectorAll("dl.gwt dd")[1].firstChild;
  const range = doc.createRange();
  range.setStart(startDD, 0);
  range.setEnd(endDD, endDD.textContent.length);
  const sel = win.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const anchor = selectionToAnchor(sel as any, doc)!;

  // Reconstruct the bridge's window.__anchordAnchor surface for the extracted function (drawRange
  // calls the sibling textNodesOf helper, so inject it into the same scope).
  const A = { resolveAnchorRange };
  const drawRange = new Function("A", "document", `${tn![0]}\n${m![0]} return drawRange;`)(A, doc);
  drawRange(anchor, "a-1");

  const covered = Array.from(doc.querySelectorAll("mark[data-anno]"))
    .map((mk: any) => mk.textContent)
    .join("|");
  // AS-017: BOTH cards' grid text highlighted — including card 1 which also has a Data sub-block.
  expect(covered).toContain("alpha given");
  expect(covered).toContain("bravo given");
  // AS-018: no <mark> is a direct child of either grid (no stray grid item); dt/dd stay the children.
  for (const dl of Array.from(doc.querySelectorAll("dl.gwt"))) {
    const stray = Array.from((dl as any).children).filter((c: any) => c.tagName === "MARK");
    expect(stray.length).toBe(0);
  }
});

test("C-006/layout: wrapTextRange skips whitespace-only nodes so a grid container's mark is never a stray grid item", () => {
  // BUG: a cross-block highlight that spans a structured block (an AS card whose body is a CSS-grid
  // <dl class="gwt">) used to wrap the whitespace text node sitting DIRECTLY inside the <dl> (the
  // "\n      " between the grid's children). That <mark> became a direct child of the grid → a stray
  // grid item that shifted every dt/dd by one cell and shattered the layout (+ rendered empty bars).
  // The fix mirrors the markdown engine's wrapRange: never wrap a whitespace-only slice.
  const src = bridgeScript("n-wrap");
  const m = src.match(/function wrapTextRange\(el, start, end\)\{[\s\S]*?return marks\.length \? marks : null;\s*\}/);
  const tn = src.match(/function textNodesOf\(root\)\{[\s\S]*?\n  \}/);
  expect(m).toBeTruthy();
  expect(tn).toBeTruthy();
  const win = new Window();
  win.document.body.innerHTML =
    '<div id="b"><dl class="gwt">\n      <dt>Given</dt><dd>hello</dd>\n      <dt>When</dt><dd>world</dd>\n    </dl></div>';
  const doc: any = win.document;
  // wrapTextRange now descends via the sibling textNodesOf helper (not createTreeWalker) — inject it.
  const wrapTextRange = new Function("document", `${tn![0]}\n${m![0]} return wrapTextRange;`)(doc);
  const block = doc.querySelector("#b");
  wrapTextRange(block, 0, (block.textContent || "").length); // the cross-block segment wraps the WHOLE card
  const dl = doc.querySelector("dl.gwt");
  // No <mark> is a DIRECT child of the grid — otherwise it's a stray grid item.
  const strayMarks = Array.from(dl.children).filter((c: any) => c.tagName === "MARK");
  expect(strayMarks.length).toBe(0);
  // The grid's direct children stay exactly the dt/dd pairs, in order (layout intact).
  expect(Array.from(dl.children).map((c: any) => c.tagName)).toEqual(["DT", "DD", "DT", "DD"]);
});

test("C-001: the injected style does NOT weaken the sandbox CSP — inline <style> allowed, no same-origin/style-src", () => {
  expect(CONTENT_SECURITY_POLICY).toBe("sandbox allow-scripts");
  expect(CONTENT_SECURITY_POLICY).not.toContain("allow-same-origin");
  expect(CONTENT_SECURITY_POLICY).not.toContain("style-src");
  const out = injectBridge(injectBlockIds("<p>x</p>"), "n");
  expect(out).toContain("<style>");
  expect(out).toContain("anchord-bridge");
});

test("bridge-serve: generateNonce yields a non-empty unguessable-length token, unique per call", () => {
  const a = generateNonce();
  const b = generateNonce();
  expect(a.length).toBeGreaterThanOrEqual(16);
  expect(a).not.toBe(b);
});

// ---------------------------------------------------------------------------
// S-003 — clear-then-redraw: the {type:'highlights'} batch handler (clear THEN redraw).
// ---------------------------------------------------------------------------

test("AS-007 (C-002): the bridge handles a batch {type:'highlights'} message — unwrap-all THEN redraw the set", () => {
  const script = bridgeScript("n-batch");
  expect(script).toContain('"highlights"');
  expect(script).toContain("items");
  expect(script).toContain("unwrapAllAnnoMarks");
  expect(script).toContain('mark[data-anno]');
});

test("AS-009 (C-002): the single {type:'highlight'} handler still works (back-compat)", () => {
  const script = bridgeScript("n-compat");
  expect(script).toContain('msg.type === "highlight"');
  expect(script).toContain('msg.type === "highlights"');
});

// ---------------------------------------------------------------------------
// S-002 — HTML highlight reflects lifecycle state (resolved / redline / stale).
// ---------------------------------------------------------------------------

test("AS-004: the injected stylesheet carries the resolved (dim) rule — a resolved HTML mark dims", () => {
  expect(MARK_STYLESHEET).toContain('.anno-mark[data-resolved="true"]');
  expect(MARK_STYLESHEET).toContain("#43b873");
  const out = injectBridge(injectBlockIds("<p>x</p>"), "n-resolved");
  expect(out).toContain('.anno-mark[data-resolved="true"]');
});

test("AS-005: the injected stylesheet carries the redline (red strikethrough) rule", () => {
  expect(MARK_STYLESHEET).toContain('.anno-mark[data-anno-kind="redline"]');
  expect(MARK_STYLESHEET).toContain("#f1655d");
  expect(MARK_STYLESHEET).toContain("line-through");
});

test("AS-006: the injected stylesheet carries the stale rule — muted/dashed, NOT a confident strike", () => {
  expect(MARK_STYLESHEET).toContain('.anno-mark[data-anno-stale="true"]');
  expect(MARK_STYLESHEET).toContain("dashed");
  expect(MARK_STYLESHEET.indexOf('.anno-mark[data-anno-stale="true"]')).toBeGreaterThan(
    MARK_STYLESHEET.indexOf('.anno-mark[data-anno-kind="redline"]'),
  );
});

test("C-003: the in-iframe draw sets data-resolved / data-anno-kind / data-anno-stale from the item flags", () => {
  const script = bridgeScript("n-state");
  expect(script).toContain('setAttribute("data-resolved", "true")');
  expect(script).toContain('setAttribute("data-anno-kind", "redline")');
  expect(script).toContain('setAttribute("data-anno-stale", "true")');
  expect(script).toContain("item.resolved");
  expect(script).toContain('item.kind === "redline"');
  expect(script).toContain("item.stale");
});

// ---------------------------------------------------------------------------
// S-004 — click an HTML highlight → focus its thread; focus a thread → scroll + emphasise.
// ---------------------------------------------------------------------------

test("AS-011: the in-iframe bridge wires a [data-anno] mark click → a mark-click port message", () => {
  const script = bridgeScript("n-click");
  expect(script).toContain('"mark-click"');
  expect(script).toContain("data-anno");
  expect(script).toMatch(/port\.postMessage\(\{\s*type:\s*"mark-click"/);
});

test("AS-012: the in-iframe bridge handles a {type:'focus'} message — toggles anno-mark--focus + scrolls", () => {
  const script = bridgeScript("n-focus");
  expect(script).toContain('"focus"');
  expect(script).toContain("anno-mark--focus");
  expect(script).toContain("scrollIntoView");
});

test("C-005: the injected stylesheet carries the .anno-mark--focus emphasis rule (mirrors styles.css)", () => {
  expect(MARK_STYLESHEET).toContain(".anno-mark--focus");
  expect(MARK_STYLESHEET).toContain("#37b3bd");
  const out = injectBridge(injectBlockIds("<p>x</p>"), "n-focus2");
  expect(out).toContain(".anno-mark--focus");
});

// ---------------------------------------------------------------------------
// annotation-hover-card S-003 — the in-iframe peek/pin relay (mark-click+rect, mark-enter/leave,
// mark-rect on scroll). The PARENT-side Zod-validate + clamp + id-membership no-op lives in
// apps/web/src/features/viewer/lib/bridge.test.ts (AS-027); this side proves the in-iframe relay.
// ---------------------------------------------------------------------------

test("AS-016: mark-click now carries the CLICKED mark's own rect (annotationId field, not annoId)", () => {
  const script = bridgeScript("n-hover-click");
  expect(script).toContain('"mark-click"');
  // The relayed FIELD is annotationId (NOT annoId) — the parent and S-001/S-002 surfaces key on it.
  // The posted-message shape is the load-bearing assertion (a comment may mention "annoId" in prose).
  expect(script).toMatch(/type:\s*"mark-click",\s*annotationId:\s*id,\s*rect:\s*markRect\(mk\)/);
  expect(script).not.toMatch(/postMessage\(\{\s*type:\s*"mark-click",\s*annoId:/);
  // The click relays the mark's OWN rect (markRect) so the pin anchors to the clicked mark (C-008).
  expect(script).toContain("markRect");
});

test("AS-015: hover relays mark-enter (id + rect) / mark-leave over the port for the parent peek", () => {
  const script = bridgeScript("n-hover-peek");
  expect(script).toContain('"mark-enter"');
  expect(script).toContain('"mark-leave"');
  // Hover is mouseover/mouseout with a relatedTarget check — NOT mouseenter/mouseleave (don't bubble
  // to a delegated listener, per the S-001 markdown contract).
  expect(script).toContain('addEventListener("mouseover"');
  expect(script).toContain('addEventListener("mouseout"');
  expect(script).not.toContain('addEventListener("mouseenter"');
  expect(script).toContain("relatedTarget");
  // mark-enter carries the rect; mark-leave only the id (the parent already knows the rect).
  expect(script).toMatch(/type:\s*"mark-enter",\s*annotationId:\s*id,\s*rect:\s*markRect\(mk\)/);
});

test("C-008: moving between marks that share the SAME data-anno is NOT a re-enter / leave (coalesce)", () => {
  // Extract the mouseover/mouseout coalesce logic by simulating the in-iframe handlers over happy-dom:
  // two <mark>s with the SAME data-anno (a multi_range annotation's N marks). Moving between them must
  // emit exactly ONE enter and NO leave; moving to a DIFFERENT id emits leave+enter.
  const win = new Window();
  win.document.body.innerHTML =
    '<p><mark data-anno="a-1" id="m1a">alpha</mark> mid <mark data-anno="a-1" id="m1b">beta</mark> ' +
    '<mark data-anno="a-2" id="m2">gamma</mark></p>';
  const doc: any = win.document;
  // Re-implement the exact coalesce state machine the bridge uses (verifying its semantics — the
  // string assertions above prove the bridge ships this code; this proves the logic is correct).
  const posted: { type: string; annotationId: string | null }[] = [];
  let markEnterId: string | null = null;
  const over = (target: any) => {
    const mk = target.closest("mark[data-anno]");
    if (!mk) return;
    const id = mk.getAttribute("data-anno");
    if (!id || id === markEnterId) return;
    markEnterId = id;
    posted.push({ type: "mark-enter", annotationId: id });
  };
  const out = (target: any, related: any) => {
    if (markEnterId == null) return;
    const mk = target.closest("mark[data-anno]");
    if (!mk) return;
    const toMark = related && related.closest ? related.closest("mark[data-anno]") : null;
    if (toMark && toMark.getAttribute("data-anno") === markEnterId) return;
    const leftId = markEnterId;
    markEnterId = null;
    posted.push({ type: "mark-leave", annotationId: leftId });
  };
  const m1a = doc.querySelector("#m1a");
  const m1b = doc.querySelector("#m1b");
  const m2 = doc.querySelector("#m2");
  over(m1a); // enter a-1
  out(m1a, m1b); // move to the SIBLING mark of the SAME id → NOT a leave
  over(m1b); // same id → NO new enter
  expect(posted).toEqual([{ type: "mark-enter", annotationId: "a-1" }]);
  out(m1b, m2); // now leaving a-1 toward a DIFFERENT id → leave fires
  over(m2); // enter a-2
  expect(posted).toEqual([
    { type: "mark-enter", annotationId: "a-1" },
    { type: "mark-leave", annotationId: "a-1" },
    { type: "mark-enter", annotationId: "a-2" },
  ]);
});

test("AS-021: the bridge re-posts a mark-rect on in-iframe scroll, rAF-throttled (HTML pin auto-close)", () => {
  const script = bridgeScript("n-hover-scroll");
  expect(script).toContain('"mark-rect"');
  expect(script).toContain("postMarkRect");
  expect(script).toContain("requestAnimationFrame(postMarkRect)");
  // It tracks the hovered/clicked mark and re-reads its rect on scroll (separate rAF from selection).
  expect(script).toContain("trackedMark");
  expect(script).toContain("markScrollRaf");
});

// ── S-007: in-iframe client-storage shim (render-publish C-010) ──────────────────────────

function opaqueWindow(opts: { idbThrows?: boolean } = {}) {
  const w: any = {};
  const denied = () => {
    throw new Error("SecurityError: storage is not available on an opaque origin");
  };
  for (const key of ["localStorage", "sessionStorage", "caches"]) {
    Object.defineProperty(w, key, { configurable: true, get: denied });
  }
  if (opts.idbThrows) Object.defineProperty(w, "indexedDB", { configurable: true, get: denied });
  const BC = function () {
    denied();
  } as unknown as typeof BroadcastChannel;
  return { w, BC };
}

function runShim(w: any, BC: any) {
  // eslint-disable-next-line no-new-func
  const fn = new Function("window", "BroadcastChannel", STORAGE_SHIM);
  fn(w, BC);
}

test("AS-024: a doc's storage-using script runs (read returns null, not a throw) and round-trips", () => {
  const { w, BC } = opaqueWindow();
  runShim(w, BC);
  expect(w.localStorage.getItem("spec-theme")).toBeNull();
  w.localStorage.setItem("spec-theme", "dark");
  expect(w.localStorage.getItem("spec-theme")).toBe("dark");
  w.sessionStorage.setItem("k", "v");
  expect(w.sessionStorage.getItem("k")).toBe("v");
});

test("AS-024: the shim is a real Storage-shaped Proxy — bracket/dot access and `in` route to the store", () => {
  const { w, BC } = opaqueWindow();
  runShim(w, BC);
  w.localStorage.theme = "dark";
  expect(w.localStorage.theme).toBe("dark");
  expect(w.localStorage["theme"]).toBe("dark");
  expect("theme" in w.localStorage).toBe(true);
  expect(w.localStorage.length).toBe(1);
  w.localStorage.removeItem("theme");
  expect("theme" in w.localStorage).toBe(false);
  expect(w.localStorage.length).toBe(0);
});

test("AS-024: the cache store is stubbed to a benign no-op instead of throwing", async () => {
  const { w, BC } = opaqueWindow();
  runShim(w, BC);
  expect(() => w.caches).not.toThrow();
  const cache = await w.caches.open("v1");
  expect(await cache.match("/x")).toBeUndefined();
  expect(() => new w.BroadcastChannel("t")).not.toThrow();
});

test("AS-025: stored values are session-only — a fresh frame starts empty (nothing persisted)", () => {
  const a = opaqueWindow();
  runShim(a.w, a.BC);
  a.w.localStorage.setItem("spec-theme", "dark");
  expect(a.w.localStorage.getItem("spec-theme")).toBe("dark");
  const b = opaqueWindow();
  runShim(b.w, b.BC);
  expect(b.w.localStorage.getItem("spec-theme")).toBeNull();
});

test("AS-025: the shim is not bridged — it never reaches the parent/app origin", () => {
  expect(STORAGE_SHIM).not.toContain("parent");
  expect(STORAGE_SHIM).not.toContain("MessageChannel");
  expect(STORAGE_SHIM).not.toContain(".port");
});

test("AS-026: an unshimmed capability (indexedDB) still degrades without taking down the shimmed ones", () => {
  const { w, BC } = opaqueWindow({ idbThrows: true });
  runShim(w, BC);
  expect(() => w.indexedDB).toThrow();
  expect(w.localStorage.getItem("x")).toBeNull();
  w.localStorage.setItem("x", "1");
  expect(w.localStorage.getItem("x")).toBe("1");
});

test("S-007: injectStorageShim PREPENDS the shim before the doc's own scripts (after <head>)", () => {
  const doc = "<html><head><title>t</title></head><body><script>localStorage.getItem('x')</script></body></html>";
  const out = injectStorageShim(doc, "n1");
  const shimAt = out.indexOf("nonce=\"n1\"");
  const docScriptAt = out.indexOf("localStorage.getItem('x')");
  expect(shimAt).toBeGreaterThan(-1);
  expect(shimAt).toBeLessThan(docScriptAt);
  expect(out.indexOf("<head>")).toBeLessThan(shimAt);
});

test("S-007: injectStorageShim prepends before the first script when there is no <head>", () => {
  const out = injectStorageShim("<p>hi</p><script>localStorage.x=1</script>", "n2");
  expect(out.indexOf("nonce=\"n2\"")).toBeLessThan(out.indexOf("localStorage.x=1"));
});

test("S-007: the injected shim is static — identical regardless of the doc it wraps (no interpolation)", () => {
  const a = injectStorageShim("<head></head><p>A</p>", "n");
  const b = injectStorageShim("<head></head><div>completely different</div>", "n");
  const grab = (s: string) => s.slice(s.indexOf("<script nonce=\"n\">"), s.indexOf("</script>") + 9);
  expect(grab(a)).toBe(grab(b));
  expect(STORAGE_SHIM).not.toContain("</script>");
});

test("AS-026/C-010: the full serve keeps the opaque-origin CSP and never adds allow-same-origin", () => {
  const served = injectBridge(injectStorageShim(injectBlockIds("<head></head><p>x</p>"), "ng"), "ng");
  expect(served).toContain("nonce=\"ng\"");
  expect(CONTENT_SECURITY_POLICY).toContain("sandbox");
  expect(CONTENT_SECURITY_POLICY).toContain("allow-scripts");
  expect(CONTENT_SECURITY_POLICY).not.toContain("allow-same-origin");
  expect(served).not.toContain("allow-same-origin");
});
