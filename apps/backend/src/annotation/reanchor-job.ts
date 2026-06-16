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

/** C-012 example threshold: alert when MORE than 25% of a doc's annotations detach. */
export const DETACHED_ALERT_THRESHOLD = 0.25;

/**
 * Read port: the doc's annotations as {id, anchor, type}. Structurally satisfied by
 * AnnotationRepo.listByDoc (repo.ts). `type` is a plain string so the job can filter out
 * `"suggestion"` rows (their stale lifecycle is C-011, separate from re-anchor) without a
 * union-overlap type error.
 */
export interface ReanchorAnnotationReader {
  listByDoc(docId: string): Promise<{ id: string; anchor: Anchor; type: string; deletedAt?: Date | null }[]>;
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
}

export interface ReanchorJobInput {
  docId: string;
  /** Stable idempotency key for the new version (e.g. `${docId}:${versionNumber}`). */
  versionId: string;
  /** The new version's content (pre-block-id-injection; the matcher injects it). */
  newContentHtml: string;
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
  const toReanchor: AnnotationToReanchor[] = rows
    .filter((r) => r.type !== "suggestion" && r.deletedAt == null)
    .map((r) => ({ id: r.id, anchor: r.anchor }));

  // C-012: preload persisted outcomes so a re-run for the same version is a no-op.
  await deps.ledger.loadEntries?.(input.versionId);

  const { carried, detached, ledger } = reanchorForVersion(
    { annotations: toReanchor, newContentHtml: input.newContentHtml, versionId: input.versionId },
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
  return summary;
}
