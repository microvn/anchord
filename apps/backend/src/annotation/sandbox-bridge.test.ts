import { test, expect } from "bun:test";
import { Window } from "happy-dom";
import {
  selectionToAnchor,
  placeAnchor,
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

// annotation-core S-001 / GAP-004 — the in-iframe sandbox bridge (C-009/C-002/C-001).
// The pure anchor walk/placement logic is unit-tested against a happy-dom Window (no real
// browser); the bridge-serve assertions cover the injected script + CSP-nonce contract.
//
// happy-dom's `Window` gives a real Selection + Range + querySelector implementation, so
// these tests exercise the same code path the bridge IIFE runs in-browser.

/** Build a DOM from an HTML body string and return its document + window. */
function dom(body: string) {
  const win = new Window();
  win.document.body.innerHTML = body;
  return { doc: win.document as unknown as any, win };
}

/** Select [start,end) chars within the first text node of the element matched by `selector`. */
function selectChars(win: any, doc: any, selector: string, start: number, end: number) {
  const el = doc.querySelector(selector);
  const textNode = el.firstChild;
  const range = doc.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, end);
  const sel = win.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return sel as any;
}

// ---------------------------------------------------------------------------
// AS-004 — selection inside a block yields a block anchor; both attribute forms.
// ---------------------------------------------------------------------------

test("AS-004: selection inside a plain id=\"block-p-1\" block → {blockId,textSnippet,offset,length}", () => {
  const { doc, win } = dom('<p id="block-p-1">Payment expires after 24h</p>');
  // Select "expires" (chars 8..15).
  const sel = selectChars(win, doc, "p", 8, 15);
  const anchor = selectionToAnchor(sel, doc);
  expect(anchor).not.toBeNull();
  expect(anchor!.blockId).toBe("block-p-1");
  expect(anchor!.textSnippet).toBe("expires");
  expect(anchor!.offset).toBe(8);
  expect(anchor!.length).toBe(7);
  expect(anchor!.segments).toBeUndefined();
});

test("AS-004: selection inside a data-block-id form block resolves the same way", () => {
  // injectBlockIds emits data-block-id when the element already had an id (C-001).
  const { doc, win } = dom('<p data-block-id="block-p-1" id="authors-own">Payment expires after 24h</p>');
  const sel = selectChars(win, doc, "p", 0, 7);
  const anchor = selectionToAnchor(sel, doc);
  expect(anchor).not.toBeNull();
  expect(anchor!.blockId).toBe("block-p-1"); // data-block-id wins, not the author's id
  expect(anchor!.textSnippet).toBe("Payment");
  expect(anchor!.offset).toBe(0);
  expect(anchor!.length).toBe(7);
});

test("AS-004: placeAnchor round-trips an anchor produced by selectionToAnchor (exact)", () => {
  const { doc, win } = dom('<p id="block-p-1">Payment expires after 24h</p>');
  const sel = selectChars(win, doc, "p", 8, 15);
  const anchor = selectionToAnchor(sel, doc)!;
  const placed = placeAnchor(anchor, doc);
  expect(placed.ok).toBe(true);
  if (placed.ok) {
    expect(placed.blockId).toBe("block-p-1");
    expect(placed.start).toBe(8);
    expect(placed.end).toBe(15);
    expect(placed.text).toBe("expires");
  }
});

test("AS-004: round-trip against the data-block-id form too", () => {
  const { doc, win } = dom('<p data-block-id="block-p-1" id="x">Payment expires after 24h</p>');
  const sel = selectChars(win, doc, "p", 8, 15);
  const anchor = selectionToAnchor(sel, doc)!;
  const placed = placeAnchor(anchor, doc);
  expect(placed.ok).toBe(true);
  if (placed.ok) expect(placed.text).toBe("expires");
});

// ---------------------------------------------------------------------------
// AS-004-empty / C-003 — collapsed / whitespace-only / no-block → null.
// ---------------------------------------------------------------------------

