// Drizzle-backed repositories for the annotation-core cluster (S-001 create/read,
// S-003 reply, S-004 resolve, S-005 re-anchor ledger, S-006 suggestion, S-007 guest).
// THIN glue between the service modules and Postgres, mirroring src/publish/repo.ts
// (createDocRepo) and src/services/version-repo.ts (createVersionRepo). No business
// logic lives here — every authz/guard/flatten/stale check already runs in the service
// modules; these factories only read and write rows. Integration-verified against a real
// Postgres in test/integration/annotation-repo.itest.ts.

import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { annotations, anchorResolution, comments, user } from "../db/schema";
import type { DB } from "../db/client";
import type { Anchor } from "./annotation";
import type {
  AnnotationRepo,
  AnnotationRow,
  AnnotationType,
  NewAnnotation,
  NewFirstComment,
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
          suggestion: input.suggestion ?? null, // C-018/S-006: payload when a suggestion-create.
          suggestionStatus: input.suggestionStatus ?? null,
        })
        .returning({ id: annotations.id });
      return { id: row.id };
    },

    // C-018: the annotation row + its first comment in ONE transaction (and the updated_at bump
    // a freshly-commented annotation already carries from its create timestamp). A failure of
    // EITHER insert rolls the WHOLE transaction back — no orphan annotation with no comment is
    // ever committed (the bug this fixes). Omit `comment` to create a commentless annotation.
    async insertAnnotationWithComment(
      annotation: NewAnnotation,
      comment?: NewFirstComment,
    ): Promise<{ id: string; commentId?: string }> {
      return db.transaction(async (tx) => {
        const [annRow] = await tx
          .insert(annotations)
          .values({
            docId: annotation.docId,
            type: annotation.type,
            anchor: annotation.anchor, // AS-003: stored verbatim with the chosen block_id.
            label: annotation.label ?? null,
            authorId: annotation.authorId ?? null,
            suggestion: annotation.suggestion ?? null,
            suggestionStatus: annotation.suggestionStatus ?? null,
          })
          .returning({ id: annotations.id });
        if (comment === undefined) return { id: annRow.id };
        // The first comment is top-level (parentId null). It is inserted in the SAME tx, so if it
        // fails the annotation insert above is rolled back too (atomicity, C-018). The values are
        // already sanitized by the service (C-008).
        const [cRow] = await tx
          .insert(comments)
          .values({
            annotationId: annRow.id,
            parentId: null,
            authorId: comment.authorId,
            guestName: comment.guestName,
            guestEmail: comment.guestEmail ?? null,
            body: comment.body,
          })
          .returning({ id: comments.id });
        return { id: annRow.id, commentId: cRow.id };
      });
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
      // C-017: a comment/reply bumps its PARENT annotation's updated_at (in the same tx) so a
      // reply on an OLD annotation surfaces in that annotation's changed-since pull (AS-008).
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(comments)
          .values({
            annotationId: input.annotationId,
            parentId: input.parentId, // C-004: already flattened to the root by addReply.
            authorId: input.authorId,
            guestName: input.guestName,
            body: input.body,
          })
          .returning({ id: comments.id });
        await tx
          .update(annotations)
          .set({ updatedAt: new Date() })
          .where(eq(annotations.id, input.annotationId));
        return { id: row.id };
      });
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
      // C-017: a guest comment ALSO bumps its parent annotation's updated_at (same tx) so a
      // guest reply on an old annotation surfaces in the changed-since pull (AS-008).
      return db.transaction(async (tx) => {
        const [row] = await tx
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
        await tx
          .update(annotations)
          .set({ updatedAt: new Date() })
          .where(eq(annotations.id, input.annotationId));
        return { id: row.id };
      });
    },
  };
}

// ── S-004: resolve / reopen (ResolutionRepo) ───────────────────────────────

/** Construct a ResolutionRepo backed by a Drizzle DB handle. */
export function createResolutionRepo(db: DB): ResolutionRepo {
  return {
    async setAnnotationStatus(annotationId: string, status: AnnotationStatus): Promise<void> {
      // AS-009: idempotent — re-setting the same status is a harmless write.
      // C-017: resolve/reopen bumps updated_at so it surfaces in a changed-since pull.
      await db
        .update(annotations)
        .set({ status, updatedAt: new Date() })
        .where(eq(annotations.id, annotationId));
    },
    async resetSuggestionStatusToPending(annotationId: string): Promise<void> {
      // AS-026/C-016: owner reopen of a decided suggestion clears the decision.
      // C-017: a suggestion-decision reset is a mutation — bump updated_at.
      await db
        .update(annotations)
        .set({ suggestionStatus: "pending", updatedAt: new Date() })
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
      // C-017: delete is a mutation — bump updated_at so a pull sees the new deleted status.
      await db
        .update(annotations)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(annotations.id, annotationId));
    },
    async clearDeletedAt(annotationId: string): Promise<void> {
      // S-005/C-007: restore — clear the tombstone so the annotation returns to the active list.
      // C-017: restore is a mutation — bump updated_at.
      await db
        .update(annotations)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(eq(annotations.id, annotationId));
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
      // C-017: suggestion-decide (accept/reject/stale) bumps updated_at for changed-since.
      await db
        .update(annotations)
        .set({ suggestionStatus: status, updatedAt: new Date() })
        .where(eq(annotations.id, id));
    },
  };
}

