// Drizzle-backed repositories for the annotation-core cluster (S-001 create/read,
// S-003 reply, S-004 resolve, S-005 re-anchor ledger, S-006 suggestion, S-007 guest).
// THIN glue between the service modules and Postgres, mirroring src/publish/repo.ts
// (createDocRepo) and src/services/version-repo.ts (createVersionRepo). No business
// logic lives here — every authz/guard/flatten/stale check already runs in the service
// modules; these factories only read and write rows. Integration-verified against a real
// Postgres in test/integration/annotation-repo.itest.ts.

import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { annotations, comments, reanchorLedger, user } from "../db/schema";
import type { DB } from "../db/client";
import type { Anchor } from "./annotation";
import type {
  AnnotationRepo,
  AnnotationRow,
  AnnotationType,
  NewAnnotation,
  ViewerComment,
} from "./annotation";
import type { CommentRepo, CommentRow } from "./reply";
import type { ResolutionRepo, AnnotationStatus } from "./resolve";
import type { DeleteRepo, RestoreRepo } from "./delete";
import type { DismissReattachRepo } from "./dismiss-reattach";
import type {
  SuggestionRepo,
  SuggestionRow,
  SuggestionPayload,
  SuggestionStatus,
} from "./suggestion";
import type { GuestCommentRepo, NewGuestComment } from "./guest";
import type { ReanchorLedgerRepo, ReanchorLedgerEntry } from "./reanchor";
import type { ReanchorApplyRepo } from "./reanchor-job";

// ── S-001: annotation create + read (AnnotationRepo) ───────────────────────

/** Construct an AnnotationRepo backed by a Drizzle DB handle. */
export function createAnnotationRepo(db: DB): AnnotationRepo {
  return {
    async insertAnnotation(input: NewAnnotation): Promise<{ id: string }> {
      const [row] = await db
        .insert(annotations)
        .values({
          docId: input.docId,
          type: input.type,
          anchor: input.anchor, // AS-003: stored verbatim with the chosen block_id.
          label: input.label ?? null, // S-009/AS-027: validated preset id, null if none.
          authorId: input.authorId ?? null, // S-001/C-005: durable creator, null for a guest.
        })
        .returning({ id: annotations.id });
      return { id: row.id };
    },

    async listByDoc(docId: string): Promise<AnnotationRow[]> {
      const rows = await db
        .select({
          id: annotations.id,
          docId: annotations.docId,
          type: annotations.type,
          anchor: annotations.anchor,
          isOrphaned: annotations.isOrphaned,
          status: annotations.status,
          authorId: annotations.authorId, // S-001/C-005: served on read as authorId (own-vs-others gate).
          label: annotations.label, // S-009/AS-027: served on read for the rail label line.
          // S-006/AS-030: served on read so the viewer renders the suggestion lifecycle.
          suggestion: annotations.suggestion,
          suggestionStatus: annotations.suggestionStatus,
        })
        .from(annotations)
        // S-005 / C-007 (AS-014): exclude soft-deleted annotations from the active list. This
        // SAME read backs the re-anchor enumeration (reanchor-job reads via listByDoc), so a
        // deleted annotation is also never re-anchored nor counted in the detached-rate metric.
        // S-008 / C-013 (AS-023): a DISMISSED detached annotation is excluded the same way —
        // it leaves the active list (and the re-anchor enumeration) but is kept, not hard-deleted.
        .where(and(eq(annotations.docId, docId), isNull(annotations.deletedAt), isNull(annotations.dismissedAt)))
        // #4 (2026-06-12): newest annotation/thread first — a freshly created thread "appears at the
        // top of the rail" (spec). Only the ANNOTATION ordering is DESC; comments WITHIN a thread
        // stay ASC (root then replies, top-down) — see listCommentsByDoc below.
        .orderBy(desc(annotations.createdAt));
      return rows.map((r) => ({
        id: r.id,
        docId: r.docId,
        type: r.type as AnnotationType,
        anchor: r.anchor as Anchor,
        isOrphaned: r.isOrphaned,
        status: r.status,
        authorId: r.authorId ?? null, // S-001/C-005: the durable creator; null for a guest.
        label: r.label, // null when unset (an ordinary annotation).
        // AS-030: null on a non-suggestion row; the payload + lifecycle on a suggestion.
        suggestion: (r.suggestion as SuggestionPayload | null) ?? null,
        suggestionStatus: (r.suggestionStatus as SuggestionStatus | null) ?? null,
      }));
    },

    // S-003 viewer read: every comment on the doc's annotations, in creation order, with the
    // session author's display name resolved (LEFT JOIN — a guest comment has no authorId, keeps
    // its guestName). One query for the whole doc; the domain groups these into per-annotation
    // threads. Shape matches the annotation-core-ui list contract `{ …, authorName|guestName, createdAt }`.
    async listCommentsByDoc(docId: string): Promise<(ViewerComment & { annotationId: string })[]> {
      const rows = await db
        .select({
          id: comments.id,
          annotationId: comments.annotationId,
          parentId: comments.parentId,
          authorName: user.name,
          guestName: comments.guestName,
          body: comments.body,
          createdAt: comments.createdAt,
        })
        .from(comments)
        .innerJoin(annotations, eq(comments.annotationId, annotations.id))
        .leftJoin(user, eq(comments.authorId, user.id))
        // S-005 / C-007 (AS-014): a soft-deleted annotation's thread (its highlight + comments)
        // must not surface on the active read either — exclude comments whose annotation is deleted.
        // S-008 / C-013 (AS-023): likewise exclude the thread of a DISMISSED detached annotation.
        .where(and(eq(annotations.docId, docId), isNull(annotations.deletedAt), isNull(annotations.dismissedAt)))
        .orderBy(asc(comments.createdAt)); // root(s) then replies in creation order.
      return rows.map((r) => ({
        id: r.id,
        annotationId: r.annotationId,
        parentId: r.parentId,
        // Exactly one of authorName / guestName is meaningful; omit the absent one (don't emit null).
        ...(r.authorName != null ? { authorName: r.authorName } : {}),
        ...(r.guestName != null ? { guestName: r.guestName } : {}),
        body: r.body,
        createdAt: r.createdAt.toISOString(),
      }));
    },
  };
}