test("AS-004-empty (C-003): a collapsed selection → null anchor", () => {
  const { doc, win } = dom('<p id="block-p-1">hello world</p>');
  const sel = selectChars(win, doc, "p", 3, 3); // zero-length
  expect(selectionToAnchor(sel, doc)).toBeNull();
});

test("AS-004-empty (C-003): a whitespace-only selection → null anchor", () => {
  const { doc, win } = dom('<p id="block-p-1">a&nbsp;&nbsp;&nbsp;b</p>');
  // Select the run of whitespace between a and b (chars 1..4).
  const sel = selectChars(win, doc, "p", 1, 4);
  expect(selectionToAnchor(sel, doc)).toBeNull();
});

test("AS-004-empty: a selection with no enclosing block element → null", () => {
  // A bare span carrying no block-id is not addressable.
  const { doc, win } = dom('<span>loose text not in a block</span>');
  const sel = selectChars(win, doc, "span", 0, 5);
  expect(selectionToAnchor(sel, doc)).toBeNull();
});

test("AS-004-empty: null selection → null anchor", () => {
  const { doc } = dom('<p id="block-p-1">hello</p>');
  expect(selectionToAnchor(null, doc)).toBeNull();
});

// ---------------------------------------------------------------------------
// AS-003 — cross-block / disambiguation behaviour.
// ---------------------------------------------------------------------------

test("AS-003: duplicate snippet across blocks anchors to the SELECTED block by id", () => {
  const { doc, win } = dom('<p id="block-p-3">see below</p><p id="block-p-9">see below</p>');
  const blocks = doc.querySelectorAll("p");
  const second = blocks[1];
  const range = doc.createRange();
  range.setStart(second.firstChild, 0);
  range.setEnd(second.firstChild, 9);
  const sel = win.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const anchor = selectionToAnchor(sel as any, doc)!;
  expect(anchor.blockId).toBe("block-p-9"); // the chosen block, not block-p-3
  expect(anchor.textSnippet).toBe("see below");
});

test("AS-004: cross-block selection → segments[] spanning both blocks", () => {
  const { doc, win } = dom('<p id="block-p-1">first block text</p><p id="block-p-2">second block text</p>');
  const blocks = doc.querySelectorAll("p");
  const range = doc.createRange();
  range.setStart(blocks[0].firstChild, 6); // "block text"
  range.setEnd(blocks[1].firstChild, 6); // "second"
  const sel = win.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const anchor = selectionToAnchor(sel as any, doc)!;
  expect(anchor.segments).toBeDefined();
  expect(anchor.segments!.length).toBe(2);
  expect(anchor.segments![0].blockId).toBe("block-p-1");
  expect(anchor.segments![1].blockId).toBe("block-p-2");
  // Top-level fields mirror the first segment.
  expect(anchor.blockId).toBe("block-p-1");
});

test("AS-003: a cross-block selection emits ONE segment per LEAF block — never an ancestor container (no nested double-wrap)", () => {
  // Regression: an HTML spec doc nests block-ids (a story div > AS divs > Given/When/Then). A
  // whole-story selection spans an intermediate CONTAINER block AND its children; without a leaf
  // filter the container's FULL text became its own segment on top of each child's segment →
  // overlapping/nested <mark> wraps → the layout shattered. Only leaf blocks (a block containing no
  // other in-range block) may be segments. sandbox-bridge.ts selectionToAnchor.
  const { doc, win } = dom(
    '<p id="block-p-1">first</p>' +
      '<div id="block-div-2"><p id="block-p-2">middle</p></div>' +
      '<p id="block-p-3">last</p>',
  );
  const range = doc.createRange();
  range.setStart(doc.querySelector("#block-p-1")!.firstChild, 0);
  range.setEnd(doc.querySelector("#block-p-3")!.firstChild, 4);
  const sel = win.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const anchor = selectionToAnchor(sel as any, doc)!;
  // Exactly the three leaf blocks, in document order — NEVER the wrapping block-div-2.
  expect(anchor.segments!.map((s) => s.blockId)).toEqual(["block-p-1", "block-p-2", "block-p-3"]);
});

