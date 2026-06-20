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

import { Window } from "happy-dom";
import { extractText, locateRange } from "@anchord/anchor";
import { injectBlockIds } from "./block-id";
import type { Anchor, AnchorSegment } from "./annotation";

/**
 * annotation-reanchor:C-002 — fuzzy tier threshold, RAISED 0.7 → 0.8 (precision over recall: a
 * wrong carry is worse than an honest detach; resolves annotation-core:GAP-001). Normalized
 * Levenshtein similarity (1 - dist/maxLen); carry a fuzzy match only at or above this bound.
 * Mirrors `packages/anchor/src/locate.ts` FUZZY_THRESHOLD — the SAME shared ladder, one constant.
 * Still a working default, not yet empirically tuned (annotation-reanchor:GAP-002).
 */
export const FUZZY_SIMILARITY_THRESHOLD = 0.8;

/** Chars of stored prefix/suffix context that must agree for a WHOLE-DOC match (C-003/AS-003). */
const CONTEXT_MATCH_CAP = 32;

/** A re-anchored annotation (its anchor updated to the new content positions). */
export interface ReanchorCarried {
  status: "carried";
  anchor: Anchor;
  /** Which ladder tier won (C-002) — recorded for the S-003 resolution ledger + AS assertions.
   *  For a multi_range, this is the LOWEST-confidence tier across its segments (the weakest link). */
  method: ReanchorMethod;
  /** The matcher's similarity score in [0,1] for the carried match (annotation-reanchor:S-003 /
   *  C-005 — persisted on the anchor_resolution row). 1 for an exact/normalized hit, the real
   *  Levenshtein similarity for a fuzzy hit. For a multi_range this is the MINIMUM score across
   *  its segments (the weakest link — same "worst" rule as `method`). */
  confidence: number;
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

// --- block-text extraction (C-011: ONE canonical extractor) ---

const CSS_ESCAPE_RE = /["\\\]\[#.:>+~*^$=()| ]/g;
function cssEscape(id: string): string {
  return id.replace(CSS_ESCAPE_RE, "\\$&");
}

/**
 * Pull the plain-text content of the block carrying `blockId` from block-id-injected HTML.
 *
 * C-011 — ONE canonical text extractor. This parses the HTML with happy-dom and walks the matched
 * block's text nodes through the SHARED `extractText` (@anchord/anchor) — the SAME walk the in-iframe
 * placement and the FE markdown path use. The prior implementation was a divergent string-regex strip
 * (`inner.replace(/<[^>]*>/g, "")`) that did NOT decode entities, did NOT strip comments, and did not
 * collapse whitespace — so an offset computed at create (via the DOM walk) could resolve to DIFFERENT
 * text at re-anchor. Routing through the one extractor closes that drift: there is no second extractor.
 *
 * Block lookup accepts BOTH attribute forms injectBlockIds emits: `data-block-id="<blockId>"` (the
 * don't-clobber form) and a plain `id="<blockId>"`. Returns null when no block carries the id
 * (→ AS-013 orphan). Never throws — a parse failure / missing block degrades to null.
 */
export function extractBlockText(html: string, blockId: string): string | null {
  let win: Window | null = null;
  try {
    win = new Window();
    win.document.body.innerHTML = html;
    const esc = cssEscape(blockId);
    const el =
      win.document.querySelector(`[data-block-id="${esc}"]`) ??
      win.document.querySelector(`#${esc}`);
    if (!el) return null;
    return extractText(el as unknown as Parameters<typeof extractText>[0]);
  } catch {
    return null;
  } finally {
    try {
      win?.happyDOM?.close?.();
    } catch {
      /* best-effort teardown */
    }
  }
}

/**
 * Enumerate EVERY addressable block in the (block-id-injected) HTML as `{blockId, text}`, in
 * document order, each block's text pulled through the SAME shared `extractText` walk as
 * `extractBlockText` (C-011 — ONE extractor). This is the substrate of the C-001 whole-doc
 * fallback: when the stored `block_id` hint misses (block gone, or text shifted to a different,
 * renumbered block — the cascade bug), the matcher locates the snippet over ALL of these blocks,
 * not just the hinted one. Never throws — a parse failure degrades to `[]`.
 */
export function extractAllBlocks(html: string): { blockId: string; text: string }[] {
  let win: Window | null = null;
  try {
    win = new Window();
    win.document.body.innerHTML = html;
    const out: { blockId: string; text: string }[] = [];
    // Match either block-id form injectBlockIds emits.
    const els = win.document.querySelectorAll("[data-block-id], [id^='block-']");
    for (let i = 0; i < els.length; i++) {
      const el = els[i] as unknown as Element;
      const blockId = el.getAttribute("data-block-id") ?? el.getAttribute("id");
      if (!blockId) continue;
      const text = extractText(el as unknown as Parameters<typeof extractText>[0]);
      out.push({ blockId, text });
    }
    return out;
  } catch {
    return [];
  } finally {
    try {
      win?.happyDOM?.close?.();
    } catch {
      /* best-effort teardown */
    }
  }
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


// --- single-segment re-anchor ---

/** Which ladder tier won — recorded for the resolution ledger (S-003) + AS assertions. */
export type ReanchorMethod = "exact" | "nearest" | "normalized" | "fuzzy";

interface SegmentReanchor {
  status: "carried";
  blockId: string;
  textSnippet: string;
  offset: number;
  length: number;
  method: ReanchorMethod;
  /** Similarity score [0,1] of the located window vs the stored snippet (S-003 confidence). */
  confidence: number;
}

interface SegmentToReanchor {
  blockId: string;
  textSnippet: string;
  offset: number;
  length: number;
  prefix?: string;
  suffix?: string;
}

/**
 * Whether the stored prefix/suffix context (C-004) agrees with the block context surrounding a
 * candidate whole-doc match at [start,end). The guard that stops a whole-doc match from carrying
 * onto a COINCIDENTAL same-text mention in unrelated context (AS-003 — "transaction_id" in a prose
 * paragraph after the table cell was deleted). We compare the tail of the stored `prefix` against
 * the text immediately before the match, and the head of the stored `suffix` against the text
 * immediately after — both must agree (suffix-of-prefix / prefix-of-suffix so a CONTEXT_CAP cap
 * difference doesn't cause a false miss).
 *
 * DEGRADE (C-004): an anchor lacking BOTH prefix and suffix (an old anchor) returns true — it has
 * no context to check, so it degrades to text_snippet+offset matching, no worse than before.
 */
function contextMatches(
  blockText: string,
  start: number,
  end: number,
  prefix: string | undefined,
  suffix: string | undefined,
): boolean {
  // C-004 DEGRADE: BOTH context fields ABSENT (undefined — an old anchor) → no context to check, so
  // it degrades to text_snippet+offset matching (no worse than before). A PRESENT-but-EMPTY string
  // is NOT the degrade case: it means the selection genuinely touched the block boundary (nothing
  // before/after in the original block), which is itself context that a mid-prose mention violates.
  if (prefix === undefined && suffix === undefined) return true;

  if (prefix !== undefined) {
    const actualBefore = blockText.slice(Math.max(0, start - CONTEXT_MATCH_CAP), start);
    if (prefix.length === 0) {
      // Stored context was the block START — the candidate must also sit at its block start.
      if (actualBefore.length > 0) return false;
    } else {
      // Require the OVERLAPPING tail to agree (a shorter actual context still matches a longer stored).
      const n = Math.min(prefix.length, actualBefore.length);
      if (n === 0) return false; // stored a prefix but the candidate sits at block start → mismatch.
      if (prefix.slice(prefix.length - n) !== actualBefore.slice(actualBefore.length - n)) return false;
    }
  }
  if (suffix !== undefined) {
    const actualAfter = blockText.slice(end, end + CONTEXT_MATCH_CAP);
    if (suffix.length === 0) {
      // Stored context was the block END — the candidate must also sit at its block end.
      if (actualAfter.length > 0) return false;
    } else {
      const n = Math.min(suffix.length, actualAfter.length);
      if (n === 0) return false; // stored a suffix but the candidate sits at block end → mismatch.
      if (suffix.slice(0, n) !== actualAfter.slice(0, n)) return false;
    }
  }
  return true;
}

/** Run the shared locate ladder within one block, reporting which tier hit. Mirrors the
 *  `packages/anchor/src/locate.ts` ladder (exact → nearest → normalized → fuzzy) and labels the
 *  winning method by re-deriving it from the located range (C-002, ONE shared matcher). */
function locateInBlock(
  blockText: string,
  snippet: string,
  offset: number,
): { start: number; end: number; method: ReanchorMethod } | null {
  const range = locateRange(blockText, snippet, offset);
  if (!range) return null;
  const hit = blockText.slice(range.start, range.end);
  let method: ReanchorMethod;
  if (hit === snippet) {
    // Exact text. Distinguish exact-at-offset from a nearest-occurrence carry.
    method = range.start === offset ? "exact" : "nearest";
  } else if (normalize(hit) === normalize(snippet)) {
    method = "normalized";
  } else {
    method = "fuzzy";
  }
  return { start: range.start, end: range.end, method };
}

/** Whitespace-collapse used only to LABEL the normalized tier (the locate ladder owns the match). */
function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Re-anchor one segment onto `injected` (already block-id-injected HTML) via the C-002 ladder:
 *
 *   1. HINTED block (the stored `block_id`) — exact → nearest → normalized → fuzzy.
 *      block_id is a HINT, not a gate (C-001): a miss here does NOT orphan; it falls through.
 *   2. WHOLE-DOC fallback — run the SAME locate ladder over EVERY block; among the blocks where
 *      the snippet locates, ACCEPT only those whose surrounding context matches the stored
 *      prefix/suffix (C-003/AS-003 — reject a coincidental same-text mention). Carry the best
 *      (lowest-tier, then context-confirmed) candidate. This is what kills the cascade bug
 *      (AS-002) and carries a moved block (AS-004): the durable key is the text, not the position.
 *   3. none → null (orphan, AS-003/AS-006).
 *
 * Returns the updated segment + winning method when carried, null when it orphans.
 */
function reanchorSegment(
  injected: string,
  segment: SegmentToReanchor,
  threshold: number,
): SegmentReanchor | null {
  // --- Tier 1: hinted block (C-001 hint path) ---
  const hintBlockText = extractBlockText(injected, segment.blockId);
  if (hintBlockText !== null) {
    const hit = locateInBlock(hintBlockText, segment.textSnippet, segment.offset);
    const hintScore = hit ? segmentScore(hintBlockText, hit.start, hit.end, segment.textSnippet) : 0;
    if (hit && hintScore >= threshold) {
      return {
        status: "carried",
        blockId: segment.blockId,
        textSnippet: hintBlockText.slice(hit.start, hit.end),
        offset: hit.start,
        length: hit.end - hit.start,
        method: hit.method,
        confidence: hintScore,
      };
    }
  }

  // --- Tier 2: whole-doc fallback (C-001 hint MISS → search ALL blocks) ---
  //
  // annotation-reanchor:S-002 — DUPLICATE-quote disambiguation. The snippet may locate in MORE
  // THAN ONE block; choosing the FIRST in document order (Plannotator's first-indexOf-wins) is the
  // precision bug. Collect EVERY block whose match clears the threshold, then RANK them and take
  // the best — this is where S1 beats Plannotator (C-003). Ranking keys, in order:
  //   1. context agreement — a candidate whose stored prefix/suffix matches beats one that doesn't
  //      (the gate from AS-003, here used as a RANKING signal so a context match always wins over a
  //      mere same-text occurrence — never carry onto the non-matching duplicate);
  //   2. method tier — exact < nearest < normalized < fuzzy (a stronger match wins);
  //   3. nearest-`offset` — among equal-context, equal-method candidates, the one whose match
  //      start is nearest the stored offset (AS-007 tie-break across blocks; `nearestOccurrence`
  //      only biases WITHIN a block, this extends it ACROSS candidate blocks);
  //   4. innermost / most-specific block — a parent container (<table>/<tr>) whose CONCATENATED
  //      text incidentally contains a child cell's snippet must NEVER win over the actual <td>.
  //      Smaller block text == more specific (the cell), so prefer the smallest containing block.
  const blocks = extractAllBlocks(injected);
  const methodRank: Record<ReanchorMethod, number> = { exact: 0, nearest: 1, normalized: 2, fuzzy: 3 };

  interface Candidate {
    seg: SegmentReanchor;
    contextOk: boolean;
    rank: number;
    offsetDist: number;
    specificity: number; // smaller = more specific (innermost block)
  }
  let best: Candidate | null = null;

  for (const block of blocks) {
    if (block.blockId === segment.blockId && hintBlockText !== null) continue; // already tried as the hint.
    const hit = locateInBlock(block.text, segment.textSnippet, segment.offset);
    if (!hit) continue;
    const score = segmentScore(block.text, hit.start, hit.end, segment.textSnippet);
    if (score < threshold) continue;
    // C-003/AS-003: a whole-doc match must agree with the stored prefix/suffix context — this is
    // what rejects the coincidental prose mention of a deleted table cell's word. It is also the
    // FIRST ranking key (S-002): a context-matching duplicate always beats a non-matching one.
    const contextOk = contextMatches(block.text, hit.start, hit.end, segment.prefix, segment.suffix);
    if (!contextOk) continue; // hard gate: never carry onto a context-mismatched occurrence (AS-003).
    const candidate: Candidate = {
      seg: {
        status: "carried",
        blockId: block.blockId,
        textSnippet: block.text.slice(hit.start, hit.end),
        offset: hit.start,
        length: hit.end - hit.start,
        method: hit.method,
        confidence: score,
      },
      contextOk,
      rank: methodRank[hit.method],
      offsetDist: Math.abs(hit.start - segment.offset),
      specificity: block.text.length,
    };
    if (best === null || candidateBeats(candidate, best)) best = candidate;
  }
  return best ? best.seg : null; // null → orphan (AS-003/AS-006).
}

/**
 * annotation-reanchor:S-002/C-003 — total order over whole-doc duplicate candidates: lower method
 * rank, then nearest stored offset, then innermost (smallest) block. Returns true when `a` should
 * replace the current best `b`. (Context is a hard gate upstream — both candidates already passed —
 * so it is not re-compared here; it stays the first key by virtue of mismatches being filtered out.)
 */
function candidateBeats(
  a: { rank: number; offsetDist: number; specificity: number },
  b: { rank: number; offsetDist: number; specificity: number },
): boolean {
  if (a.rank !== b.rank) return a.rank < b.rank; // 1) stronger method tier wins.
  if (a.offsetDist !== b.offsetDist) return a.offsetDist < b.offsetDist; // 2) nearest stored offset (AS-007).
  return a.specificity < b.specificity; // 3) innermost / most-specific block (cell beats table/row).
}

/** Similarity of a located window against the stored snippet — the precision gate shared by both
 *  tiers so a below-threshold "located" range never carries (C-002/C-003). Exact/normalized hits
 *  score 1; a fuzzy hit scores its real similarity. */
function segmentScore(blockText: string, start: number, end: number, snippet: string): number {
  return similarity(blockText.slice(start, end), snippet);
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

  const methodRank: Record<ReanchorMethod, number> = { exact: 0, nearest: 1, normalized: 2, fuzzy: 3 };

  // multi_range: all-or-nothing across segments (C-006/AS-018).
  if (anchor.segments && anchor.segments.length > 0) {
    const carriedSegments: AnchorSegment[] = [];
    let worst: ReanchorMethod = "exact";
    let minConfidence = 1;
    for (const seg of anchor.segments) {
      const r = reanchorSegment(injected, seg, threshold);
      if (r === null) return { status: "orphaned" }; // any segment lost → whole detaches (C-006).
      if (methodRank[r.method] > methodRank[worst]) worst = r.method;
      if (r.confidence < minConfidence) minConfidence = r.confidence;
      carriedSegments.push({
        blockId: r.blockId,
        textSnippet: r.textSnippet,
        offset: r.offset,
        length: r.length,
        // C-004: preserve the stored context on the carried segment for the next re-anchor.
        ...(seg.prefix != null ? { prefix: seg.prefix } : {}),
        ...(seg.suffix != null ? { suffix: seg.suffix } : {}),
      });
    }
    // Primary anchor fields track the first segment for a carried multi_range.
    const first = carriedSegments[0];
    return {
      status: "carried",
      method: worst,
      confidence: minConfidence,
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
      prefix: anchor.prefix,
      suffix: anchor.suffix,
    },
    threshold,
  );
  if (r === null) return { status: "orphaned" };
  return {
    status: "carried",
    method: r.method,
    confidence: r.confidence,
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
  /** The winning ladder tier (C-002) when carried — the seam the S-003 resolution row records. */
  method?: ReanchorMethod;
  /** The matcher's similarity score [0,1] when carried (annotation-reanchor:S-003 / C-005). The
   *  anchor_resolution row persists this alongside method + the resolved span; absent when orphaned. */
  confidence?: number;
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
  /**
   * mcp-patch-document:S-004 / C-005 — the set of block-ids a block-addressed PATCH changed.
   *
   *   • UNDEFINED (the whole-doc update path + UI edits) → run the full fuzzy matcher for EVERY
   *     annotation, byte-identical to today (AS-021). No deterministic-carry branch is taken.
   *   • PROVIDED → an annotation whose block-id(s) are ALL outside this set is DETERMINISTICALLY
   *     CARRIED (anchor kept as-is, is_orphaned cleared, the matcher is NOT invoked — AS-019);
   *     an annotation with ANY block-id IN this set runs the existing matcher exactly as today
   *     (AS-020), and a multi-range annotation with ANY segment in an edited block runs the
   *     matcher even if its other segments are untouched (conservative straddle rule — AS-022).
   *
   * Why deterministic carry is sound: the patch's structural guard (mcp-patch-document:C-008,
   * already enforced in patchMarkdownSource/patchHtmlSource) guarantees the ORDERED block-id
   * sequence is unchanged across the patch, so an untouched block keeps its positional id —
   * its annotation's anchor still resolves to the same span, with no matcher needed.
   */
  changedBlockIds?: Set<string> | string[];
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
 * S-004/C-005 — does this annotation touch any block the patch edited? Single-range → its
 * `anchor.blockId`. Multi-range → EVERY segment's blockId (anchor.segments[].blockId). Returns
 * true if ANY of those ids is in the changed set — the CONSERVATIVE straddle rule (AS-022): a
 * multi-range annotation with even one segment in an edited block runs the full matcher rather
 * than carrying deterministically, because the edit may have shifted that segment's text.
 */
function annotationTouchesChangedBlock(anchor: Anchor, changed: Set<string>): boolean {
  if (anchor.segments && anchor.segments.length > 0) {
    return anchor.segments.some((seg) => changed.has(seg.blockId));
  }
  return changed.has(anchor.blockId);
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
  const { annotations, newContentHtml, versionId, opts, changedBlockIds } = input;
  const injected = newContentHtml; // reanchorAnnotation re-injects; pass raw html through.

  // S-004/C-005: a PROVIDED changed-block set switches on the deterministic-carry pre-check
  // (a patch named exactly what changed). UNDEFINED keeps today's full-matcher path for ALL
  // annotations (AS-021) — normalize to a Set once, or null when not supplied (no branch).
  const changed: Set<string> | null =
    changedBlockIds === undefined ? null : new Set(changedBlockIds);

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
      // S-004/C-005: PRE-CHECK before the matcher. When a patch supplied the changed-block set
      // and NONE of this annotation's block-id(s) were edited, carry it deterministically —
      // keep the anchor as-is, mark carried (clears is_orphaned downstream), do NOT invoke the
      // fuzzy matcher. The matcher path (reanchorAnnotation) is UNTOUCHED in behavior; this only
      // skips it for blocks the patch proves were not touched. Sound because the patch's
      // structural guard (C-008) keeps the ordered block-id sequence stable (see input docs).
      if (changed !== null && !annotationTouchesChangedBlock(ann.anchor, changed)) {
        entry = {
          annotationId: ann.id,
          versionId,
          status: "carried",
          anchor: ann.anchor, // unchanged — the untouched block keeps its positional id.
          method: "exact",
          confidence: 1,
        };
        seen.set(key, entry);
        ledger.push(entry); // C-012: still ledgered (status carried) so a re-run is idempotent.
        carried.push({ id: ann.id, anchor: ann.anchor }); // byte-identical to the input anchor.
        continue;
      }
      const result = reanchorAnnotation(ann.anchor, injected, opts);
      entry =
        result.status === "carried"
          ? {
              annotationId: ann.id,
              versionId,
              status: "carried",
              anchor: result.anchor,
              method: result.method,
              confidence: result.confidence,
            }
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