// ── S-003: comment / reply (CommentRepo) ───────────────────────────────────

/** Map a DB row to the CommentRow shape the reply logic expects. */
function toCommentRow(r: {
  id: string;
  annotationId: string;
  parentId: string | null;
  authorId: string | null;
  guestName: string | null;
  body: string;
}): CommentRow {
  return {
    id: r.id,
    annotationId: r.annotationId,
    parentId: r.parentId,
    authorId: r.authorId,
    guestName: r.guestName,
    body: r.body,
  };
}

/** Construct a CommentRepo backed by a Drizzle DB handle. */
export function createCommentRepo(db: DB): CommentRepo {
  return {
    async listByAnnotation(annotationId: string): Promise<CommentRow[]> {
      const rows = await db
        .select({
          id: comments.id,
          annotationId: comments.annotationId,
          parentId: comments.parentId,
          authorId: comments.authorId,
          guestName: comments.guestName,
          body: comments.body,
        })
        .from(comments)
        .where(eq(comments.annotationId, annotationId))
        .orderBy(asc(comments.createdAt)); // root(s) then replies in creation order.
      return rows.map(toCommentRow);
    },

    async insertComment(input): Promise<{ id: string }> {
      const [row] = await db
        .insert(comments)
        .values({
          annotationId: input.annotationId,
          parentId: input.parentId, // C-004: already flattened to the root by addReply.
          authorId: input.authorId,
          guestName: input.guestName,
          body: input.body,
        })
        .returning({ id: comments.id });
      return { id: row.id };
    },
  };
}

// ── S-007: guest comment (GuestCommentRepo extends CommentRepo) ─────────────

/**
 * Construct a GuestCommentRepo — the CommentRepo widened to persist the optional
 * guest_email (S-007 / AS-017). A guest comment carries guestName + (optional) guestEmail
 * and a NULL authorId; the service already sanitizes the values.
 */
export function createGuestCommentRepo(db: DB): GuestCommentRepo {
  return {
    async listByAnnotation(annotationId: string): Promise<CommentRow[]> {
      return createCommentRepo(db).listByAnnotation(annotationId);
    },

    async insertComment(input: NewGuestComment): Promise<{ id: string }> {
      const [row] = await db
        .insert(comments)
        .values({
          annotationId: input.annotationId,
          parentId: input.parentId, // null — a guest comment is top-level.
          authorId: input.authorId, // AS-017: NULL, no account.
          guestName: input.guestName,
          guestEmail: input.guestEmail ?? null, // AS-017: optional email when supplied.
          body: input.body,
        })
        .returning({ id: comments.id });
      return { id: row.id };
    },
  };
}

// ── S-004: resolve / reopen (ResolutionRepo) ───────────────────────────────