// ── annotation-reanchor S-003 / C-005: immutable per-version resolution record ──

/**
 * A ReanchorLedgerRepo backed by the `anchor_resolution` table — the DEEPENED persistence of
 * C-012 (annotation-reanchor:S-003). It records ONE immutable row per (annotation, version)
 * carrying status + the winning method + confidence + the resolved span, and makes a re-run a
 * no-op (C-005): `getEntry` short-circuits recompute from the persisted row, and `persistEntry`
 * is INSERT … ON CONFLICT DO NOTHING on UNIQUE(annotation_id, version_id) so the row is written
 * once and never rewritten / double-applied.
 *
 * Same shape as DrizzleReanchorLedgerRepo (the pure-logic port wants a SYNCHRONOUS getEntry, so
 * `loadEntries` preloads the version's rows into an in-memory cache up front; the matcher then
 * reads the cache synchronously). The resolved span (block_id/offset/length) is reconstructed
 * onto the carried anchor on load so a reused entry is identical to a freshly computed one.
 */
export interface DrizzleAnchorResolutionRepo extends ReanchorLedgerRepo {
  /** Persist one outcome idempotently (C-005). Returns false if the pair already existed. */
  persistEntry(entry: ReanchorLedgerEntry): Promise<boolean>;
  /** Preload all resolution rows for a version into the in-memory cache getEntry reads. */
  loadEntries(versionId: string): Promise<void>;
}

/** carried ⇄ anchored mapping between the matcher's ledger status and the table's enum (C-005). */
function toResolutionStatus(status: ReanchorLedgerEntry["status"]): "anchored" | "orphaned" {
  return status === "carried" ? "anchored" : "orphaned";
}

export function createAnchorResolutionRepo(db: DB): DrizzleAnchorResolutionRepo {
  const cache = new Map<string, ReanchorLedgerEntry>();
  const key = (annotationId: string, versionId: string) => `${annotationId}::${versionId}`;

  return {
    getEntry(annotationId: string, versionId: string): ReanchorLedgerEntry | undefined {
      return cache.get(key(annotationId, versionId));
    },

    async loadEntries(versionId: string): Promise<void> {
      const rows = await db
        .select({
          annotationId: anchorResolution.annotationId,
          versionId: anchorResolution.versionId,
          status: anchorResolution.status,
          method: anchorResolution.method,
          confidence: anchorResolution.confidence,
          blockId: anchorResolution.blockId,
          offset: anchorResolution.offset,
          length: anchorResolution.length,
        })
        .from(anchorResolution)
        .where(eq(anchorResolution.versionId, versionId));
      for (const r of rows) {
        const entry: ReanchorLedgerEntry =
          r.status === "anchored"
            ? {
                annotationId: r.annotationId,
                versionId: r.versionId,
                status: "carried",
                // Reconstruct the resolved span onto the anchor so a reused entry equals a fresh one.
                anchor: {
                  blockId: r.blockId ?? "",
                  textSnippet: "",
                  offset: r.offset ?? 0,
                  length: r.length ?? 0,
                } as Anchor,
                method: (r.method ?? undefined) as ReanchorLedgerEntry["method"],
                confidence: r.confidence ?? undefined,
              }
            : { annotationId: r.annotationId, versionId: r.versionId, status: "orphaned" };
        cache.set(key(r.annotationId, r.versionId), entry);
      }
    },

    async persistEntry(entry: ReanchorLedgerEntry): Promise<boolean> {
      const anchored = entry.status === "carried";
      const span = anchored ? entry.anchor : undefined;
      const inserted = await db
        .insert(anchorResolution)
        .values({
          annotationId: entry.annotationId,
          versionId: entry.versionId,
          status: toResolutionStatus(entry.status),
          // C-005: method + confidence + resolved span recorded only when anchored.
          method: anchored ? ((entry.method ?? null) as never) : null,
          confidence: anchored ? (entry.confidence ?? null) : null,
          blockId: span?.blockId ?? null,
          offset: span?.offset ?? null,
          length: span?.length ?? null,
        })
        .onConflictDoNothing({
          target: [anchorResolution.annotationId, anchorResolution.versionId],
        })
        .returning({ id: anchorResolution.id });
      const didInsert = inserted.length > 0;
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
      // C-017: re-anchor (carried onto a new version) is a mutation — bump updated_at.
      await db
        .update(annotations)
        .set({ anchor, isOrphaned: false, updatedAt: new Date() })
        .where(eq(annotations.id, annotationId));
    },
    async markDetached(annotationId: string): Promise<void> {
      // C-017: re-anchor that DETACHED (>25% drift, lost block/snippet) is a mutation too —
      // an agent must see the annotation went orphaned in a changed-since pull. Easy to miss.
      await db
        .update(annotations)
        .set({ isOrphaned: true, updatedAt: new Date() })
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
      // C-017: dismiss is a mutation — bump updated_at.
      await db
        .update(annotations)
        .set({ dismissedAt: new Date(), updatedAt: new Date() })
        .where(eq(annotations.id, annotationId));
    },
    async reattach(annotationId: string, anchor: Anchor): Promise<void> {
      // AS-024: clear is_orphaned + set the fresh anchor → returns as an anchored annotation.
      // C-017: unorphan/relocate is a mutation — bump updated_at.
      await db
        .update(annotations)
        .set({ isOrphaned: false, anchor, updatedAt: new Date() })
        .where(eq(annotations.id, annotationId));
    },
  };
}
