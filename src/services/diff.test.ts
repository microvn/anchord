import { test, expect } from "bun:test";
import { compareVersions, computeLineDiff, type CompareResult } from "./diff";

// Story S-004: Compare two versions. PURE computation over two content strings +
// kind — no DB. For html/markdown it returns a two-level result: a SOURCE line
// diff (added/removed/context) AND a side-by-side render PAIR (the two versions'
// opaque render targets, e.g. /v/<id>). For image docs it returns ONLY the render
// pair (no text diff). Identical detection compares contentHash first (cheap).

const sha = (s: string) => {
  const h = new Bun.CryptoHasher("sha256");
  h.update(new TextEncoder().encode(s));
  return h.digest("hex");
};

// Build one side of a comparison from raw content; renderTarget is opaque.
const side = (version: number, content: string) => ({
  version,
  content,
  contentHash: sha(content),
  renderTarget: `/v/v${version}`,
});

test("AS-006.T1: two-level diff — source line diff (added/removed) for differing html/md content", async () => {
  // v2 vs v3 with different content → SOURCE differences shown: added + removed
  // lines highlighted, with a non-zero change count.
  const a = side(2, "line one\nline two\nline three");
  const b = side(3, "line one\nline two CHANGED\nline three\nline four");

  const res = compareVersions({ kind: "markdown", a, b }) as Extract<CompareResult, { mode: "text" }>;

  expect(res.mode).toBe("text");
  expect(res.identical).toBe(false);
  expect(res.changeCount).toBeGreaterThan(0);

  // The diff carries line entries typed added / removed / context.
  const types = new Set(res.lines.map((l) => l.type));
  expect(types.has("added")).toBe(true); // "line two CHANGED" + "line four"
  expect(types.has("removed")).toBe(true); // "line two"
  expect(types.has("context")).toBe(true); // "line one" survived unchanged

  // Concrete: an added line carries the new text, a removed line the old.
  expect(res.lines.some((l) => l.type === "added" && l.text === "line four")).toBe(true);
  expect(res.lines.some((l) => l.type === "removed" && l.text === "line two")).toBe(true);

  // html is treated the same (also a text diff).
  const htmlRes = compareVersions({
    kind: "html",
    a: side(2, "<p>a</p>"),
    b: side(3, "<p>b</p>"),
  }) as Extract<CompareResult, { mode: "text" }>;
  expect(htmlRes.mode).toBe("text");
  expect(htmlRes.changeCount).toBeGreaterThan(0);
});

test("AS-006.T2: rendered side-by-side pair — logic emits BOTH versions' render targets (vX | vY)", async () => {
  // [→MANUAL] the iframe layout is UI; the LOGIC must emit the ordered pair of
  // render descriptors so the UI can place v2 | v3 side-by-side.
  const a = side(2, "old");
  const b = side(3, "new");

  const res = compareVersions({ kind: "html", a, b });

  expect(res.renderPair).toEqual(["/v/v2", "/v/v3"]); // ordered [a, b] = left | right
});

test("AS-007: identical versions (equal content_hash) → 'No differences'; side-by-side STILL shown", async () => {
  // Equal content → equal contentHash → identical:true, changeCount 0, and an
  // empty/zero diff — BUT the render pair is STILL emitted (you still see both).
  const a = side(2, "same body\nsecond line");
  const b = side(3, "same body\nsecond line");
  expect(a.contentHash).toBe(b.contentHash); // precondition: equal hash

  const res = compareVersions({ kind: "markdown", a, b }) as Extract<CompareResult, { mode: "text" }>;

  expect(res.identical).toBe(true);
  expect(res.changeCount).toBe(0);
  expect(res.lines.every((l) => l.type === "context")).toBe(true); // no added/removed
  // Side-by-side pair is still present.
  expect(res.renderPair).toEqual(["/v/v2", "/v/v3"]);
});

test("AS-008: image doc → two images side-by-side, NO text diff", async () => {
  // kind=image → result has the image pair and mode 'image', and carries NO source
  // line diff (no `lines` property).
  const a = side(2, "<binary-image-bytes-a>");
  const b = side(3, "<binary-image-bytes-b>");

  const res = compareVersions({ kind: "image", a, b });

  expect(res.mode).toBe("image");
  expect(res.renderPair).toEqual(["/v/v2", "/v/v3"]);
  expect("lines" in res).toBe(false); // no text diff for images
});

// --- computeLineDiff boundary (the swappable LCS seam; GAP-004 normalization deferred) ---

test("AS-006.T1: computeLineDiff — empty 'a' vs non-empty 'b' → all lines added", () => {
  // Edge: empty original → everything in b is an addition.
  const d = computeLineDiff("", "one\ntwo");
  expect(d.changeCount).toBe(2);
  expect(d.lines.filter((l) => l.type === "added").map((l) => l.text)).toEqual(["one", "two"]);
  expect(d.lines.some((l) => l.type === "removed")).toBe(false);
});

test("AS-006.T1: computeLineDiff — non-empty 'a' vs empty 'b' → all lines removed", () => {
  // Edge: cleared content → everything in a is a removal.
  const d = computeLineDiff("one\ntwo", "");
  expect(d.changeCount).toBe(2);
  expect(d.lines.filter((l) => l.type === "removed").map((l) => l.text)).toEqual(["one", "two"]);
  expect(d.lines.some((l) => l.type === "added")).toBe(false);
});

test("AS-006.T1: computeLineDiff — equal strings → all context, changeCount 0", () => {
  // Identity by string (not via hash short-circuit): zero changes, all context.
  const d = computeLineDiff("a\nb\nc", "a\nb\nc");
  expect(d.changeCount).toBe(0);
  expect(d.lines.map((l) => l.type)).toEqual(["context", "context", "context"]);
});
