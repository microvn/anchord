import { test, expect } from "bun:test";
import { Window } from "happy-dom";
import {
  selectionToAnchor,
  placeAnchor,
  bridgeScript,
  injectBridge,
  generateNonce,
  BLOCK_SELECTOR,
} from "./sandbox-bridge";
import { injectBlockIds } from "./block-id";

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
