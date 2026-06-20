// annotation-core S-005 / C-012 — the re-anchor JOB: the integration glue that runs the
// pure matcher (reanchorForVersion) when a new doc version is created, applies the outcome
// to the annotations table, persists the (annotation_id, version_id) ledger, and reports a
// per-publish summary (carried/detached + a >25%-detached alert).
//
// C-012 properties this module upholds:
//   • OFF the publish path — the caller (routes/versions.ts) FIRES this without awaiting, so
//     it never gates a publish, and its failure can't break a successful version create.
//   • idempotent by (annotation_id, version_id) — the ledger short-circuits recompute (the
//     pure matcher consults getEntry) and persistEntry is ON CONFLICT DO NOTHING; the apply
//     writes are value-idempotent (set the same anchor / is_orphaned again = no-op).
//   • emits a summary per publish + alerts when the detached rate exceeds the threshold.
//
// The matcher behaviour (AS-011/012/013/018, C-002) lives in reanchor.ts and is unchanged;
// this only wires it to data + the new-version event.

import {
  reanchorForVersion,
  type AnnotationToReanchor,
  type ReanchorLedgerEntry,
} from "./reanchor";
import type { Anchor } from "./annotation";
import { renderForAnchoring } from "../render/markdown";

/** C-012 example threshold: alert when MORE than 25% of a doc's annotations detach. */
export const DETACHED_ALERT_THRESHOLD = 0.25;

/**
 * Read port: the doc's annotations as {id, anchor, type}. Structurally satisfied by
 * AnnotationRepo.listByDoc (repo.ts). `type` is a plain string so the job can filter out
 * `"suggestion"` rows (their stale lifecycle is C-011, separate from re-anchor) without a
 * union-overlap type error.
 */
export interface ReanchorAnnotationReader {
  listByDoc(
    docId: string,
  ): Promise<{ id: string; anchor: Anchor; type: string; deletedAt?: Date | null; authorId?: string | null }[]>;
}

/** Write port: apply a re-anchor outcome to the annotations row. Both writes are idempotent. */
export interface ReanchorApplyRepo {
  /** Carried: update the anchor to the new-version positions and clear is_orphaned. */
  applyCarried(annotationId: string, anchor: Anchor): Promise<void>;
  /** Detached: mark is_orphaned (the original anchor is preserved — C-002, never lost). */
  markDetached(annotationId: string): Promise<void>;
}

/**
 * Ledger port (C-012 idempotency). Matches DrizzleReanchorLedgerRepo (repo.ts): a synchronous
 * getEntry backed by an in-memory cache, an async loadEntries to preload that cache from the
 * DB before a run, and an idempotent persistEntry.
 */
export interface ReanchorJobLedger {
  getEntry(annotationId: string, versionId: string): ReanchorLedgerEntry | undefined;
  /** Preload persisted outcomes for this version so a re-run short-circuits recompute. */
  loadEntries?(versionId: string): Promise<void>;
  /** Persist one outcome idempotently. Returns false when the (annotation, version) pair existed. */
  persistEntry(entry: ReanchorLedgerEntry): Promise<boolean>;
}

export interface ReanchorJobDeps {
  annotations: ReanchorAnnotationReader;
  apply: ReanchorApplyRepo;
  ledger: ReanchorJobLedger;
  /** Per-publish summary sink (C-012). The >25% alert rides `summary.alert`. */
  onSummary?: (summary: ReanchorSummary) => void;
  /** Override the alert threshold (default DETACHED_ALERT_THRESHOLD). */
  alertThreshold?: number;
  /**
   * notifications-email S-004 (AS-009 / C-007): the per-publish DETACH notify sink. Called ONCE
   * per publish with ONE entry per AUTHOR whose annotations detached THIS publish (grouped — the
   * count is how many of theirs detached), so each affected author gets exactly one grouped in-app
   * row ("N of your annotations were detached"). GAP-002 (resolved): the entries are the affected
   * annotation AUTHORS ONLY (a guest author — null authorId — is excluded, C-011; the owner is NOT
   * auto-added). NOT called when zero annotations detached (no empty notice). BEST-EFFORT: a
   * throwing sink is swallowed (C-007) so it never fails the (already-async, off-publish) job. The
   * grouped row is value-idempotent per publish ONLY to the extent the in-app insert is — see the
   * idempotency note: a forced re-run of the WHOLE job would re-call this (the ledger short-circuits
   * the matcher, not this sink), so the sink is invoked once per job invocation, not once per
   * (annotation, version). Provide a once-per-publish caller (the route fires the job once).
   */
  onDetachedGrouped?: (
    groups: { authorId: string; count: number }[],
    ctx: { docId: string; versionId: string },
  ) => Promise<void> | void;
}