test("AS-004-place: cross-block anchor places EACH segment's block, not just the first", () => {
  // Regression: drawHighlight/placeRange only placed the TOP-LEVEL anchor.blockId, so a
  // cross-block (multi_range) highlight stopped at the end of the FIRST block instead of
  // running through every spanned block — markdown's placeAnnotations already iterates
  // segments[]; the in-iframe bridge did not. sandbox-bridge.ts placeRange broke this.
  const { doc } = dom('<p id="block-p-1">first block text</p><p id="block-p-2">second block text</p>');
  const anchor = {
    blockId: "block-p-1",
    textSnippet: "block text",
    offset: 6,
    length: 10,
    segments: [
      { blockId: "block-p-1", textSnippet: "block text", offset: 6, length: 10 },
      { blockId: "block-p-2", textSnippet: "second", offset: 0, length: 6 },
    ],
  };
  const placed = placeAnchorAll(anchor, doc);
  const ok = placed.filter((p) => p.ok) as Extract<(typeof placed)[number], { ok: true }>[];
  expect(ok.length).toBe(2);
  expect(ok.map((p) => p.blockId).sort()).toEqual(["block-p-1", "block-p-2"]);
  // The end-block segment must reach into block-p-2 (the "couldn't end at the right place" bug).
  const p2 = ok.find((p) => p.blockId === "block-p-2")!;
  expect(p2.text).toBe("second");
});

