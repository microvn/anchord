import { test, expect } from "bun:test";
import {
  reanchorAnnotation,
  reanchorForVersion,
  extractBlockText,
  similarity,
  FUZZY_SIMILARITY_THRESHOLD,
  type ReanchorLedgerRepo,
} from "./reanchor";
import { injectBlockIds } from "./block-id";
import { fuzzyLocate } from "@anchord/anchor";
import type { Anchor } from "./annotation";

/**
 * Probe that packages/anchor/src/locate.ts raised its FUZZY_THRESHOLD to 0.8 (C-002): a window
 * scoring ~0.77 must now be REJECTED (would have been accepted at 0.7), while ~0.88 still passes.
 */
function locateFuzzyThresholdRaised(): boolean {
  // 12-char snippet. 3 substitutions → similarity 0.75 (was accepted at 0.7, must now be REJECTED).
  const below = fuzzyLocate("abcXefYhiZkl", "abcdefghijkl", undefined);
  // 2 substitutions → similarity 0.833 (still ≥ 0.8, must still match).
  const above = fuzzyLocate("abcXefghiZkl", "abcdefghijkl", undefined);
  return below === null && above !== null;
}

// annotation-core S-005 — re-anchor across versions (C-002 ladder + C-012 idempotency).
// Pure logic: anchor + new HTML string → carried/detached. No DB.
//
// The doc is 7 paragraphs so "block-7" in the scenarios maps to block-p-7.

function doc(paras: string[]): string {
  return paras.map((p) => `<p>${p}</p>`).join("");
}

// A 7-paragraph doc where para 7 carries the annotated snippet.
const SEVEN = [
  "intro one",
  "intro two",
  "intro three",
  "intro four",
  "intro five",
  "intro six",
  "Payment expires after 24h",
];

// --- AS-011: exact match → carries ---

test("AS-011: exact match re-anchors to the block in the new version", () => {
  // block-p-7 content unchanged → exact snippet still present → carries to block-p-7.
  const anchor: Anchor = {
    blockId: "block-p-7",
    textSnippet: "expires after 24h",
    offset: 8,
    length: 17,
  };
  const newHtml = doc(SEVEN); // unchanged
  const r = reanchorAnnotation(anchor, newHtml);

  expect(r.status).toBe("carried");
  if (r.status === "carried") {
    expect(r.anchor.blockId).toBe("block-p-7");
    expect(r.anchor.textSnippet).toBe("expires after 24h");
    // Offset recomputed against the new block text ("Payment expires after 24h").
    expect(r.anchor.offset).toBe("Payment ".length);
    expect(r.anchor.length).toBe("expires after 24h".length);
  }
});

// --- AS-012: fuzzy match → carries ---

test("AS-012: fuzzy match (small change 24h→48 hours) within the block still carries", () => {
  const anchor: Anchor = {
    blockId: "block-p-7",
    textSnippet: "Payment expires after 24h",
    offset: 0,
    length: 25,
  };
  // Same block, snippet changed slightly: "24h" → "48 hours".
  const changed = [...SEVEN.slice(0, 6), "Payment expires after 48 hours"];
  const r = reanchorAnnotation(anchor, doc(changed));

  expect(r.status).toBe("carried");
  if (r.status === "carried") {
    expect(r.anchor.blockId).toBe("block-p-7");
    // The carried snippet tracks real text in the NEW block.
    expect("Payment expires after 48 hours").toContain(r.anchor.textSnippet.slice(0, 7));
  }
});

test("AS-012: fuzzy below threshold (block exists but unrelated text) → orphaned", () => {
  const anchor: Anchor = {
    blockId: "block-p-7",
    textSnippet: "Payment expires after 24h",
    offset: 0,
    length: 25,
  };
  const replaced = [...SEVEN.slice(0, 6), "Completely different sentence about refunds"];
  const r = reanchorAnnotation(anchor, doc(replaced));
  expect(r.status).toBe("orphaned");
});

// --- AS-013: lost block → detached ---

test("AS-013: lost block → is_orphaned, goes to detached (not lost)", () => {
  const anchor: Anchor = {
    blockId: "block-p-7",
    textSnippet: "Payment expires after 24h",
    offset: 0,
    length: 25,
  };
  // block-p-7 fully deleted: only 6 paragraphs remain.
  const r = reanchorAnnotation(anchor, doc(SEVEN.slice(0, 6)));
  expect(r.status).toBe("orphaned");
});

// --- AS-018: multi_range losing one segment → whole detaches ---

test("AS-018: multi_range losing one segment → the WHOLE annotation detaches (no partial)", () => {
  // Spans block-p-3 and block-p-9. New version deletes block-p-9 but keeps block-p-3.
  const nine = Array.from({ length: 9 }, (_, i) =>
    i === 2 ? "segment alpha here" : i === 8 ? "segment bravo here" : `filler ${i + 1}`,
  );
  const anchor: Anchor = {
    blockId: "block-p-3",
    textSnippet: "segment alpha here",
    offset: 0,
    length: 18,
    segments: [
      { blockId: "block-p-3", textSnippet: "segment alpha here", offset: 0, length: 18 },
      { blockId: "block-p-9", textSnippet: "segment bravo here", offset: 0, length: 18 },
    ],
  };
  // New version: only 8 paragraphs → block-p-9 gone, block-p-3 still matches exactly.
  const newDoc = doc(nine.slice(0, 8));

  // sanity: block-p-3 alone would still match.
  expect(extractBlockText(injectBlockIds(newDoc), "block-p-3")).toBe("segment alpha here");
  expect(extractBlockText(injectBlockIds(newDoc), "block-p-9")).toBeNull();

  const r = reanchorAnnotation(anchor, newDoc);
  // All-or-nothing: whole annotation orphans, no partial carry of block-p-3.
  expect(r.status).toBe("orphaned");
});