export interface ReanchorJobInput {
  docId: string;
  /** Stable idempotency key for the new version (e.g. `${docId}:${versionNumber}`). */
  versionId: string;
  /**
   * The new version's RAW content (markdown source or HTML). The job renders it to HTML
   * (renderForAnchoring) before the matcher — block-ids only exist post-render, so a
   * markdown doc MUST be rendered here or every annotation orphans (see renderForAnchoring).
   */
  content: string;
  /** The doc's kind. REQUIRED so callers are type-forced to pass it (prevents the raw-markdown regression). */
  kind: "html" | "markdown" | "image";
  /**
   * mcp-patch-document:S-004 / C-004/C-005 — the set of block-ids a block-addressed PATCH changed.
   * Threaded straight into the pure matcher (reanchorForVersion): when PRESENT, annotations on
   * untouched blocks carry deterministically (no matcher); when ABSENT (the whole-doc update path
   * + UI edits), every annotation runs the full fuzzy matcher exactly as today (AS-021).
   */
  changedBlockIds?: string[];
}

/** The per-publish run summary (C-012): counts + the detached-rate alert. */
export interface ReanchorSummary {
  versionId: string;
  /** Annotations considered (excludes suggestions). */
  total: number;
  carried: number;
  detached: number;
  /** detached / total (0 when there were no annotations). */
  detachedRate: number;
  /** True when detachedRate strictly exceeds the threshold (C-012 alert). */
  alert: boolean;
}

/**
 * Re-anchor every (non-suggestion) annotation of `docId` onto the new version's content,
 * apply the outcome to the annotations table, persist the ledger, and return + report the
 * summary. Intended to be FIRED (not awaited) off the publish path — see C-012 in the header.
 */
export async function runReanchorForNewVersion(
  deps: ReanchorJobDeps,
  input: ReanchorJobInput,
): Promise<ReanchorSummary> {
  const rows = await deps.annotations.listByDoc(input.docId);
  // Suggestions have their own stale lifecycle (C-011) — never re-anchored here.
  // annotation-actions S-005 / C-007 (AS-014): a SOFT-DELETED annotation is terminal — it is
  // NOT re-anchored onto the new version AND NOT counted in the detached-rate denominator
  // (`toReanchor.length`). The production listByDoc (repo.ts) already excludes deleted rows at
  // the SQL layer; this filter is the explicit, unit-checkable guard so the rule holds for any
  // reader and can never silently resurrect a deleted annotation on a later publish.
  const live = rows.filter((r) => r.type !== "suggestion" && r.deletedAt == null);
  const toReanchor: AnnotationToReanchor[] = live.map((r) => ({ id: r.id, anchor: r.anchor }));
  // S-004 (AS-009): annotation id → durable author, so a detached annotation can be grouped by its
  // author for the per-publish notify. A guest-created annotation (null authorId) is never in this
  // map's value as a recipient — the grouping below drops a null author (C-011).
  const authorById = new Map<string, string | null>(live.map((r) => [r.id, r.authorId ?? null]));

  // C-012: preload persisted outcomes so a re-run for the same version is a no-op.
  await deps.ledger.loadEntries?.(input.versionId);

  // Render markdown→HTML BEFORE the matcher: block-ids only exist post-render, so a markdown
  // doc must be rendered here or extractAllBlocks finds nothing and every annotation orphans.
  // html/image pass through unchanged (renderForAnchoring owns the decision).
  const newContentHtml = renderForAnchoring(input.content, input.kind);

  const { carried, detached, ledger } = reanchorForVersion(
    {
      annotations: toReanchor,
      newContentHtml,
      versionId: input.versionId,
      // S-004/C-004/C-005: pass the patch's changed-block set through. undefined for the
      // whole-doc update path keeps the full-matcher behavior (AS-021).
      changedBlockIds: input.changedBlockIds,
    },
    deps.ledger,
  );

  // Persist the ledger (idempotent), then apply outcomes (idempotent writes).
  for (const entry of ledger) await deps.ledger.persistEntry(entry);
  for (const c of carried) await deps.apply.applyCarried(c.id, c.anchor);
  for (const d of detached) await deps.apply.markDetached(d.id);

  const total = toReanchor.length;
  const detachedRate = total === 0 ? 0 : detached.length / total;
  const threshold = deps.alertThreshold ?? DETACHED_ALERT_THRESHOLD;
  const summary: ReanchorSummary = {
    versionId: input.versionId,
    total,
    carried: carried.length,
    detached: detached.length,
    detachedRate,
    alert: detachedRate > threshold,
  };
  deps.onSummary?.(summary);

  // notifications-email S-004 (AS-009 / C-007): GROUP the detached annotations by durable author and
  // raise ONE notice per author per publish. Guest-authored detaches (null author) are dropped
  // (C-011). When NOTHING detached, the sink is NOT called at all (no empty "0 detached" notice).
  // BEST-EFFORT: a throwing sink is swallowed so it can never fail the off-publish job (C-007).
  if (deps.onDetachedGrouped && detached.length > 0) {
    const counts = new Map<string, number>();
    for (const d of detached) {
      const authorId = authorById.get(d.id);
      if (authorId == null) continue; // guest author → no account recipient (C-011).
      counts.set(authorId, (counts.get(authorId) ?? 0) + 1);
    }
    if (counts.size > 0) {
      const groups = [...counts.entries()].map(([authorId, count]) => ({ authorId, count }));
      try {
        await deps.onDetachedGrouped(groups, { docId: input.docId, versionId: input.versionId });
      } catch (err) {
        // The orphan-marking already persisted; a notify failure must never fail the job.
        console.error("[reanchor] detached-notify failed (best-effort, orphans already marked)", err);
      }
    }
  }

  return summary;
}
