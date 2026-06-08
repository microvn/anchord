// Drizzle-backed reads + the one write the notify service (src/notify/notify.ts)
// needs for "notify on reply" (workspace-project S-006, AS-011 / C-004). THIN glue,
// mirroring src/annotation/repo.ts: no business logic lives here — the recipient-set
// computation, dedup, and replier-exclusion all run in the service; this only reads
// thread participants / doc owner / a recipient's email and inserts a notification row.
//
// Integration-verified against a real Postgres in test/integration/notify.itest.ts.

import { and, eq, isNotNull } from "drizzle-orm";
import { annotations, comments, docs, notifications, user } from "../db/schema";
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

    async getUserEmail(userId: string): Promise<string | null> {
      const [row] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId));
      return row?.email ?? null;
    },

    async insertNotification(input: NewNotification): Promise<{ id: string }> {
      const [row] = await db
        .insert(notifications)
        .values({ userId: input.userId, type: input.type, refId: input.refId })
        .returning({ id: notifications.id });
      return { id: row.id };
    },
  };
}
