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
import type { Anchor } from "./annotation";

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
