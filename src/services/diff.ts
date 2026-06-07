// Version compare service (story S-004). PURE computation over two version sides
// (content string + contentHash + opaque renderTarget) plus the doc kind. Produces
// a discriminated result:
//
//   - text  (html / markdown): a two-level view — a SOURCE line diff
//     (added/removed/context lines + changeCount) AND the side-by-side render
//     PAIR (AS-006). Identical versions (equal content_hash) report "No
//     differences" (identical, changeCount 0) but STILL emit the render pair so
//     both renders are shown (AS-007).
//   - image: ONLY the render pair, no text diff (AS-008).
//
// The actual iframe layout that places v2 | v3 side-by-side is UI ([→MANUAL]);
// this layer just emits the ordered render-target pair. Rendering itself reuses
// the existing viewer (`/v/:id` via src/render/sandbox.ts) — not re-done here.

/** One source line in a text diff. `context` = unchanged (survived both sides). */
export interface DiffLine {
  type: "added" | "removed" | "context";
  text: string;
}

/** Result of the source line diff (the swappable computeLineDiff boundary). */
export interface LineDiff {
  /** Count of added + removed lines (0 ⇒ no source differences). */
  changeCount: number;
  lines: DiffLine[];
}

/** One side of a comparison. `renderTarget` is opaque (e.g. `/v/<versionId>`). */
export interface CompareSide {
  version: number;
  content: string;
  contentHash: string;
  renderTarget: string;
}

export interface CompareInput {
  kind: "html" | "markdown" | "image";
  a: CompareSide;
  b: CompareSide;
}

/** [aTarget, bTarget] — ordered left | right for the side-by-side viewer. */
export type RenderPair = [string, string];

export type CompareResult =
  | { mode: "text"; identical: boolean; changeCount: number; lines: DiffLine[]; renderPair: RenderPair }
  | { mode: "image"; renderPair: RenderPair };

/**
 * Compute a line-based diff of two strings via LCS over `split('\n')`, emitting
 * added / removed / context lines and a changeCount (added + removed).
 *
 * This is the single seam the spec's chosen diff lib (`@pierre/diffs`) could swap
 * into later WITHOUT touching callers. We use a minimal LCS here because
 * `@pierre/diffs` is a browser/shiki diff *renderer* (it parses unified-diff
 * patch text into HAST/DOM), not a plain string→line-diff API — wrong layer for
 * this pure server-side computation.
 *
 * GAP-004 (raw-HTML normalization before diffing) is deferred: we diff the raw
 * content lines verbatim, no pre-normalization.
 */
export function computeLineDiff(a: string, b: string): LineDiff {
  const aLines = a.length === 0 ? [] : a.split("\n");
  const bLines = b.length === 0 ? [] : b.split("\n");

  // LCS length table over the two line arrays.
  const n = aLines.length;
  const m = bLines.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = aLines[i] === bLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  // Backtrack to emit a unified-style sequence: context for common lines,
  // removed for lines only in a, added for lines only in b.
  const lines: DiffLine[] = [];
  let changeCount = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      lines.push({ type: "context", text: aLines[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      lines.push({ type: "removed", text: aLines[i] });
      changeCount++;
      i++;
    } else {
      lines.push({ type: "added", text: bLines[j] });
      changeCount++;
      j++;
    }
  }
  for (; i < n; i++) {
    lines.push({ type: "removed", text: aLines[i] });
    changeCount++;
  }
  for (; j < m; j++) {
    lines.push({ type: "added", text: bLines[j] });
    changeCount++;
  }

  return { changeCount, lines };
}

/**
 * Compare two versions. Image docs short-circuit to a render-pair-only result
 * (AS-008, no text diff). Text docs (html/markdown) compare contentHash first
 * (cheap): equal hash ⇒ identical, no source diff computed, changeCount 0, all
 * remaining lines context — but the render pair is STILL emitted (AS-007). The
 * render pair is always [a, b] (left | right).
 */
export function compareVersions({ kind, a, b }: CompareInput): CompareResult {
  const renderPair: RenderPair = [a.renderTarget, b.renderTarget];

  if (kind === "image") {
    return { mode: "image", renderPair };
  }

  // Cheap identity check first (AS-007 keys on "equal content_hash").
  if (a.contentHash === b.contentHash) {
    return {
      mode: "text",
      identical: true,
      changeCount: 0,
      lines: a.content.length === 0 ? [] : a.content.split("\n").map((text) => ({ type: "context" as const, text })),
      renderPair,
    };
  }

  const diff = computeLineDiff(a.content, b.content);
  return {
    mode: "text",
    identical: diff.changeCount === 0,
    changeCount: diff.changeCount,
    lines: diff.lines,
    renderPair,
  };
}
