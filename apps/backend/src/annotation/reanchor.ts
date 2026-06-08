// Re-anchor across versions (annotation-core S-005, C-002 + C-012). When a new
// version of a doc is published, every annotation from the previous version must be
// re-anchored onto the NEW content: a match carries the annotation forward; a
// non-match marks it `is_orphaned` and drops it into the "detached" list — annotations
// are NEVER silently lost (C-002).
//
// This is the matcher that versioning-diff:S-005 deferred to: versioning's
// `appendVersion` returns `{previousVersion, version}` as the SEAM, and calls into
// `reanchorForVersion` here with the previous version's annotations + the new content.
//
// Re-anchor ladder per annotation (C-002): block_id → exact snippet → fuzzy snippet →
// not found = orphaned.
//   1. inject block-ids into the new HTML (REUSE injectBlockIds) and pull the target
//      block's text by anchor.block_id.
//   2. block missing → orphaned (AS-013).
//   3. exact text_snippet match in the block → carried, offset recomputed (AS-011).
//   4. else fuzzy match within the block; similarity ≥ threshold → carried (AS-012),
//      else orphaned.
//   5. multi_range: re-anchor EVERY segment; if ANY segment orphans, the WHOLE
//      annotation orphans (all-or-nothing, AS-018) — no partial anchoring.
//
// Idempotency (C-012): `reanchorForVersion` produces a LEDGER keyed by
// (annotation_id, versionId). Re-running for the same versionId yields the same result
// with no double-apply — it does NOT mutate `anchor` in place.
//
// Pure logic (anchor + html string → result). No DB. The repo/ledger PERSISTENCE, the
// async (non-publish-gating) job, the run summary, and the alert-on->25%-detached are
// integration / ops [→MANUAL] — see the integration note; not built here.

import { injectBlockIds } from "./block-id";
import type { Anchor, AnchorSegment } from "./annotation";

/**
 * GAP-001 (fuzzy threshold) is OPEN — tuning deferred. We use normalized Levenshtein
 * similarity (1 - dist/maxLen) and carry a fuzzy match only at or above this bound.
 * 0.7 keeps small edits ("24h" → "48 hours") together while rejecting unrelated text;
 * picked as a working default, not yet empirically tuned (see GAP-001).
 */
export const FUZZY_SIMILARITY_THRESHOLD = 0.7;

/** A re-anchored annotation (its anchor updated to the new content positions). */
export interface ReanchorCarried {
  status: "carried";
  anchor: Anchor;
}

/** An annotation that no block/snippet in the new content could match. */
export interface ReanchorOrphaned {
  status: "orphaned";
}

export type ReanchorResult = ReanchorCarried | ReanchorOrphaned;

export interface ReanchorOptions {
  /** Override GAP-001 threshold (testing / future tuning). */
  fuzzyThreshold?: number;
}

// --- block-text extraction (dependency-free, mirrors block-id.ts's tokenizer style) ---

/**
 * Pull the plain-text content of the block carrying `blockId` from block-id-injected
 * HTML. We match the opening tag that declares `id="<blockId>"` OR
 * `data-block-id="<blockId>"` (block-id.ts uses data-block-id when the author already
 * had an id), then take everything up to that tag's matching close tag, stripping inner
 * tags to text. Returns null when no block carries the id (→ AS-013 orphan).
 *
 * Minimal on purpose: the new HTML has already passed through markdown-it/DOMPurify +
 * injectBlockIds, so the tag set is normalized and a full HTML parser is overkill (same
 * rationale as block-id.ts).
 */
export function extractBlockText(html: string, blockId: string): string | null {
  // Find the opening tag that carries this block id (either attribute form).
  const idAttr = `id="${blockId}"`;
  const dataAttr = `data-block-id="${blockId}"`;
  const at = (() => {
    const a = html.indexOf(idAttr);
    const b = html.indexOf(dataAttr);
    if (a === -1) return b;
    if (b === -1) return a;
    return Math.min(a, b);
  })();
  if (at === -1) return null;

  // Walk left to the '<' that opens this tag, read the tag name.
  const open = html.lastIndexOf("<", at);
  if (open === -1) return null;
  const nameMatch = /^<([a-zA-Z][a-zA-Z0-9]*)/.exec(html.slice(open));
  if (!nameMatch) return null;
  const tag = nameMatch[1].toLowerCase();

  // End of the opening tag.
  const gt = html.indexOf(">", at);
  if (gt === -1) return null;

  // Find the matching close tag, accounting for nested same-tag elements.
  const openRe = new RegExp(`<${tag}(\\s|>|/)`, "gi");
  const closeRe = new RegExp(`</${tag}\\s*>`, "gi");
  let depth = 1;
  let cursor = gt + 1;
  let contentEnd = -1;
  while (cursor < html.length) {
    openRe.lastIndex = cursor;
    closeRe.lastIndex = cursor;
    const nextOpen = openRe.exec(html);
    const nextClose = closeRe.exec(html);
    if (!nextClose) break; // malformed; bail
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      cursor = nextOpen.index + 1;
    } else {
      depth -= 1;
      if (depth === 0) {
        contentEnd = nextClose.index;
        break;
      }
      cursor = nextClose.index + 1;
    }
  }
  if (contentEnd === -1) return null;

  const inner = html.slice(gt + 1, contentEnd);
  // Strip inner tags → plain text (the snippet is text, not markup).
  return inner.replace(/<[^>]*>/g, "");
}

