import { test, expect } from "bun:test";
import { Window } from "happy-dom";
import {
  selectionToAnchor,
  placeAnchor,
  placeAnchorAll,
  unwrapAnnoMarks,
  locateRange,
  BLOCK_SELECTOR,
} from "./index";

// @anchord/anchor — the ONE shared anchor module (S-005 / C-008). These are the canonical anchor +
// placement unit tests (moved here from the backend sandbox-bridge.test.ts) PLUS the new drift-
// tolerance scenarios AS-014/015/016 + the cross-caller parity assertion. The pure logic is
// exercised against a happy-dom Window — the same code the FE markdown path imports and the in-iframe
// bridge inlines (compiled).

function dom(body: string) {
  const win = new Window();
  win.document.body.innerHTML = body;
  return { doc: win.document as unknown as any, win };
}

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

// ── selection→anchor (round-trips with placeAnchor) ─────────────────────────────────────────────

test("AS-004: selection inside a plain id=\"block-p-1\" block → {blockId,textSnippet,offset,length}", () => {
  const { doc, win } = dom('<p id="block-p-1">Payment expires after 24h</p>');
  const sel = selectChars(win, doc, "p", 8, 15);
  const anchor = selectionToAnchor(sel, doc);
  expect(anchor).not.toBeNull();
  expect(anchor!.blockId).toBe("block-p-1");
  expect(anchor!.textSnippet).toBe("expires");
  expect(anchor!.offset).toBe(8);
  expect(anchor!.length).toBe(7);
});

test("AS-004: data-block-id form resolves the same way (data-block-id wins)", () => {
  const { doc, win } = dom('<p data-block-id="block-p-1" id="authors-own">Payment expires after 24h</p>');
  const sel = selectChars(win, doc, "p", 0, 7);
  const anchor = selectionToAnchor(sel, doc)!;
  expect(anchor.blockId).toBe("block-p-1");
  expect(anchor.textSnippet).toBe("Payment");
});

test("AS-004: placeAnchor round-trips an anchor produced by selectionToAnchor", () => {
  const { doc, win } = dom('<p id="block-p-1">Payment expires after 24h</p>');
  const anchor = selectionToAnchor(selectChars(win, doc, "p", 8, 15), doc)!;
  const placed = placeAnchor(anchor, doc);
  expect(placed.ok).toBe(true);
  if (placed.ok) {
    expect(placed.start).toBe(8);
    expect(placed.end).toBe(15);
    expect(placed.text).toBe("expires");
  }
});

test("AS-004-empty (C-003): collapsed / whitespace-only / no-block / null → null", () => {
  const { doc, win } = dom('<p id="block-p-1">hello world</p>');
  expect(selectionToAnchor(selectChars(win, doc, "p", 3, 3), doc)).toBeNull();
  expect(selectionToAnchor(null, doc)).toBeNull();
  const bare = dom('<span>loose text not in a block</span>');
  expect(selectionToAnchor(selectChars(bare.win, bare.doc, "span", 0, 5), bare.doc)).toBeNull();
});

test("AS-003: duplicate snippet across blocks anchors to the SELECTED block by id", () => {
  const { doc, win } = dom('<p id="block-p-3">see below</p><p id="block-p-9">see below</p>');
  const second = doc.querySelectorAll("p")[1];
  const range = doc.createRange();
  range.setStart(second.firstChild, 0);
  range.setEnd(second.firstChild, 9);
  const sel = win.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  expect(selectionToAnchor(sel as any, doc)!.blockId).toBe("block-p-9");
});

test("AS-003: a cross-block selection emits ONE segment per LEAF block (no nested ancestor)", () => {
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
  expect(anchor.segments!.map((s) => s.blockId)).toEqual(["block-p-1", "block-p-2", "block-p-3"]);
});

test("AS-004-place: cross-block anchor places EACH segment's block, not just the first", () => {
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
  expect(ok.find((p) => p.blockId === "block-p-2")!.text).toBe("second");
});

// ── placeAnchor ladder: exact, shifted (nearest), fuzzy, not-found ──────────────────────────────

test("AS-004-place: exact placement at the recorded offset", () => {
  const { doc } = dom('<p id="block-p-1">Payment expires after 24h</p>');
  const placed = placeAnchor({ blockId: "block-p-1", textSnippet: "expires", offset: 8, length: 7 }, doc);
  expect(placed.ok).toBe(true);
  if (placed.ok) expect(placed.start).toBe(8);
});

test("AS-004-place: snippet present but offset shifted → relocated via nearest", () => {
  const { doc } = dom('<p id="block-p-1">NOTE: Payment expires after 24h</p>');
  const placed = placeAnchor({ blockId: "block-p-1", textSnippet: "expires", offset: 8, length: 7 }, doc);
  expect(placed.ok).toBe(true);
  if (placed.ok) expect(placed.start).toBe(14);
});

test("AS-004-place: block missing → no-block sentinel, never throws", () => {
  const { doc } = dom('<p id="block-p-1">hello</p>');
  let placed: ReturnType<typeof placeAnchor>;
  expect(() => {
    placed = placeAnchor({ blockId: "block-p-99", textSnippet: "hello", offset: 0, length: 5 }, doc);
  }).not.toThrow();
  expect(placed!.ok).toBe(false);
  if (!placed!.ok) expect(placed!.reason).toBe("no-block");
});

test("bridge-serve: BLOCK_SELECTOR matches both block-id attribute forms", () => {
  expect(BLOCK_SELECTOR).toContain("data-block-id");
  expect(BLOCK_SELECTOR).toContain('id^="block-"');
});

// ── unwrapAnnoMarks (clear half of clear-then-redraw) ───────────────────────────────────────────

