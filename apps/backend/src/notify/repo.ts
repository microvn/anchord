// Drizzle-backed reads + the one write the notify service (src/notify/notify.ts)
// needs for "notify on reply" (workspace-project S-006, AS-011 / C-004). THIN glue,
// mirroring src/annotation/repo.ts: no business logic lives here — the recipient-set
// computation, dedup, and replier-exclusion all run in the service; this only reads
// thread participants / doc owner / a recipient's email and inserts a notification row.
//
// Integration-verified against a real Postgres in test/integration/notify.itest.ts.

import { and, eq, isNotNull } from "drizzle-orm";
import { annotations, comments, docMembers, docs, notifications, user } from "../db/schema";
import type { DB } from "../db/client";
import type { NewNotification, NotifyRepo } from "./notify";

/**
 * Construct a NotifyRepo backed by a Drizzle DB handle.
 *
 * - listParticipantIds: DISTINCT account-holder author_id of every comment on the
 *   annotation. A guest comment has a NULL author_id (no account) → excluded by the
 *   isNotNull filter, so a guest is never an in-app recipient and the null never
 *   reaches the recipient set.
 * - getDocOwnerId: the annotation's doc's owner_id (NULLABLE — a doc published without
 *   a session has no owner → null → the service skips the owner).
 * - getUserEmail: the recipient's email off the user row (for the EMAIL channel).
 * - insertNotification: one in-app row (type='reply', ref_id, read=false default).
 */
export function createNotifyRepo(db: DB): NotifyRepo {
  return {
    async listParticipantIds(annotationId: string): Promise<string[]> {
      const rows = await db
        .selectDistinct({ authorId: comments.authorId })
        .from(comments)
        .where(and(eq(comments.annotationId, annotationId), isNotNull(comments.authorId)));
      // isNotNull guarantees authorId is non-null, but the column type is nullable —
      // narrow explicitly so the returned array is string[].
      return rows.map((r) => r.authorId).filter((id): id is string => id != null);
    },

    async getDocOwnerId(annotationId: string): Promise<string | null> {
      const [row] = await db
        .select({ ownerId: docs.ownerId })
        .from(annotations)
        .innerJoin(docs, eq(docs.id, annotations.docId))
        .where(eq(annotations.id, annotationId));
      return row?.ownerId ?? null;
    },

    // S-001 (new_feedback): DISTINCT account-holder user_ids that are ACTIVE EDITORS on the
    // annotation's doc. Joins annotations → doc_members on the doc, filtered to role='editor',
    // status='active', and a bound (non-null) user_id (a pending invite has no account yet, so
    // it is never a recipient). The owner is NOT here (owner is no doc_members row) — the service
    // unions the owner in separately and dedups (C-005).
    async listEditorIds(annotationId: string): Promise<string[]> {
      const rows = await db
        .selectDistinct({ userId: docMembers.userId })
        .from(annotations)
        .innerJoin(docMembers, eq(docMembers.docId, annotations.docId))
        .where(
          and(
            eq(annotations.id, annotationId),
            eq(docMembers.role, "editor"),
            eq(docMembers.status, "active"),
            isNotNull(docMembers.userId),
          ),
        );
      return rows.map((r) => r.userId).filter((id): id is string => id != null);
    },

    async getUserEmail(userId: string): Promise<string | null> {
      const [row] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId));
      return row?.email ?? null;
    },

    // S-007: the annotation's doc slug — backs the email deep-link {APP_URL}/d/{slug}#annotation-{id}.
    async getDocSlug(annotationId: string): Promise<string | null> {
      const [row] = await db
        .select({ slug: docs.slug })
        .from(annotations)
        .innerJoin(docs, eq(docs.id, annotations.docId))
        .where(eq(annotations.id, annotationId));
      return row?.slug ?? null;
    },

    async insertNotification(input: NewNotification): Promise<{ id: string }> {
      // S-001 extended the `notification_type` pgEnum additively to the full taxonomy, so the
      // service-level NotificationType now persists directly — the S-007 `as "reply"` boundary
      // cast (which existed only while the DB enum was still `["reply"]`) is gone.
      const [row] = await db
        .insert(notifications)
        .values({ userId: input.userId, type: input.type, refId: input.refId })
        .returning({ id: notifications.id });
      return { id: row.id };
    },
  };
}