// --- fuzzy similarity (small, dependency-free Levenshtein) ---

/** Levenshtein edit distance between two strings (iterative, O(len*len) space-light). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Normalized similarity in [0,1]: 1 = identical, 0 = maximally different. */
export function similarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

/**
 * Find the best fuzzy position of `snippet` within `blockText`: slide a window of the
 * snippet's length across the block and keep the highest-similarity offset. Returns the
 * best offset + its similarity. (Window length is clamped to the block length so a
 * snippet longer than the block still gets compared against the whole block.)
 */
function bestFuzzyMatch(
  blockText: string,
  snippet: string,
): { offset: number; score: number } {
  if (blockText.length === 0) {
    return { offset: 0, score: similarity(blockText, snippet) };
  }
  const win = Math.min(snippet.length, blockText.length);
  let best = { offset: 0, score: -1 };
  // Compare full-block too (handles length growth like "24h" → "48 hours").
  const candidates = new Set<number>();
  for (let i = 0; i + win <= blockText.length; i++) candidates.add(i);
  candidates.add(0); // ensure at least one window for tiny blocks
  for (const i of candidates) {
    const score = similarity(blockText.slice(i, i + win), snippet);
    if (score > best.score) best = { offset: i, score };
  }
  // Also score the whole-block-vs-snippet (captures a length change in one block).
  const whole = similarity(blockText, snippet);
  if (whole > best.score) {
    best = { offset: blockText.indexOf(snippet) >= 0 ? blockText.indexOf(snippet) : 0, score: whole };
  }
  return best;
}

// --- single-segment re-anchor ---

interface SegmentReanchor {
  status: "carried";
  blockId: string;
  textSnippet: string;
  offset: number;
  length: number;
}

/**
 * Re-anchor one (block_id, text_snippet, offset, length) segment onto `newContentHtml`
 * (already block-id-injected by the caller). Returns the updated segment when carried,
 * or null when the segment orphans (block gone, or fuzzy below threshold).
 */
function reanchorSegment(
  injected: string,
  segment: { blockId: string; textSnippet: string; offset: number; length: number },
  threshold: number,
): SegmentReanchor | null {
  const blockText = extractBlockText(injected, segment.blockId);
  if (blockText === null) return null; // AS-013: block fully deleted → orphan.

  // AS-011: exact snippet present → carry, recompute offset in the new block text.
  const exactAt = blockText.indexOf(segment.textSnippet);
  if (exactAt !== -1) {
    return {
      status: "carried",
      blockId: segment.blockId,
      textSnippet: segment.textSnippet,
      offset: exactAt,
      length: segment.textSnippet.length,
    };
  }

  // AS-012: snippet changed slightly but block still exists → fuzzy match within block.
  const { offset, score } = bestFuzzyMatch(blockText, segment.textSnippet);
  if (score >= threshold) {
    // Carry at the best position; snippet/length follow the NEW block text window so
    // the carried anchor points at real content in the new version.
    const win = Math.min(segment.textSnippet.length, Math.max(blockText.length - offset, 0));
    const carriedSnippet = blockText.slice(offset, offset + win) || blockText;
    return {
      status: "carried",
      blockId: segment.blockId,
      textSnippet: carriedSnippet,
      offset,
      length: carriedSnippet.length,
    };
  }

  return null; // fuzzy below threshold → orphan.
}

/**
 * Re-anchor a single annotation's anchor onto new content (C-002).
 *
 * For a single range: block → exact → fuzzy → orphan.
 * For multi_range (anchor.segments[]): re-anchor EVERY segment; if ANY orphans the
 * WHOLE annotation orphans (all-or-nothing, AS-018) — never a partial.
 */