/** Construct a ResolutionRepo backed by a Drizzle DB handle. */
export function createResolutionRepo(db: DB): ResolutionRepo {
  return {
    async setAnnotationStatus(annotationId: string, status: AnnotationStatus): Promise<void> {
      // AS-009: idempotent — re-setting the same status is a harmless write.
      await db.update(annotations).set({ status }).where(eq(annotations.id, annotationId));
    },
    async resetSuggestionStatusToPending(annotationId: string): Promise<void> {
      // AS-026/C-016: owner reopen of a decided suggestion clears the decision.
      await db
        .update(annotations)
        .set({ suggestionStatus: "pending" })
        .where(eq(annotations.id, annotationId));
    },
  };
}

// ── annotation-actions S-004: delete (soft) (DeleteRepo) ───────────────────

/**
 * Construct a DeleteRepo + RestoreRepo backed by a Drizzle DB handle — stamps (S-004) and
 * clears (S-005) the soft-delete tombstone. Both ride the same factory: delete sets
 * `deleted_at`, restore clears it back to null (the durable undo, C-007).
 */
export function createDeleteRepo(db: DB): DeleteRepo & RestoreRepo {
  return {
    async setDeletedAt(annotationId: string): Promise<void> {
      // S-004/C-006: soft-delete — set the tombstone; the row is kept (S-005 excludes/restores).
      await db.update(annotations).set({ deletedAt: new Date() }).where(eq(annotations.id, annotationId));
    },
    async clearDeletedAt(annotationId: string): Promise<void> {
      // S-005/C-007: restore — clear the tombstone so the annotation returns to the active list.
      await db.update(annotations).set({ deletedAt: null }).where(eq(annotations.id, annotationId));
    },
  };
}

// ── S-006: suggestion (SuggestionRepo) ─────────────────────────────────────

/**
 * Construct a SuggestionRepo backed by a Drizzle DB handle. A suggestion rides in the
 * annotations row (type="suggestion"); the payload lives in the `suggestion` jsonb and
 * the lifecycle in `suggestion_status`. C-003: this repo NEVER writes doc/version content
 * — it only inserts a suggestion row or flips that row's suggestion_status.
 */
export function createSuggestionRepo(db: DB): SuggestionRepo {
  return {
    async insertSuggestion(row: SuggestionRow): Promise<{ id: string }> {
      const [inserted] = await db
        .insert(annotations)
        .values({
          docId: row.docId,
          type: "suggestion",
          anchor: row.anchor,
          suggestion: row.suggestion,
          suggestionStatus: row.status, // default "pending" (AS-014).
          authorId: row.authorId ?? null, // S-001/C-005: durable creator, null for a guest.
        })
        .returning({ id: annotations.id });
      return { id: inserted.id };
    },

    async getSuggestion(id: string): Promise<SuggestionRow | null> {
      const [r] = await db
        .select({
          id: annotations.id,
          docId: annotations.docId,
          anchor: annotations.anchor,
          suggestion: annotations.suggestion,
          suggestionStatus: annotations.suggestionStatus,
          // S-005 / C-007: surface the tombstone so decideSuggestion can refuse a deleted row.
          // getSuggestion deliberately does NOT filter on deleted — the decide path must FIND
          // the row to refuse it (terminal), and the restore path must find it to clear it.
          deletedAt: annotations.deletedAt,
        })
        .from(annotations)
        .where(and(eq(annotations.id, id), eq(annotations.type, "suggestion")));
      if (!r) return null;
      return {
        id: r.id,
        docId: r.docId,
        type: "suggestion",
        anchor: r.anchor as Anchor,
        suggestion: r.suggestion as SuggestionPayload,
        status: (r.suggestionStatus ?? "pending") as SuggestionStatus,
        deletedAt: r.deletedAt ?? null, // S-005 / C-007: terminal guard reads this.
      };
    },

    async setSuggestionStatus(id: string, status: SuggestionStatus): Promise<void> {
      // C-003: only the suggestion's own status — content is never touched.
      await db.update(annotations).set({ suggestionStatus: status }).where(eq(annotations.id, id));
    },
  };
}

// ── S-005: re-anchor ledger (ReanchorLedgerRepo) ───────────────────────────

/**
 * A ReanchorLedgerRepo whose getEntry reads from the ledger table, plus a persist helper
 * (persistEntry) used by the re-anchor job to record an outcome. C-012 idempotency rides
 * on UNIQUE(annotation_id, version_id): persistEntry uses INSERT … ON CONFLICT DO NOTHING
 * so a re-run for the same pair adds no duplicate row, and getEntry returns the original.
 *
 * NOTE: reanchorForVersion's ReanchorLedgerRepo.getEntry is SYNCHRONOUS (pure-logic
 * port). The DB read is async, so this factory exposes an async loader (loadEntries) the
 * caller awaits up front to build a synchronous, cached getEntry — keeping the pure
 * function pure while still consulting persisted state.
 */