test("AS-004-place: a single-block anchor (no segments) → exactly one placement via placeAnchorAll", () => {
  const { doc } = dom('<p id="block-p-1">Payment expires after 24h</p>');
  const placed = placeAnchorAll({ blockId: "block-p-1", textSnippet: "expires", offset: 8, length: 7 }, doc);
  expect(placed.length).toBe(1);
  expect(placed[0]!.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// AS-004-place — placement: exact, fuzzy (shifted), not-found sentinel (no throw).
// ---------------------------------------------------------------------------

test("AS-004-place: exact placement at the recorded offset", () => {
  const { doc } = dom('<p id="block-p-1">Payment expires after 24h</p>');
  const placed = placeAnchor(
    { blockId: "block-p-1", textSnippet: "expires", offset: 8, length: 7 },
    doc,
  );
  expect(placed.ok).toBe(true);
  if (placed.ok) {
    expect(placed.start).toBe(8);
    expect(placed.end).toBe(15);
  }
});

test("AS-004-place: snippet present but offset shifted by edits → relocated, still ok", () => {
  // Block text gained a prefix, so the recorded offset no longer lines up.
  const { doc } = dom('<p id="block-p-1">NOTE: Payment expires after 24h</p>');
  const placed = placeAnchor(
    { blockId: "block-p-1", textSnippet: "expires", offset: 8, length: 7 },
    doc,
  );
  expect(placed.ok).toBe(true);
  if (placed.ok) {
    expect(placed.text).toBe("expires");
    expect(placed.start).toBe(14); // relocated to the real position
  }
});

test("AS-004-place: fuzzy placement when the snippet text shifted by a few chars", () => {
  // Snippet recorded as "Payment expires after 24h"; block now says "Payment expires after 48h".
  const { doc } = dom('<p id="block-p-1">Payment expires after 48h</p>');
  const placed = placeAnchor(
    { blockId: "block-p-1", textSnippet: "Payment expires after 24h", offset: 0, length: 26 },
    doc,
  );
  expect(placed.ok).toBe(true);
  if (placed.ok) {
    expect(placed.start).toBe(0);
    expect(placed.text).toContain("Payment expires after");
  }
});

test("AS-004-place: block missing → not-found-style sentinel, never throws", () => {
  const { doc } = dom('<p id="block-p-1">hello</p>');
  let placed: ReturnType<typeof placeAnchor>;
  expect(() => {
    placed = placeAnchor({ blockId: "block-p-99", textSnippet: "hello", offset: 0, length: 5 }, doc);
  }).not.toThrow();
  expect(placed!.ok).toBe(false);
  if (!placed!.ok) expect(placed!.reason).toBe("no-block");
});

test("AS-004-place: snippet absent and not fuzzy-matchable → not-found sentinel, no throw", () => {
  const { doc } = dom('<p id="block-p-1">completely different content here</p>');
  let placed: ReturnType<typeof placeAnchor>;
  expect(() => {
    placed = placeAnchor({ blockId: "block-p-1", textSnippet: "zzz qqq xxx", offset: 0, length: 11 }, doc);
  }).not.toThrow();
  expect(placed!.ok).toBe(false);
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
  // The new scroll re-anchor message shape.
  expect(script).toContain('type: "selection-rect"');
  // rAF-gated (only schedules one frame at a time) and on capture-phase scroll.
  expect(script).toContain("requestAnimationFrame(postSelectionRect)");
  expect(script).toContain('addEventListener("scroll"');
  // It keeps a live pending Range to re-read the current rect on scroll.
  expect(script).toContain("pendingRange");
});

test("bridge-serve: injectBridge appends exactly ONE script and preserves block-ids", () => {
  const served = injectBlockIds("<h1>Title</h1><p>Body text here</p>");
  const out = injectBridge(served, "nonce-xyz");
  // Block-ids still present after injection.
  expect(out).toContain('<h1 id="block-h1-1">');
  expect(out).toContain('<p id="block-p-1">Body text here');
  // Exactly one <script> appended.
  const scriptOpens = out.match(/<script\b/g) ?? [];
  expect(scriptOpens.length).toBe(1);
  // Script carries the CSP nonce attribute so it survives a script-src 'nonce-…' policy.
  expect(out).toContain('<script nonce="nonce-xyz">');
  // The bridge script comes AFTER the doc content.
  expect(out.indexOf("<script")).toBeGreaterThan(out.indexOf("block-p-1"));
});

test("bridge-serve: injectBridge neutralizes a hostile nonce in BOTH the attribute and script body", () => {
  const out = injectBridge("<p>x</p>", '"><script>alert(1)</script>');
  // (a) Attribute: the nonce is HTML-attribute-escaped so it can't break out into a new tag.
  expect(out).toContain("&quot;&gt;");
  expect(out).not.toContain('nonce=""><script>'); // no attribute breakout
  // (b) Script body: the only injection that matters inside an inline <script> is a literal
  //     </script> close tag. It must be escaped so the script stays one cohesive block.
  expect(out).not.toContain("alert(1)</script>"); // the close tag was neutralized
  expect(out).toContain("alert(1)<\\/script>");
  // Exactly one real (unescaped) </script> — the tag we appended ourselves.
  const closes = out.match(/<\/script>/gi) ?? [];
  expect(closes.length).toBe(1);
});

test("AS-001: injectBridge injects the .anno-mark highlight stylesheet so a drawn mark is not browser-yellow", () => {
  const out = injectBridge(injectBlockIds("<p>Body text here</p>"), "nonce-css");
  // A <style> carrying the .anno-mark rule set is injected (the iframe has none of the app's CSS,
  // so without this the bare <mark> renders the browser-default yellow block, not the app treatment).
  expect(out).toContain("<style>");
  expect(out).toContain(".anno-mark");
  // base accent treatment: the DESIGN.md accent teal value is inlined (no app tokens in the iframe).
  expect(out).toContain("#37b3bd");
  // the per-type/label hue rule reads the per-mark --mark-hue custom prop.
  expect(out).toContain(".anno-mark[data-anno-hue]");
  expect(out).toContain("var(--mark-hue)");
  // the style comes BEFORE the bridge script so the rule set exists when marks are drawn.
  expect(out.indexOf("<style>")).toBeLessThan(out.indexOf("<script"));
});

test("AS-002: the in-iframe draw applies class=anno-mark + the hue (data-anno-hue + --mark-hue) on a highlight", () => {
  const script = bridgeScript("n-hue");
  // The highlight handler sets the app class so the injected stylesheet applies (AS-001) and,
  // when the message carries a hue, the hued-mark attributes mirroring the markdown mark (AS-002).
  expect(script).toContain('setAttribute("class", "anno-mark")');
  expect(script).toContain('setAttribute("data-anno-hue"');
  expect(script).toContain('setProperty("--mark-hue"');
});

test("C-001: the injected style does NOT weaken the sandbox CSP — inline <style> allowed, no same-origin/style-src", () => {
  // The served CSP stays `sandbox allow-scripts` (no allow-same-origin, no style-src directive) — an
  // inline <style> is allowed under it, and the injection must not add any directive that would.
  expect(CONTENT_SECURITY_POLICY).toBe("sandbox allow-scripts");
  expect(CONTENT_SECURITY_POLICY).not.toContain("allow-same-origin");
  expect(CONTENT_SECURITY_POLICY).not.toContain("style-src");
  // Highlights are drawn ONLY by the in-iframe bridge over the port — the served content carries the
  // bridge script + the style, never any parent-side DOM reach.
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

test("bridge-serve: BLOCK_SELECTOR matches both block-id attribute forms", () => {
  expect(BLOCK_SELECTOR).toContain("data-block-id");
  expect(BLOCK_SELECTOR).toContain('id^="block-"');
});

// ---------------------------------------------------------------------------
// S-003 — clear-then-redraw: unwrapAnnoMarks restores text + the {type:'highlights'} handler.
// ---------------------------------------------------------------------------

test("C-002: unwrapAnnoMarks removes every mark[data-anno] and restores the original text", () => {
  // A block with two anno marks wrapping parts of the text + a plain (non-anno) mark left alone.
  const { doc } = dom(
    '<p id="block-p-1">Payment <mark data-anno="a-1" class="anno-mark">expires</mark> after <mark data-anno="a-2" class="anno-mark">24h</mark> total</p>',
  );
  unwrapAnnoMarks(doc as any);
  const p = (doc as any).querySelector("p");
  // No anno marks remain; the surrounding text is intact (the childNodes were moved out + normalized).
  expect(p.querySelectorAll("mark[data-anno]").length).toBe(0);
  expect(p.textContent).toBe("Payment expires after 24h total");
});

test("C-002: unwrapAnnoMarks leaves a non-anno <mark> untouched", () => {
  const { doc } = dom('<p id="block-p-1">a <mark>plain</mark> b <mark data-anno="x" class="anno-mark">anno</mark> c</p>');
  unwrapAnnoMarks(doc as any);
  const p = (doc as any).querySelector("p");
  // The plain mark survives; only the data-anno one was unwrapped.
  expect(p.querySelectorAll("mark").length).toBe(1);
  expect(p.querySelector("mark")!.textContent).toBe("plain");
  expect(p.textContent).toBe("a plain b anno c");
});

test("C-002: unwrapAnnoMarks on a doc with no anno marks is a no-op (idempotent, no throw)", () => {
  const { doc } = dom('<p id="block-p-1">nothing to unwrap here</p>');
  expect(() => unwrapAnnoMarks(doc as any)).not.toThrow();
  expect((doc as any).querySelector("p").textContent).toBe("nothing to unwrap here");
});

test("AS-007 (C-002): the bridge handles a batch {type:'highlights'} message — unwrap-all THEN redraw the set", () => {
  const script = bridgeScript("n-batch");
  // The new batch message shape the parent sends the FULL current set with.
  expect(script).toContain('"highlights"');
  expect(script).toContain("items");
  // It unwraps every existing anno mark first (clear), then draws each item (redraw) — idempotent.
  expect(script).toContain("unwrapAllAnnoMarks");
  expect(script).toContain('mark[data-anno]');
});

test("AS-009 (C-002): the single {type:'highlight'} handler still works (back-compat)", () => {
  const script = bridgeScript("n-compat");
  // The batch path is additive — the single-highlight handler is kept so existing callers work.
  expect(script).toContain('msg.type === "highlight"');
  expect(script).toContain('msg.type === "highlights"');
});

// ---------------------------------------------------------------------------
// S-002 — HTML highlight reflects lifecycle state (resolved / redline / stale).
// The injected stylesheet must carry the SAME state rules as styles.css .anno-mark, and the
// in-iframe draw must set the SAME dataset hooks (data-resolved / data-anno-kind / data-anno-stale)
// from the highlight item's flags so an HTML mark reads identically to a markdown mark (C-003).
// ---------------------------------------------------------------------------

test("AS-004: the injected stylesheet carries the resolved (dim) rule — a resolved HTML mark dims", () => {
  // Mirrors styles.css `.anno-mark[data-resolved="true"]` — the green/resolved tint, distinct from
  // the active teal highlight. The DESIGN green value is inlined (the iframe has no app tokens).
  expect(MARK_STYLESHEET).toContain('.anno-mark[data-resolved="true"]');
  expect(MARK_STYLESHEET).toContain("#43b873"); // --green inlined
  // injectBridge serves it inside the <style> block.
  const out = injectBridge(injectBlockIds("<p>x</p>"), "n-resolved");
  expect(out).toContain('.anno-mark[data-resolved="true"]');
});

test("AS-005: the injected stylesheet carries the redline (red strikethrough) rule", () => {
  // Mirrors styles.css `.anno-mark[data-anno-kind="redline"]` — red tint + line-through, NO edit of
  // the doc content. The DESIGN red value is inlined.
  expect(MARK_STYLESHEET).toContain('.anno-mark[data-anno-kind="redline"]');
  expect(MARK_STYLESHEET).toContain("#f1655d"); // --red inlined
  expect(MARK_STYLESHEET).toContain("line-through");
});

test("AS-006: the injected stylesheet carries the stale rule — muted/dashed, NOT a confident strike", () => {
  // Mirrors styles.css `.anno-mark[data-anno-stale="true"]` — dashed underline, no line-through, no
  // red tint, dimmed. A stale redline must read muted/dashed, not the confident red strike (stale
  // wins over redline per the markdown CSS source order).
  expect(MARK_STYLESHEET).toContain('.anno-mark[data-anno-stale="true"]');
  expect(MARK_STYLESHEET).toContain("dashed");
  // The stale rule appears AFTER the redline rule so it overrides at equal specificity (stale wins).
  expect(MARK_STYLESHEET.indexOf('.anno-mark[data-anno-stale="true"]')).toBeGreaterThan(
    MARK_STYLESHEET.indexOf('.anno-mark[data-anno-kind="redline"]'),
  );
});

test("C-003: the in-iframe draw sets data-resolved / data-anno-kind / data-anno-stale from the item flags", () => {
  const script = bridgeScript("n-state");
  // drawHighlight applies the SAME dataset hooks the markdown engine uses, driven by the served
  // state carried on the highlight item — so an HTML mark reproduces the markdown mark's appearance.
  expect(script).toContain('setAttribute("data-resolved", "true")');
  expect(script).toContain('setAttribute("data-anno-kind", "redline")');
  expect(script).toContain('setAttribute("data-anno-stale", "true")');
  // Each is gated on the matching item flag (resolved / kind === "redline" / stale).
  expect(script).toContain("item.resolved");
  expect(script).toContain('item.kind === "redline"');
  expect(script).toContain("item.stale");
});

// ---------------------------------------------------------------------------
// S-004 — click an HTML highlight → focus its thread; focus a thread → scroll
// the iframe to it + emphasise (C-005 interaction parity, all via the bridge).
// The live click/scroll runs only in a real browser ([→MANUAL]); these assert
// the in-iframe WIRING in the serialized bridge string + the injected focus CSS.
// ---------------------------------------------------------------------------

test("AS-011: the in-iframe bridge wires a [data-anno] mark click → a mark-click port message", () => {
  const script = bridgeScript("n-click");
  // A click listener on the document finds the nearest [data-anno] mark and relays its id UP the
  // trusted port as {type:"mark-click", annotationId} — the parent routes it to focus the rail thread
  // (the parent can't read the opaque iframe DOM, so the relay is the only path — C-001/C-005).
  expect(script).toContain('"mark-click"');
  expect(script).toContain("data-anno");
  // It posts over the port (the trusted transport), not window.postMessage.
  expect(script).toMatch(/port\.postMessage\(\{\s*type:\s*"mark-click"/);
});

test("AS-012: the in-iframe bridge handles a {type:'focus'} message — toggles anno-mark--focus + scrolls", () => {
  const script = bridgeScript("n-focus");
  // On a parent → bridge {type:"focus", annotationId} the bridge emphasises the matching marks
  // (anno-mark--focus toggled on, cleared from others) and scrolls the first matching mark into view.
  expect(script).toContain('"focus"');
  expect(script).toContain("anno-mark--focus");
  expect(script).toContain("scrollIntoView");
});

test("C-005: the injected stylesheet carries the .anno-mark--focus emphasis rule (mirrors styles.css)", () => {
  // The opaque iframe has none of the app tokens, so the focus emphasis must be in the injected
  // sheet — mirrors styles.css `.anno-mark--focus` by value (accent teal #37b3bd, inlined).
  expect(MARK_STYLESHEET).toContain(".anno-mark--focus");
  expect(MARK_STYLESHEET).toContain("#37b3bd"); // --accent inlined
  // injectBridge serves it inside the <style> block.
  const out = injectBridge(injectBlockIds("<p>x</p>"), "n-focus2");
  expect(out).toContain(".anno-mark--focus");
});

// ── S-007: in-iframe client-storage shim (render-publish C-010) ──────────────────────────
// The /v content is served on an opaque origin, where the doc's OWN scripts throw SecurityError
// when they touch localStorage/sessionStorage/caches/BroadcastChannel. The shim replaces those
// with in-memory, per-frame, non-bridged stubs so the doc's scripts run. These tests execute the
// REAL injected shim string against a fake window whose storage getters throw (simulating opaque
// origin), so they exercise the exact artifact shipped to the browser.

/** A fake window whose client-storage getters throw, like an opaque-origin sandbox. */
function opaqueWindow(opts: { idbThrows?: boolean } = {}) {
  const w: any = {};
  const denied = () => {
    throw new Error("SecurityError: storage is not available on an opaque origin");
  };
  for (const key of ["localStorage", "sessionStorage", "caches"]) {
    Object.defineProperty(w, key, { configurable: true, get: denied });
  }
  if (opts.idbThrows) Object.defineProperty(w, "indexedDB", { configurable: true, get: denied });
  // bare `BroadcastChannel` reference inside the shim — passed as a constructor that throws.
  const BC = function () {
    denied();
  } as unknown as typeof BroadcastChannel;
  return { w, BC };
}

/** Run the real STORAGE_SHIM string in a controlled scope (window + BroadcastChannel injected). */
function runShim(w: any, BC: any) {
  // eslint-disable-next-line no-new-func
  const fn = new Function("window", "BroadcastChannel", STORAGE_SHIM);
  fn(w, BC);
}

test("AS-024: a doc's storage-using script runs (read returns null, not a throw) and round-trips", () => {
  const { w, BC } = opaqueWindow();
  runShim(w, BC);
  // the theme-toggle pattern: read a saved preference on load — must NOT throw, returns null when unset.
  expect(w.localStorage.getItem("spec-theme")).toBeNull();
  // set then read back works for the session.
  w.localStorage.setItem("spec-theme", "dark");
  expect(w.localStorage.getItem("spec-theme")).toBe("dark");
  // sessionStorage shimmed too.
  w.sessionStorage.setItem("k", "v");
  expect(w.sessionStorage.getItem("k")).toBe("v");
});

test("AS-024: the shim is a real Storage-shaped Proxy — bracket/dot access and `in` route to the store", () => {
  const { w, BC } = opaqueWindow();
  runShim(w, BC);
  w.localStorage.theme = "dark"; // dot-set
  expect(w.localStorage.theme).toBe("dark"); // dot-get
  expect(w.localStorage["theme"]).toBe("dark"); // bracket-get
  expect("theme" in w.localStorage).toBe(true); // has
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
  // a stubbed cross-tab channel constructs without throwing and accepts a post.
  expect(() => new w.BroadcastChannel("t")).not.toThrow();
});

test("AS-025: stored values are session-only — a fresh frame starts empty (nothing persisted)", () => {
  const a = opaqueWindow();
  runShim(a.w, a.BC);
  a.w.localStorage.setItem("spec-theme", "dark");
  expect(a.w.localStorage.getItem("spec-theme")).toBe("dark");
  // a SECOND frame (fresh shim run) shares nothing — its own in-memory store starts empty.
  const b = opaqueWindow();
  runShim(b.w, b.BC);
  expect(b.w.localStorage.getItem("spec-theme")).toBeNull();
});

test("AS-025: the shim is not bridged — it never reaches the parent/app origin", () => {
  // a non-bridged shim has no channel OUT of the frame: no parent reference, no MessageChannel.
  // (the BroadcastChannel stub's own postMessage is a no-op on a fake object, not a bridge.)
  expect(STORAGE_SHIM).not.toContain("parent");
  expect(STORAGE_SHIM).not.toContain("MessageChannel");
  expect(STORAGE_SHIM).not.toContain(".port");
});

test("AS-026: an unshimmed capability (indexedDB) still degrades without taking down the shimmed ones", () => {
  const { w, BC } = opaqueWindow({ idbThrows: true });
  runShim(w, BC);
  // indexedDB is deliberately NOT stubbed (half-stub hangs/throws under wrapper libs) — still throws.
  expect(() => w.indexedDB).toThrow();
  // but the shimmed storage works — the shim did not crash on the unshimmed one.
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
  // the shim runs BEFORE the doc's own script — otherwise the head/body script already crashed.
  expect(shimAt).toBeLessThan(docScriptAt);
  // inserted just after the <head> open tag.
  expect(out.indexOf("<head>")).toBeLessThan(shimAt);
});

test("S-007: injectStorageShim prepends before the first script when there is no <head>", () => {
  const out = injectStorageShim("<p>hi</p><script>localStorage.x=1</script>", "n2");
  expect(out.indexOf("nonce=\"n2\"")).toBeLessThan(out.indexOf("localStorage.x=1"));
});

test("S-007: the injected shim is static — identical regardless of the doc it wraps (no interpolation)", () => {
  const a = injectStorageShim("<head></head><p>A</p>", "n");
  const b = injectStorageShim("<head></head><div>completely different</div>", "n");
  // extract the shim <script>…</script> from each — they must be byte-identical.
  const grab = (s: string) => s.slice(s.indexOf("<script nonce=\"n\">"), s.indexOf("</script>") + 9);
  expect(grab(a)).toBe(grab(b));
  expect(STORAGE_SHIM).not.toContain("</script"); // static body needs no escaping, carries no close-tag
});

test("AS-026/C-010: the full serve keeps the opaque-origin CSP and never adds allow-same-origin", () => {
  // regression guard: shim is injected into the serve path but the isolation CSP is unchanged.
  const served = injectBridge(injectStorageShim(injectBlockIds("<head></head><p>x</p>"), "ng"), "ng");
  expect(served).toContain("nonce=\"ng\""); // shim present
  expect(CONTENT_SECURITY_POLICY).toContain("sandbox");
  expect(CONTENT_SECURITY_POLICY).toContain("allow-scripts");
  expect(CONTENT_SECURITY_POLICY).not.toContain("allow-same-origin");
  expect(served).not.toContain("allow-same-origin");
});