test("AS-018: multi_range with ALL segments intact → carries with both segments", () => {
  const nine = Array.from({ length: 9 }, (_, i) =>
    i === 2 ? "segment alpha here" : i === 8 ? "segment bravo here" : `filler ${i + 1}`,
  );
  const anchor: Anchor = {
    blockId: "block-p-3",
    textSnippet: "segment alpha here",
    offset: 0,
    length: 18,
    segments: [
      { blockId: "block-p-3", textSnippet: "segment alpha here", offset: 0, length: 18 },
      { blockId: "block-p-9", textSnippet: "segment bravo here", offset: 0, length: 18 },
    ],
  };
  const r = reanchorAnnotation(anchor, doc(nine)); // unchanged
  expect(r.status).toBe("carried");
  if (r.status === "carried") {
    expect(r.anchor.segments).toHaveLength(2);
    expect(r.anchor.segments?.[1].blockId).toBe("block-p-9");
  }
});

// --- C-002: the full ladder + all-or-nothing, asserted as one named contract ---

test("C-002: re-anchor ladder block_id→exact→fuzzy→orphan; multi_range all-or-nothing", () => {
  const base: Omit<Anchor, "textSnippet"> = { blockId: "block-p-7", offset: 0, length: 5 };

  // block_id + exact snippet → carried.
  expect(reanchorAnnotation({ ...base, textSnippet: "Payment expires after 24h" }, doc(SEVEN)).status).toBe("carried");
  // block exists, snippet slightly changed → fuzzy carried.
  expect(
    reanchorAnnotation(
      { ...base, textSnippet: "Payment expires after 24h" },
      doc([...SEVEN.slice(0, 6), "Payment expires after 48 hours"]),
    ).status,
  ).toBe("carried");
  // block exists, unrelated text → orphan.
  expect(
    reanchorAnnotation(
      { ...base, textSnippet: "Payment expires after 24h" },
      doc([...SEVEN.slice(0, 6), "wholly unrelated content x"]),
    ).status,
  ).toBe("orphaned");
  // block gone → orphan.
  expect(
    reanchorAnnotation({ ...base, textSnippet: "Payment expires after 24h" }, doc(SEVEN.slice(0, 6))).status,
  ).toBe("orphaned");

  // multi_range all-or-nothing: one good segment + one lost segment → orphan.
  const multi: Anchor = {
    blockId: "block-p-1",
    textSnippet: "intro one",
    offset: 0,
    length: 9,
    segments: [
      { blockId: "block-p-1", textSnippet: "intro one", offset: 0, length: 9 },
      { blockId: "block-p-7", textSnippet: "Payment expires after 24h", offset: 0, length: 25 },
    ],
  };
  expect(reanchorAnnotation(multi, doc(SEVEN.slice(0, 6))).status).toBe("orphaned");
});

// --- C-012: idempotency by (annotation_id, version_id) ledger ---

test("C-012: re-anchor is idempotent by (annotation_id, version_id) — run twice = identical, no dup ledger", () => {
  const annotations = [
    { id: "a1", anchor: { blockId: "block-p-7", textSnippet: "Payment expires after 24h", offset: 0, length: 25 } },
    { id: "a2", anchor: { blockId: "block-p-99", textSnippet: "gone", offset: 0, length: 4 } }, // orphans
  ];
  const newHtml = doc(SEVEN);

  const run1 = reanchorForVersion({ annotations, newContentHtml: newHtml, versionId: "v2" });
  const run2 = reanchorForVersion({ annotations, newContentHtml: newHtml, versionId: "v2" });

  // Identical result across runs.
  expect(run2).toEqual(run1);
  // a1 carried, a2 detached — never lost.
  expect(run1.carried.map((c) => c.id)).toEqual(["a1"]);
  expect(run1.detached.map((d) => d.id)).toEqual(["a2"]);
  // One ledger entry per (annotation_id, versionId) — no double-apply.
  expect(run1.ledger).toHaveLength(2);
  expect(run1.ledger.filter((e) => e.annotationId === "a1")).toHaveLength(1);

  // A persisted prior-run ledger short-circuits recomputation (no double-apply).
  const stored = new Map(run1.ledger.map((e) => [`${e.annotationId}::${e.versionId}`, e]));
  const repo: ReanchorLedgerRepo = {
    getEntry: (id, v) => stored.get(`${id}::${v}`),
  };
  const run3 = reanchorForVersion({ annotations, newContentHtml: newHtml, versionId: "v2" }, repo);
  expect(run3).toEqual(run1);
});

// --- GAP-001: fuzzy threshold is a working, overridable default ---

