// Drizzle-backed reads + the one write the notify service (src/notify/notify.ts)
// needs for "notify on reply" (workspace-project S-006, AS-011 / C-004). THIN glue,
// mirroring src/annotation/repo.ts: no business logic lives here — the recipient-set
// computation, dedup, and replier-exclusion all run in the service; this only reads
// thread participants / doc owner / a recipient's email and inserts a notification row.
//
// Integration-verified against a real Postgres in test/integration/notify.itest.ts.

import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  annotations,
  comments,
  docMembers,
  docs,
  notifications,
  user,
  workspaceMembers,
  workspaces,
} from "../db/schema";
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

    // workspace-notifications S-001: resolve an account user id by email (the invitee path). Returns
    // null when no account exists for the email (a pending invite to an account-less address → no
    // in-app row, AS-002). The tenancy service normalizes invited emails to lowercase before storing,
    // so match on lower(email) to stay case-insensitive against the better-auth user table.
    async findUserIdByEmail(email: string): Promise<string | null> {
      const normalized = email.trim().toLowerCase();
      const [row] = await db
        .select({ id: user.id })
        .from(user)
        .where(eq(sql`lower(${user.email})`, normalized));
      return row?.id ?? null;
    },

    // workspace-notifications S-001: every ADMIN's user id in the workspace (S-002 join-notify
    // consumes it). Real query against workspace_members, not a no-op.
    async listWorkspaceAdminIds(workspaceId: string): Promise<string[]> {
      const rows = await db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "admin")));
      return rows.map((r) => r.userId);
    },

    // workspace-notifications S-001: every MEMBER's user id (admins + members) in the workspace
    // (S-004 rename-notify consumes it). Real query against workspace_members.
    async listWorkspaceMemberIds(workspaceId: string): Promise<string[]> {
      const rows = await db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, workspaceId));
      return rows.map((r) => r.userId);
    },

    // workspace-notifications S-002: the workspace's CURRENT name — snapshotted into the
    // workspace_member_joined refLabel at emit (F1, rendered without a live join). Null when the
    // workspace row can't be resolved (then the dispatch snapshots an empty/sanitized label).
    async getWorkspaceName(workspaceId: string): Promise<string | null> {
      const [row] = await db
        .select({ name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      return row?.name ?? null;
    },

    // workspace-notifications S-002: a user's DISPLAY NAME (user.name — never email, F-security),
    // for the join notice copy. Null when absent.
    async getUserName(userId: string): Promise<string | null> {
      const [row] = await db.select({ name: user.name }).from(user).where(eq(user.id, userId));
      return row?.name ?? null;
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
        .values({
          userId: input.userId,
          type: input.type,
          refId: input.refId,
          // S-006: the triggering comment for a comment-type row (AS-027/AS-028); null otherwise.
          commentId: input.commentId ?? null,
          // workspace-notifications S-001 (F1): the snapshotted display label for a workspace row
          // (e.g. the workspace name); null for annotation/doc rows (they enrich via refId→docs).
          refLabel: input.refLabel ?? null,
        })
        .returning({ id: notifications.id });
      return { id: row.id };
    },

    // workspace-notifications S-002 (C-005): BATCH-insert N rows in ONE round-trip — a single
    // Drizzle insert().values([...]), NOT a serial per-recipient loop. Backs the join fan-out (all
    // admins) and the S-004 rename fan-out (all members). Returns the inserted ids in row order. An
    // empty input never reaches here (the dispatch guards a 0-recipient set), but stays a no-op if it does.
    async insertNotifications(rows: NewNotification[]): Promise<{ id: string }[]> {
      if (rows.length === 0) return [];
      const out = await db
        .insert(notifications)
        .values(
          rows.map((input) => ({
            userId: input.userId,
            type: input.type,
            refId: input.refId,
            commentId: input.commentId ?? null,
            refLabel: input.refLabel ?? null,
          })),
        )
        .returning({ id: notifications.id });
      return out.map((r) => ({ id: r.id }));
    },
  };
}