export interface DrizzleReanchorLedgerRepo extends ReanchorLedgerRepo {
  /** Persist one outcome idempotently (C-012). Returns false if the pair already existed. */
  persistEntry(entry: ReanchorLedgerEntry): Promise<boolean>;
  /** Preload all ledger entries for a version into the in-memory cache getEntry reads. */
  loadEntries(versionId: string): Promise<void>;
}

export function createReanchorLedgerRepo(db: DB): DrizzleReanchorLedgerRepo {
  // Synchronous getEntry (the pure-logic port shape) reads from this cache; loadEntries
  // fills it from the DB before a run so persisted prior outcomes short-circuit recompute.
  const cache = new Map<string, ReanchorLedgerEntry>();
  const key = (annotationId: string, versionId: string) => `${annotationId}::${versionId}`;

  return {
    getEntry(annotationId: string, versionId: string): ReanchorLedgerEntry | undefined {
      return cache.get(key(annotationId, versionId));
    },

    async loadEntries(versionId: string): Promise<void> {
      const rows = await db
        .select({
          annotationId: reanchorLedger.annotationId,
          versionId: reanchorLedger.versionId,
          status: reanchorLedger.status,
          anchor: reanchorLedger.anchor,
        })
        .from(reanchorLedger)
        .where(eq(reanchorLedger.versionId, versionId));
      for (const r of rows) {
        const entry: ReanchorLedgerEntry =
          r.status === "carried"
            ? {
                annotationId: r.annotationId,
                versionId: r.versionId,
                status: "carried",
                anchor: r.anchor as Anchor,
              }
            : { annotationId: r.annotationId, versionId: r.versionId, status: "orphaned" };
        cache.set(key(r.annotationId, r.versionId), entry);
      }
    },

    async persistEntry(entry: ReanchorLedgerEntry): Promise<boolean> {
      const inserted = await db
        .insert(reanchorLedger)
        .values({
          annotationId: entry.annotationId,
          versionId: entry.versionId,
          status: entry.status,
          anchor: entry.status === "carried" ? (entry.anchor ?? null) : null,
        })
        .onConflictDoNothing({
          target: [reanchorLedger.annotationId, reanchorLedger.versionId],
        })
        .returning({ id: reanchorLedger.id });
      const didInsert = inserted.length > 0;
      // Keep the cache consistent with what is now persisted.
      cache.set(key(entry.annotationId, entry.versionId), entry);
      return didInsert;
    },
  };
}

/**
 * Apply a re-anchor outcome to the annotations table (S-005 / C-012). `applyCarried`
 * updates the anchor to the new-version positions and clears is_orphaned; `markDetached`
 * sets is_orphaned (the row's original anchor is left in place so the annotation is never
 * lost — C-002). Both writes are value-idempotent, so a re-run applies the same state.
 */
export function createReanchorApplyRepo(db: DB): ReanchorApplyRepo {
  return {
    async applyCarried(annotationId: string, anchor: Anchor): Promise<void> {
      await db
        .update(annotations)
        .set({ anchor, isOrphaned: false })
        .where(eq(annotations.id, annotationId));
    },
    async markDetached(annotationId: string): Promise<void> {
      await db
        .update(annotations)
        .set({ isOrphaned: true })
        .where(eq(annotations.id, annotationId));
    },
  };
}

// ── S-008: dismiss / re-attach a detached annotation (DismissReattachRepo) ─────

/**
 * Construct a DismissReattachRepo backed by a Drizzle DB handle (annotation-core S-008 /
 * C-013). `dismiss` stamps `dismissed_at` (the soft, kept marker that the active-read
 * excludes alongside `deleted_at`); `reattach` clears `is_orphaned` and writes the fresh
 * anchor so the annotation returns anchored. Thin write glue — the comment-permission gate +
 * the anchor-placement validation run in the service (dismiss-reattach.ts) and the route.
 */
export function createDismissReattachRepo(db: DB): DismissReattachRepo {
  return {
    async dismiss(annotationId: string): Promise<void> {
      // AS-023: soft-dismiss — set the marker; the row is kept (excluded from the active list).
      await db.update(annotations).set({ dismissedAt: new Date() }).where(eq(annotations.id, annotationId));
    },
    async reattach(annotationId: string, anchor: Anchor): Promise<void> {
      // AS-024: clear is_orphaned + set the fresh anchor → returns as an anchored annotation.
      await db.update(annotations).set({ isOrphaned: false, anchor }).where(eq(annotations.id, annotationId));
    },
  };
}