test("GAP-001: fuzzy threshold is a named default and is honored (tuning deferred)", () => {
  expect(FUZZY_SIMILARITY_THRESHOLD).toBeGreaterThan(0);
  expect(FUZZY_SIMILARITY_THRESHOLD).toBeLessThanOrEqual(1);

  const anchor: Anchor = { blockId: "block-p-7", textSnippet: "Payment expires after 24h", offset: 0, length: 25 };
  const slightlyChanged = doc([...SEVEN.slice(0, 6), "Payment expires after 48 hours"]);

  // With an impossibly strict threshold, even the small change orphans.
  expect(reanchorAnnotation(anchor, slightlyChanged, { fuzzyThreshold: 0.99 }).status).toBe("orphaned");
  // With the default it carries.
  expect(reanchorAnnotation(anchor, slightlyChanged).status).toBe("carried");
});

// --- edge: empty/whitespace block text and similarity bounds ---

test("C-002: edge — empty new content orphans (no block to match), annotation preserved", () => {
  const anchor: Anchor = { blockId: "block-p-7", textSnippet: "anything", offset: 0, length: 8 };
  expect(reanchorAnnotation(anchor, "").status).toBe("orphaned");

  // And via the version path the annotation lands in detached (never lost).
  const res = reanchorForVersion({
    annotations: [{ id: "x", anchor }],
    newContentHtml: "",
    versionId: "v9",
  });
  expect(res.detached.map((d) => d.id)).toEqual(["x"]);
  expect(res.carried).toHaveLength(0);
});

// --- C-011: ONE canonical text extractor (no divergent string-regex path) ---

test("C-011: extractBlockText decodes entities + strips comments (canonical DOM extractor, not regex)", () => {
  // The old string-regex extractor (`inner.replace(/<[^>]*>/g, "")`) did NOT decode entities or strip
  // comments, so an offset computed at create (via the shared DOM walk) could resolve to DIFFERENT
  // text at re-anchor. The unified extractor walks the DOM's text nodes (the SAME walk the shared
  // module / in-iframe placement use), so `&amp;` becomes `&` and a comment contributes no text.
  const html = injectBlockIds("<p>Tom &amp; Jerry<!-- a note --> rule</p>");
  const text = extractBlockText(html, "block-p-1");
  expect(text).not.toBeNull();
  expect(text).toContain("Tom & Jerry"); // entity decoded
  expect(text).not.toContain("&amp;"); // not the raw entity
  expect(text).not.toContain("a note"); // comment excluded
  expect(text).toContain("rule");
});

test("C-011: extractBlockText excludes script/style content from a block's text", () => {
  const html = injectBlockIds("<div>Body<script>var x=1;</script><style>.a{color:red}</style> tail</div>");
  const text = extractBlockText(html, "block-div-1")!;
  expect(text).toContain("Body");
  expect(text).toContain("tail");
  expect(text).not.toContain("var x=1");
  expect(text).not.toContain("color:red");
});

test("C-011: an exact snippet still re-anchors through the unified extractor (behaviour preserved)", () => {
  // The unification must not regress the existing exact-match carry: block text the DOM walk yields
  // matches the stored snippet → carried at the recomputed offset.
  const anchor: Anchor = { blockId: "block-p-7", textSnippet: "expires after 24h", offset: 8, length: 17 };
  const r = reanchorAnnotation(anchor, doc(SEVEN));
  expect(r.status).toBe("carried");
  if (r.status === "carried") expect(r.anchor.textSnippet).toBe("expires after 24h");
});