export function reanchorAnnotation(
  anchor: Anchor,
  newContentHtml: string,
  opts: ReanchorOptions = {},
): ReanchorResult {
  const threshold = opts.fuzzyThreshold ?? FUZZY_SIMILARITY_THRESHOLD;
  const injected = injectBlockIds(newContentHtml);

  // multi_range: all-or-nothing across segments (AS-018).
  if (anchor.segments && anchor.segments.length > 0) {
    const carriedSegments: AnchorSegment[] = [];
    for (const seg of anchor.segments) {
      const r = reanchorSegment(injected, seg, threshold);
      if (r === null) return { status: "orphaned" }; // any segment lost → whole detaches.
      carriedSegments.push({
        blockId: r.blockId,
        textSnippet: r.textSnippet,
        offset: r.offset,
        length: r.length,
      });
    }
    // Primary anchor fields track the first segment for a carried multi_range.
    const first = carriedSegments[0];
    return {
      status: "carried",
      anchor: {
        ...anchor,
        blockId: first.blockId,
        textSnippet: first.textSnippet,
        offset: first.offset,
        length: first.length,
        segments: carriedSegments,
      },
    };
  }

  // Single range.
  const r = reanchorSegment(
    injected,
    {
      blockId: anchor.blockId,
      textSnippet: anchor.textSnippet,
      offset: anchor.offset,
      length: anchor.length,
    },
    threshold,
  );
  if (r === null) return { status: "orphaned" };
  return {
    status: "carried",
    anchor: {
      ...anchor,
      blockId: r.blockId,
      textSnippet: r.textSnippet,
      offset: r.offset,
      length: r.length,
    },
  };
}

// --- version-level re-anchor (ledger + idempotency, C-012) ---

/** One annotation as fed to a re-anchor run — carries its id so the ledger can key it. */
export interface AnnotationToReanchor {
  id: string;
  anchor: Anchor;
}

/** A ledger row: the outcome of re-anchoring one annotation onto one version. */
export interface ReanchorLedgerEntry {
  annotationId: string;
  versionId: string;
  status: "carried" | "orphaned";
  /** The re-anchored anchor when carried; absent when orphaned. */
  anchor?: Anchor;
}

export interface CarriedAnnotation {
  id: string;
  anchor: Anchor;
}

export interface DetachedAnnotation {
  id: string;
  /** The original anchor, preserved so the detached annotation is never lost. */
  anchor: Anchor;
}

export interface ReanchorForVersionInput {
  annotations: AnnotationToReanchor[];
  newContentHtml: string;
  versionId: string;
  opts?: ReanchorOptions;
}

export interface ReanchorForVersionResult {
  carried: CarriedAnnotation[];
  detached: DetachedAnnotation[];
  /** Per-(annotation_id, versionId) ledger — the idempotency record (C-012). */
  ledger: ReanchorLedgerEntry[];
}

/**
 * Optional persistence port for the ledger. When supplied, an existing ledger entry for
 * (annotationId, versionId) is REUSED instead of recomputed — this is what makes a
 * re-run a no-op (C-012). With no repo, idempotency still holds within a single call
 * because the function is pure over its inputs (same inputs → same output). The real
 * Drizzle-backed repo + the async job are integration [→MANUAL].
 */
export interface ReanchorLedgerRepo {
  getEntry(annotationId: string, versionId: string): ReanchorLedgerEntry | undefined;
}

/**
 * Re-anchor every annotation from the previous version onto the new content, splitting
 * into carried vs detached, and emitting a per-(annotation_id, versionId) ledger.
 *
 * C-012 idempotency: results are keyed by (annotation_id, versionId). Re-running with
 * the same versionId yields an identical result and never double-applies — an existing
 * ledger entry (via `repo`) short-circuits recomputation, and within a call each
 * annotation is keyed once (a duplicate annotation id reuses the first computed entry,
 * so no double ledger row).
 *
 * [→MANUAL]: persisting the ledger, running this OFF the publish path (must not gate
 * publish), the run summary, and the >25%-detached alert are ops/integration — not here.
 */
export function reanchorForVersion(
  input: ReanchorForVersionInput,
  repo?: ReanchorLedgerRepo,
): ReanchorForVersionResult {
  const { annotations, newContentHtml, versionId, opts } = input;
  const injected = newContentHtml; // reanchorAnnotation re-injects; pass raw html through.

  const carried: CarriedAnnotation[] = [];
  const detached: DetachedAnnotation[] = [];
  const ledger: ReanchorLedgerEntry[] = [];
  const seen = new Map<string, ReanchorLedgerEntry>(); // key (annotationId,versionId) → entry

  for (const ann of annotations) {
    const key = `${ann.id}::${versionId}`;

    // C-012: reuse an existing entry (persisted, or already computed this run) — no
    // double-apply.
    let entry = seen.get(key) ?? repo?.getEntry(ann.id, versionId);
    if (!entry) {
      const result = reanchorAnnotation(ann.anchor, injected, opts);
      entry =
        result.status === "carried"
          ? { annotationId: ann.id, versionId, status: "carried", anchor: result.anchor }
          : { annotationId: ann.id, versionId, status: "orphaned" };
      seen.set(key, entry);
      ledger.push(entry);
    } else if (!seen.has(key)) {
      // Came from the repo (prior run) — surface it in this run's ledger too, once.
      seen.set(key, entry);
      ledger.push(entry);
    }

    if (entry.status === "carried" && entry.anchor) {
      carried.push({ id: ann.id, anchor: entry.anchor });
    } else {
      // Detached: keep the ORIGINAL anchor so the annotation is never lost (C-002).
      detached.push({ id: ann.id, anchor: ann.anchor });
    }
  }

  return { carried, detached, ledger };
}