test("C-002: unwrapAnnoMarks removes every mark[data-anno] and restores the original text", () => {
  const { doc } = dom(
    '<p id="block-p-1">Payment <mark data-anno="a-1" class="anno-mark">expires</mark> after <mark data-anno="a-2" class="anno-mark">24h</mark> total</p>',
  );
  unwrapAnnoMarks(doc as any);
  const p = (doc as any).querySelector("p");
  expect(p.querySelectorAll("mark[data-anno]").length).toBe(0);
  expect(p.textContent).toBe("Payment expires after 24h total");
});

test("C-002: unwrapAnnoMarks leaves a non-anno <mark> untouched + is a no-op when none", () => {
  const { doc } = dom('<p id="block-p-1">a <mark>plain</mark> b <mark data-anno="x" class="anno-mark">anno</mark> c</p>');
  unwrapAnnoMarks(doc as any);
  const p = (doc as any).querySelector("p");
  expect(p.querySelectorAll("mark").length).toBe(1);
  expect(p.querySelector("mark")!.textContent).toBe("plain");
  const clean = dom('<p id="block-p-1">nothing</p>');
  expect(() => unwrapAnnoMarks(clean.doc as any)).not.toThrow();
});

// ── S-005 — NEW drift-tolerance scenarios (the parity GAP-005 closes) ───────────────────────────

test("AS-014: a snippet differing only by collapsed whitespace still places (normalized tier)", () => {
  // Stored snippet carries source indentation/newline ("grace\n      period"); the rendered block
  // collapsed it to "grace period". The whitespace-normalized tier matches it — exactly the
  // tolerance the markdown path has, now in the unified matcher the iframe also uses.
  const blockText = "the grace period is 30 days";
  const snippet = "grace\n      period";
  const r = locateRange(blockText, snippet, 4)!;
  expect(r).not.toBeNull();
  expect(blockText.slice(r.start, r.end)).toBe("grace period");
});

test("AS-014-place: the collapsed-whitespace snippet places via placeAnchor on an HTML block", () => {
  const { doc } = dom('<p id="block-p-1">the grace period is 30 days</p>');
  const placed = placeAnchor(
    { blockId: "block-p-1", textSnippet: "grace\n      period", offset: 4, length: 18 },
    doc,
  );
  expect(placed.ok).toBe(true);
  if (placed.ok) expect(placed.text).toBe("grace period");
});

test("AS-015: a snippet with a small typo still places via the fuzzy tier", () => {
  // "webhook reciever" (typo) vs current "webhook receiver" — above the confidence threshold, so
  // the fuzzy tier places it on the closest span (the markdown path's tolerance, now shared).
  const blockText = "configure the webhook receiver endpoint";
  const r = locateRange(blockText, "webhook reciever", 14)!;
  expect(r).not.toBeNull();
  expect(blockText.slice(r.start, r.end)).toBe("webhook receiver");
});

test("AS-015-place: the typo snippet places via placeAnchor on an HTML block", () => {
  const { doc } = dom('<p id="block-p-1">configure the webhook receiver endpoint</p>');
  const placed = placeAnchor(
    { blockId: "block-p-1", textSnippet: "webhook reciever", offset: 14, length: 16 },
    doc,
  );
  expect(placed.ok).toBe(true);
  if (placed.ok) expect(placed.text).toBe("webhook receiver");
});

test("AS-016: a snippet below the threshold is couldn't-place, NOT force-matched", () => {
  // An unrelated phrase absent from the doc: the fuzzy tier must NOT force a bogus highlight onto
  // unrelated text — it returns not-found (couldn't place).
  const blockText = "the grace period is 30 days";
  expect(locateRange(blockText, "completely unrelated phrase", 0)).toBeNull();
});

test("AS-016-place: an absent snippet → not-found sentinel, never throws, no bogus match", () => {
  const { doc } = dom('<p id="block-p-1">the grace period is 30 days</p>');
  let placed: ReturnType<typeof placeAnchor>;
  expect(() => {
    placed = placeAnchor(
      { blockId: "block-p-1", textSnippet: "completely unrelated phrase", offset: 0, length: 27 },
      doc,
    );
  }).not.toThrow();
  expect(placed!.ok).toBe(false);
});

test("C-008: parity — the SAME (snippet, offset, blockText) resolves identically through placeAnchor regardless of caller", () => {
  // The unified ladder is the single placeAnchor used everywhere (FE markdown + in-iframe bridge).
  // A given input must resolve to the same range no matter which block-id form / doc shape carries
  // it — i.e. there is ONE matcher, not three. Assert the markdown block-id form and the
  // data-block-id (HTML) form locate the identical range for a drift case.
  const blockText = "the grace period is 30 days";
  const snippet = "grace\n      period";
  const offset = 4;

  const md = dom(`<p id="block-p-1">${blockText}</p>`);
  const html = dom(`<p data-block-id="block-p-1" id="authors">${blockText}</p>`);

  const mdPlaced = placeAnchor({ blockId: "block-p-1", textSnippet: snippet, offset, length: snippet.length }, md.doc);
  const htmlPlaced = placeAnchor({ blockId: "block-p-1", textSnippet: snippet, offset, length: snippet.length }, html.doc);

  expect(mdPlaced.ok).toBe(true);
  expect(htmlPlaced.ok).toBe(true);
  if (mdPlaced.ok && htmlPlaced.ok) {
    expect(mdPlaced.start).toBe(htmlPlaced.start);
    expect(mdPlaced.end).toBe(htmlPlaced.end);
    expect(mdPlaced.text).toBe(htmlPlaced.text);
    // and identical to the pure locateRange — proving placeAnchor is just the ladder wrapped.
    const direct = locateRange(blockText, snippet, offset)!;
    expect(mdPlaced.start).toBe(direct.start);
    expect(mdPlaced.end).toBe(direct.end);
  }
});