test("similarity is bounded [0,1]: identical=1, fully-different<1, empty/empty=1", () => {
  expect(similarity("abc", "abc")).toBe(1);
  expect(similarity("", "")).toBe(1);
  expect(similarity("abc", "xyz")).toBeLessThan(1);
  expect(similarity("abc", "xyz")).toBeGreaterThanOrEqual(0);
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// annotation-reanchor S-001 — re-anchor by CONTENT, not position. block_id is a HINT; on a miss
// or a structural shift the matcher locates text_snippet over the WHOLE doc; detach only when the
// text is genuinely gone. Deleting/moving UNRELATED content never detaches.
// ════════════════════════════════════════════════════════════════════════════════════════════

// A 3-column refund table. Each <td> becomes block-td-N in DOM order (1-based per tag).
function refundTable(rows: [string, string, string][]): string {
  const body = rows
    .map(([a, b, c]) => `<tr><td>${a}</td><td>${b}</td><td>${c}</td></tr>`)
    .join("");
  return `<table>${body}</table>`;
}

// --- AS-001: fast path — unchanged structure carries via the block hint (method "exact") ---

test("AS-001: fast path — block_id hint resolves, snippet unchanged → carries within that block, method exact", () => {
  const anchor: Anchor = {
    blockId: "block-p-7",
    textSnippet: "expires after 24h",
    offset: 8,
    length: 17,
    prefix: "Payment ",
    suffix: "",
  };
  const r = reanchorAnnotation(anchor, doc(SEVEN)); // unchanged
  expect(r.status).toBe("carried");
  if (r.status === "carried") {
    expect(r.anchor.blockId).toBe("block-p-7"); // stayed in the hinted block
    expect(r.anchor.textSnippet).toBe("expires after 24h");
    expect(r.method).toBe("exact"); // hint path, exact tier
  }
});

// --- AS-002: structural shift no longer cascades — renumbered cells carry via whole-doc text ---

test("AS-002: deleting an EARLIER table row no longer cascades — both annotations carry via whole-doc", () => {
  // v1: 3 rows. capture_id is block-td-5 (row2 col2); refund_id is block-td-8 (row3 col2).
  const v1 = refundTable([
    ["transaction_id", "txn_001", "the txn key"],
    ["capture_id", "cap_777", "the capture key"],
    ["refund_id", "ref_999", "the refund key"],
  ]);
  // Confirm the v1 block ids the annotations were created against.
  expect(extractBlockText(injectBlockIds(v1), "block-td-5")).toBe("cap_777");
  expect(extractBlockText(injectBlockIds(v1), "block-td-8")).toBe("ref_999");

  // Two annotations created on v1, each storing its positional block_id hint + table context.
  const captureAnno: Anchor = {
    blockId: "block-td-5",
    textSnippet: "cap_777",
    offset: 0,
    length: 7,
    prefix: "",
    suffix: "",
  };
  const refundAnno: Anchor = {
    blockId: "block-td-8",
    textSnippet: "ref_999",
    offset: 0,
    length: 7,
    prefix: "",
    suffix: "",
  };

  // v2: the FIRST row (transaction_id) is deleted. Now capture row is row1, refund row is row2 —
  // every later cell's positional block-td-N SHIFTS UP by 3. The hints now point at the WRONG cells.
  const v2 = refundTable([
    ["capture_id", "cap_777", "the capture key"],
    ["refund_id", "ref_999", "the refund key"],
  ]);
  // block-td-5 in v2 is now "ref_999" (not cap_777) — the hint genuinely misses for the capture anno.
  expect(extractBlockText(injectBlockIds(v2), "block-td-5")).toBe("ref_999");
  // block-td-8 no longer exists in v2 (only 6 cells) — the refund hint misses entirely.
  expect(extractBlockText(injectBlockIds(v2), "block-td-8")).toBeNull();

  const rc = reanchorAnnotation(captureAnno, v2);
  const rr = reanchorAnnotation(refundAnno, v2);

  // Neither cascades to orphan: each locates its own cell over the whole doc and carries.
  expect(rc.status).toBe("carried");
  expect(rr.status).toBe("carried");
  if (rc.status === "carried") expect(rc.anchor.textSnippet).toBe("cap_777");
  if (rr.status === "carried") expect(rr.anchor.textSnippet).toBe("ref_999");
});

// --- AS-003: genuinely deleted block detaches WITHOUT mis-anchoring to a coincidental mention ---

test("AS-003: deleted cell with the same word in prose elsewhere → detaches, never carries onto the prose mention", () => {
  // v1: a table whose first cell is the annotated "transaction_id" key, with TABLE context.
  const v1 =
    refundTable([
      ["transaction_id", "txn_001", "the txn key"],
      ["capture_id", "cap_777", "the capture key"],
    ]) + "<p>Unrelated intro paragraph.</p>";
  expect(extractBlockText(injectBlockIds(v1), "block-td-1")).toBe("transaction_id");

  // Annotation on the cell — its stored prefix/suffix are the TABLE-cell context (empty siblings,
  // since the <td> holds only the word). Captured at selection time per C-004.
  const anno: Anchor = {
    blockId: "block-td-1",
    textSnippet: "transaction_id",
    offset: 0,
    length: 14,
    prefix: "",
    suffix: "",
  };

  // v2: the transaction_id ROW is deleted, but the word survives in a PROSE paragraph whose
  // surrounding context is totally different from the bare cell.
  const v2 =
    refundTable([["capture_id", "cap_777", "the capture key"]]) +
    "<p>We renamed the field transaction_id to payment_ref last quarter.</p>";

  const r = reanchorAnnotation(anno, v2);
  // The prose mention sits in non-empty context ("…field " before, " to payment…" after); the stored
  // bare-cell context fails to match → the annotation detaches rather than carrying onto the prose.
  expect(r.status).toBe("orphaned");
});

// --- AS-004: a moved block carries (whole-doc locate is position-independent), method "exact" ---

test("AS-004: a paragraph moved from top to bottom (text unchanged) carries, method exact", () => {
  const moved = "The quick brown fox jumps over the lazy dog here";
  // v1: the annotated paragraph is the FIRST block (block-p-1).
  const v1 = doc([moved, "filler a", "filler b", "filler c"]);
  expect(extractBlockText(injectBlockIds(v1), "block-p-1")).toBe(moved);
  const anno: Anchor = {
    blockId: "block-p-1",
    textSnippet: "quick brown fox",
    offset: 4,
    length: 15,
    prefix: "The ",
    suffix: " jumps",
  };

  // v2: the same paragraph is moved to the BOTTOM (now block-p-4); block-p-1 is different text.
  const v2 = doc(["filler a", "filler b", "filler c", moved]);
  expect(extractBlockText(injectBlockIds(v2), "block-p-1")).toBe("filler a"); // hint now wrong

  const r = reanchorAnnotation(anno, v2);
  expect(r.status).toBe("carried");
  if (r.status === "carried") {
    expect(r.anchor.blockId).toBe("block-p-4"); // followed the moved text, not the position
    expect(r.anchor.textSnippet).toBe("quick brown fox");
    expect(r.method).toBe("exact");
  }
});

// --- AS-005: a minor reword within threshold carries via the fuzzy tier (method "fuzzy") ---

test("AS-005: minor reword (24h → 24 hours) with surrounding text intact → carries fuzzy", () => {
  const before = "The payment window is 24h before it expires";
  const after = "The payment window is 24 hours before it expires";
  const anno: Anchor = {
    blockId: "block-p-1",
    textSnippet: before,
    offset: 0,
    length: before.length,
    prefix: "",
    suffix: "",
  };
  const r = reanchorAnnotation(anno, doc([after]));
  expect(r.status).toBe("carried");
  if (r.status === "carried") {
    expect(r.method).toBe("fuzzy");
    expect(similarity(before, after)).toBeGreaterThanOrEqual(FUZZY_SIMILARITY_THRESHOLD);
  }
});

// --- AS-006: below-threshold change detaches, never force-matches the closest text ---

test("AS-006: a wholesale reword below threshold detaches, NOT force-anchored to the closest text", () => {
  const before = "Refunds are processed within three business days of approval";
  // Completely reworded sentence in the same block — no window clears 0.8.
  const after = "Customers may cancel their subscription at any time from settings";
  const anno: Anchor = {
    blockId: "block-p-1",
    textSnippet: before,
    offset: 0,
    length: before.length,
    prefix: "",
    suffix: "",
  };
  expect(similarity(before, after)).toBeLessThan(FUZZY_SIMILARITY_THRESHOLD); // below the bar
  const r = reanchorAnnotation(anno, doc([after]));
  expect(r.status).toBe("orphaned"); // honest detach, never a forced carry
});

// --- C-001: block_id is a HINT not a gate — whole-doc fallback fires on a hint miss ---

test("C-001: block_id is a hint — a stale/wrong block_id still re-anchors via whole-doc text", () => {
  // The stored block_id points at a block that doesn't even exist in the new doc, yet the text is
  // present in another block → carries (the hint is advisory, the text is durable).
  const anno: Anchor = {
    blockId: "block-p-999", // nonexistent hint
    textSnippet: "Payment expires after 24h",
    offset: 0,
    length: 25,
    prefix: "",
    suffix: "",
  };
  const r = reanchorAnnotation(anno, doc(SEVEN)); // the text lives in block-p-7
  expect(r.status).toBe("carried");
  if (r.status === "carried") expect(r.anchor.blockId).toBe("block-p-7");
});

// --- C-002: the ladder order + raised 0.8 fuzzy threshold, asserted as one contract ---

test("C-002: ladder hint→whole-doc, first hit wins; fuzzy threshold raised to 0.8 in both modules", () => {
  expect(FUZZY_SIMILARITY_THRESHOLD).toBe(0.8); // raised from 0.7 (reanchor.ts)
  expect(locateFuzzyThresholdRaised()).toBe(true); // raised from 0.7 (packages/anchor/src/locate.ts)

  const base = { offset: 0, length: 9, prefix: "", suffix: "" };
  // (1) hint exact → carried in the hinted block.
  expect(reanchorAnnotation({ ...base, blockId: "block-p-1", textSnippet: "intro one" }, doc(SEVEN)).status).toBe("carried");
  // (2) hint misses but whole-doc exact → carried elsewhere.
  expect(reanchorAnnotation({ ...base, blockId: "block-p-99", textSnippet: "intro one" }, doc(SEVEN)).status).toBe("carried");
  // (3) nothing locates → detached.
  expect(reanchorAnnotation({ ...base, blockId: "block-p-99", textSnippet: "nowhere to be found at all" }, doc(SEVEN)).status).toBe("orphaned");
});

// --- C-004: prefix/suffix used when present; an anchor lacking them degrades (no crash) ---

test("C-004: an OLD anchor lacking prefix/suffix still re-anchors (degrades to snippet+offset)", () => {
  // No prefix/suffix fields at all — the today-anchor shape. Must not crash and must carry.
  const oldAnchor: Anchor = {
    blockId: "block-p-7",
    textSnippet: "Payment expires after 24h",
    offset: 0,
    length: 25,
  };
  const r = reanchorAnnotation(oldAnchor, doc(SEVEN));
  expect(r.status).toBe("carried");
});

test("C-004: stored context IS used to reject a coincidental whole-doc match", () => {
  // The same short word "key" appears in two blocks. The annotation's stored context matches only
  // the SECOND. With the hint pointing nowhere, the whole-doc fallback must pick the context match,
  // not the first occurrence — and if NEITHER context matches it detaches (precision).
  const html = doc(["the primary key here", "a foreign key there"]);
  // Annotation on "key" with context that matches NEITHER block (so it must detach, proving context
  // is actually consulted rather than first-match-wins).
  const anno: Anchor = {
    blockId: "block-p-99",
    textSnippet: "key",
    offset: 0,
    length: 3,
    prefix: "wildly different ",
    suffix: " context entirely",
  };
  const r = reanchorAnnotation(anno, html);
  expect(r.status).toBe("orphaned"); // context consulted → no force-match onto either "key"
});

// --- C-006: multi_range stays all-or-nothing under the new whole-doc ladder ---

test("C-006: multi_range under the new ladder — one segment lost → whole detaches (all-or-nothing)", () => {
  // Two segments. v2 keeps segment-1's text (moved) but DELETES segment-2's text entirely.
  const anchor: Anchor = {
    blockId: "block-p-1",
    textSnippet: "segment alpha here",
    offset: 0,
    length: 18,
    segments: [
      { blockId: "block-p-1", textSnippet: "segment alpha here", offset: 0, length: 18, prefix: "", suffix: "" },
      { blockId: "block-p-2", textSnippet: "segment bravo here", offset: 0, length: 18, prefix: "", suffix: "" },
    ],
  };
  // segment-1 text moved to the bottom (whole-doc would carry it); segment-2 text is GONE.
  const v2 = doc(["filler", "filler two", "segment alpha here"]);
  const r = reanchorAnnotation(anchor, v2);
  expect(r.status).toBe("orphaned"); // any segment lost → whole annotation detaches.
});

test("C-006: multi_range — ALL segments locatable whole-doc (even moved) → carries with both", () => {
  const anchor: Anchor = {
    blockId: "block-p-1",
    textSnippet: "segment alpha here",
    offset: 0,
    length: 18,
    segments: [
      { blockId: "block-p-1", textSnippet: "segment alpha here", offset: 0, length: 18, prefix: "", suffix: "" },
      { blockId: "block-p-2", textSnippet: "segment bravo here", offset: 0, length: 18, prefix: "", suffix: "" },
    ],
  };
  // Both texts present but blocks reordered → each carries via whole-doc locate.
  const v2 = doc(["filler", "segment bravo here", "filler two", "segment alpha here"]);
  const r = reanchorAnnotation(anchor, v2);
  expect(r.status).toBe("carried");
  if (r.status === "carried") expect(r.anchor.segments).toHaveLength(2);
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// annotation-reanchor S-002 — disambiguate a DUPLICATE quote in the whole-doc fallback. When the
// snippet locates in MORE THAN ONE block, pick the right occurrence by stored prefix/suffix
// context, then nearest stored offset, then innermost (most specific) block — NOT first-in-doc.
// ════════════════════════════════════════════════════════════════════════════════════════════

// --- AS-007: prefix/suffix + nearest-offset pick the correct duplicate, NOT the first ---

test("AS-007: a duplicate quote in two blocks carries to the context-matching one, NOT the first", () => {
  // "see below" appears in two paragraphs. The annotation was on the SECOND occurrence; its stored
  // prefix/suffix is that block's context. The block_id hint has shifted, so the fallback runs
  // doc-wide and finds BOTH. A first-match-wins matcher would carry to block-p-1 (the first) and
  // FAIL this test; the context gate must steer it to block-p-2.
  const v2 = doc([
    "For the rate limits see below in the appendix",
    "For the retry policy see below near the footer",
  ]);
  const anno: Anchor = {
    blockId: "block-p-99", // hint shifted/missing → whole-doc fallback fires
    textSnippet: "see below",
    offset: 0,
    length: 9,
    // Context of the SECOND occurrence: "…retry policy " before, " near the footer" after.
    prefix: "the retry policy ",
    suffix: " near the footer",
  };
  const r = reanchorAnnotation(anno, v2);
  expect(r.status).toBe("carried");
  if (r.status === "carried") {
    // The decisive assertion: it landed on the SECOND block, not the first-in-document occurrence.
    expect(r.anchor.blockId).toBe("block-p-2");
    expect(r.anchor.textSnippet).toBe("see below");
  }
});

test("AS-007: ties broken toward the occurrence nearest the stored offset (context equal)", () => {
  // Two blocks both contain "see below" with the SAME (empty) surrounding context — so the
  // prefix/suffix gate can't separate them. The stored offset is large, biasing toward the LATER
  // occurrence within whichever block; but across blocks the offset tie-break must steer to the
  // block whose match start is nearest the stored offset. Here block-p-2's snippet sits at a higher
  // offset than block-p-1's, and the stored offset is high → must pick block-p-2, not the first.
  const v2 = doc([
    "see below", // block-p-1: snippet at offset 0
    "xxxxxxxxxxxxxxxxxxxxxxxxxx see below", // block-p-2: snippet at offset 26
  ]);
  const anno: Anchor = {
    blockId: "block-p-99",
    textSnippet: "see below",
    offset: 26, // nearest to block-p-2's occurrence
    length: 9,
    // Context that matches BOTH (empty before, empty after won't hold here) — use undefined so the
    // gate degrades and offset is the sole disambiguator.
  };
  const r = reanchorAnnotation(anno, v2);
  expect(r.status).toBe("carried");
  if (r.status === "carried") {
    expect(r.anchor.blockId).toBe("block-p-2"); // nearest-offset wins the tie, NOT first-in-doc
  }
});

// --- C-003: nested-block specificity — a cell snippet that also appears in the parent's
//            concatenated text anchors to the CELL, not the table/row container ---

test("C-003: a cell snippet present in the parent's concatenated text anchors to the cell, not the table/row", () => {
  // extractAllBlocks enumerates the <table>, the <tr>, AND the <td>. The <table>'s concatenated
  // text ("alpha beta gamma") contains the cell snippet "beta", as does the <tr>. A naive
  // first-in-document, method-only ranking could carry onto the <table> (block-table-1, which is
  // emitted first). The matcher must prefer the most SPECIFIC (innermost / smallest) block that
  // contains the match — the actual <td>.
  // The annotated cell is the FIRST cell, so its snippet sits at offset 0 of BOTH the <td> text
  // AND the parent <table>/<tr> concatenated text — meaning the parent matches EXACTLY too (same
  // method tier, offset 0). Method-rank + nearest-offset cannot separate them; only the
  // innermost/specificity preference can. A non-specificity-aware impl carries onto block-table-1
  // (emitted first) and FAILS.
  // The cell holds exactly "beta" so the snippet is exact-at-offset-0 in the <td>, AND the parent
  // <table>/<tr> concatenated text ("betaother") also has "beta" exact at offset 0. Same method
  // tier, same offset → neither method-rank nor nearest-offset can separate them; only the
  // innermost/specificity preference can. Context is left undefined (degrades), so specificity is
  // the SOLE discriminator. A non-specificity-aware impl carries onto block-table-1 and FAILS.
  const v2 = "<table><tr><td>beta</td><td>other</td></tr></table>";
  const tableText = extractBlockText(injectBlockIds(v2), "block-table-1")!;
  expect(tableText.startsWith("beta")).toBe(true); // parent also exact at offset 0
  const anno: Anchor = {
    blockId: "block-td-99", // hint missing → whole-doc fallback over table/tr/td
    textSnippet: "beta",
    offset: 0,
    length: 4,
    // prefix/suffix intentionally absent: context degrades, specificity must decide.
  };
  const r = reanchorAnnotation(anno, v2);
  expect(r.status).toBe("carried");
  if (r.status === "carried") {
    expect(r.anchor.blockId).toBe("block-td-1"); // the cell, NOT block-table-1 / block-tr-1
    expect(r.anchor.textSnippet).toBe("beta");
  }
});

// ===========================================================================
// mcp-patch-document:S-004 / C-005 — deterministic carry across a block-addressed patch.
//
// When a patch supplies the set of changed block-ids, annotations on UNTOUCHED blocks carry
// forward WITHOUT the fuzzy matcher (the patch already named what changed); only annotations on
// an edited block run the existing matcher. A whole-doc publish (no changed set) keeps the full
// matcher unchanged. These tests drive reanchorForVersion directly with `changedBlockIds`.
// ===========================================================================

// A 7-paragraph doc: block-p-5 = "intro five", block-p-7 carries the payment snippet. The h2
// scenarios use a heading doc so block-h2-1 exists.
const HEADING_DOC = "<h2>Overview</h2><p>alpha body</p><p>beta body</p>";

test("AS-019: annotation on an UNTOUCHED block carries deterministically (matcher NOT invoked)", () => {
  // The patch edited ONLY block-h2-1; the annotation lives on block-p-5. Crucially, the NEW
  // version's block-p-5 text is REPLACED so the stored snippet would NOT fuzzy-match — yet the
  // anchor must be carried BYTE-IDENTICAL, which is only possible if the matcher was skipped.
  const p5Anchor: Anchor = { blockId: "block-p-5", textSnippet: "intro five", offset: 0, length: 10 };
  // New content: block-p-5's text is now completely different ("XXXXXXXXXX") → a real matcher run
  // on this block would orphan the annotation. Deterministic carry must keep it unchanged.
  const newDoc = doc(["a", "b", "c", "d", "XXXXXXXXXX", "f", "Payment expires after 24h"]);

  const r = reanchorForVersion({
    annotations: [{ id: "a-p5", anchor: p5Anchor }],
    newContentHtml: newDoc,
    versionId: "doc:2",
    changedBlockIds: ["block-h2-1"], // block-p-5 is NOT changed
  });

  // Carried (never detached), with the anchor byte-identical to the input → proves no matcher.
  expect(r.detached).toEqual([]);
  expect(r.carried).toHaveLength(1);
  expect(r.carried[0]!.id).toBe("a-p5");
  expect(r.carried[0]!.anchor).toEqual(p5Anchor); // unchanged offset/snippet → matcher skipped.
  // Ledger records a carried entry (C-012 idempotency) with method exact / confidence 1.
  expect(r.ledger).toHaveLength(1);
  expect(r.ledger[0]).toMatchObject({ annotationId: "a-p5", versionId: "doc:2", status: "carried", confidence: 1 });
});

test("AS-020: annotation on an EDITED block runs the existing matcher (carried-or-orphaned per ladder)", () => {
  // The patch edited block-h2-1 which carries an annotation. The new block-h2-1 text differs
  // enough that the matcher OUTPUT (not a passthrough) decides the fate — here the heading text
  // is unchanged so it carries via the matcher with a RECOMPUTED anchor (offset re-derived).
  const headingAnchor: Anchor = { blockId: "block-h2-1", textSnippet: "Overview", offset: 0, length: 8 };
  const r = reanchorForVersion({
    annotations: [{ id: "a-h2", anchor: headingAnchor }],
    newContentHtml: HEADING_DOC, // block-h2-1 text "Overview" still present
    versionId: "doc:2",
    changedBlockIds: ["block-h2-1"], // edited → must go through the matcher
  });
  // Matcher carried it. The ledger method reflects the ladder tier (exact), NOT the deterministic
  // stub — for an exact-at-offset hit that is also "exact", so we additionally prove the matcher
  // ran by orphaning a SECOND annotation whose snippet is absent from the edited block.
  expect(r.carried.map((c) => c.id)).toEqual(["a-h2"]);

  // Now an annotation on the edited block whose stored text is GONE → matcher orphans it. A
  // deterministic carry would have (wrongly) kept it; orphaning proves the matcher ran.
  const goneAnchor: Anchor = { blockId: "block-h2-1", textSnippet: "Nonexistent phrase", offset: 0, length: 18 };
  const r2 = reanchorForVersion({
    annotations: [{ id: "a-gone", anchor: goneAnchor }],
    newContentHtml: HEADING_DOC,
    versionId: "doc:2",
    changedBlockIds: ["block-h2-1"],
  });
  expect(r2.detached.map((d) => d.id)).toEqual(["a-gone"]); // matcher ran → orphaned (not carried).
  expect(r2.carried).toEqual([]);
});

test("AS-021: a whole-doc update (NO changed set) still runs the FULL matcher (no regression)", () => {
  // No changedBlockIds → the deterministic-carry path is NOT taken; every annotation runs the
  // full fuzzy matcher exactly as today. Proof: an annotation whose block text was REPLACED
  // orphans (a deterministic carry would have kept it).
  const p5Anchor: Anchor = { blockId: "block-p-5", textSnippet: "intro five", offset: 0, length: 10 };
  const newDoc = doc(["a", "b", "c", "d", "XXXXXXXXXX", "f", "Payment expires after 24h"]);
  const r = reanchorForVersion({
    annotations: [{ id: "a-p5", anchor: p5Anchor }],
    newContentHtml: newDoc,
    versionId: "doc:2",
    // changedBlockIds intentionally OMITTED — the whole-doc path.
  });
  // Full matcher ran: "intro five" is gone from block-p-5 and not elsewhere → orphaned.
  expect(r.detached.map((d) => d.id)).toEqual(["a-p5"]);
  expect(r.carried).toEqual([]);
});

test("AS-022: a multi-range annotation with ANY segment in an edited block runs the matcher (C-005 straddle)", () => {
  // Two segments: one in block-p-1, one in block-p-2. The patch edited ONLY block-p-1. The WHOLE
  // annotation must run the matcher (NOT deterministic carry), even though its block-p-2 segment
  // is in an unchanged block. Proof: block-p-1's segment text was replaced → the whole annotation
  // orphans (all-or-nothing, AS-018). A deterministic carry would have kept it byte-identical.
  const multi: Anchor = {
    blockId: "block-p-1",
    textSnippet: "one",
    offset: 0,
    length: 3,
    segments: [
      { blockId: "block-p-1", textSnippet: "one", offset: 0, length: 3 },
      { blockId: "block-p-2", textSnippet: "two", offset: 0, length: 3 },
    ],
  };
  // New doc: block-p-1 text is now "ZZZ" (segment "one" gone) — the matcher orphans the whole anno.
  const newDoc = doc(["ZZZ", "two", "three"]);
  const r = reanchorForVersion({
    annotations: [{ id: "a-multi", anchor: multi }],
    newContentHtml: newDoc,
    versionId: "doc:2",
    changedBlockIds: ["block-p-1"], // only p-1 edited; p-2 segment is untouched
  });
  expect(r.detached.map((d) => d.id)).toEqual(["a-multi"]); // matcher ran → orphaned (straddle).
  expect(r.carried).toEqual([]);
});

test("AS-022: a multi-range annotation with ALL segments in untouched blocks carries deterministically", () => {
  // Complement of the straddle rule: when NO segment is in an edited block, the whole multi-range
  // annotation carries deterministically, byte-identical, with no matcher (block-p-3 was edited).
  const multi: Anchor = {
    blockId: "block-p-1",
    textSnippet: "one",
    offset: 0,
    length: 3,
    segments: [
      { blockId: "block-p-1", textSnippet: "one", offset: 0, length: 3 },
      { blockId: "block-p-2", textSnippet: "two", offset: 0, length: 3 },
    ],
  };
  // New doc replaces block-p-1 AND block-p-2 text — a matcher would orphan; deterministic carry
  // keeps the anchor identical because neither p-1 nor p-2 is in the changed set.
  const newDoc = doc(["ZZZ", "WWW", "edited-three"]);
  const r = reanchorForVersion({
    annotations: [{ id: "a-multi", anchor: multi }],
    newContentHtml: newDoc,
    versionId: "doc:2",
    changedBlockIds: ["block-p-3"], // neither p-1 nor p-2 edited
  });
  expect(r.detached).toEqual([]);
  expect(r.carried).toHaveLength(1);
  expect(r.carried[0]!.anchor).toEqual(multi); // byte-identical → matcher skipped for all segments.
});
