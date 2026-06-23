// Drizzle-backed READ surface for the in-app notification bell (notifications-email S-006).
//
// Distinct from notify/repo.ts (the WRITE glue the notify service uses): this is the read +
// mark side the /api/me/notifications routes drive. THIN glue — no business logic; every query
// is scoped to a single userId (C-008 READ-OWN-ONLY) so a caller can only ever see / mutate
// their own rows. A mark scoped by (userId, id) that matches nothing is a silent no-op (the
// cross-user / already-gone case — AS-017), and `read` only ever moves false→true (C-010
// monotonic): set { read: true } re-applied is idempotent.

import { and, count, desc, eq, sql } from "drizzle-orm";
import { annotations, comments, docs, notifications, user } from "../db/schema";
import type { DB } from "../db/client";
import type { NotificationType } from "./types";

// S-006 (AS-028): the in-app comment excerpt length. The snippet is a short, truncated view of the
// comment body — IN-APP ONLY, never placed in any email (C-012/C-014). Kept generous enough to be
// useful in the panel but bounded so a long comment can't bloat the list payload.
const SNIPPET_MAX = 140;

/**
 * One notification row as the bell consumes it. The deep-link target is `/d/{slug}#annotation-{refId}`
 * — `refId` is the annotation (thread) id, and `slug` is its doc's slug, joined here so the client
 * can build the relative route `/d/:slug#annotation-:id` without a second round-trip (S-007's email
 * deep-link pattern, in-app form). `slug` is NULL when refId is not an annotation (e.g. an `invited`
 * row) or the annotation/doc is gone — the client then falls back (no deep-link, just mark-read).
 */
export interface NotificationRow {
  id: string;
  type: NotificationType;
  refId: string;
  read: boolean;
  createdAt: Date;
  slug: string | null;
  /**
   * workspace-notifications S-001 (F1): the display label SNAPSHOTTED at emit (e.g. the workspace
   * name for a `workspace_invited` row). Rendered DIRECTLY by the bell for workspace types — NOT a
   * live `workspaces` join (a live join would leak the CURRENT name to a since-removed member, and
   * the refId→annotations→docs enrichment returns null for a workspace id anyway). Null for
   * annotation/doc rows (those still enrich via docTitle/slug).
   */
  refLabel: string | null;
  /**
   * S-006 panel enrichment (all NULL-safe, C-014):
   * - docTitle: the row's doc title (refId→annotation→doc); null for a non-doc row (e.g. `invited`)
   *   or when the annotation/doc is gone (AS-026/AS-029).
   * - actorName: the triggering commenter's display name — the member's `user.name`, or the guest's
   *   `comments.guest_name` — for a comment-type row; null when there's no comment_id or it resolves
   *   to nothing (deleted comment / non-comment row), AS-027/AS-029.
   * - snippet: a short truncated excerpt of the triggering comment body, IN-APP ONLY (AS-028); null
   *   when there's no resolvable comment. NEVER placed in email (C-012/C-014).
   */
  docTitle: string | null;
  actorName: string | null;
  snippet: string | null;
}

export interface NotificationReadRepo {
  /** Total notifications for the user (drives pagination's `total`). */
  countForUser(userId: string): Promise<number>;
  /** A page of the user's notifications, newest-first. */
  listForUser(userId: string, opts: { offset: number; limit: number }): Promise<NotificationRow[]>;
  /** Count of the user's UNREAD rows (the bell badge). */
  countUnreadForUser(userId: string): Promise<number>;
  /** Mark ONE row read — scoped to (userId, id). Not the user's row → no-op (AS-017). */
  markRead(userId: string, id: string): Promise<void>;
  /** Mark every unread row read for the user; returns how many rows flipped. */
  markAllRead(userId: string): Promise<number>;
}

export function createNotificationReadRepo(db: DB): NotificationReadRepo {
  return {
    async countForUser(userId) {
      const [row] = await db
        .select({ n: count() })
        .from(notifications)
        .where(eq(notifications.userId, userId));
      return Number(row?.n ?? 0);
    },

    async listForUser(userId, { offset, limit }) {
      // LEFT JOIN annotations → docs so each row carries its doc slug + title for the deep-link and
      // the panel summary. S-006 enrichment: also LEFT JOIN the triggering comment (on
      // notifications.comment_id) and its member author (on comments.author_id) so a comment-type
      // row carries actorName + a body excerpt. Every join is LEFT (not inner) and NULL-safe (C-014):
      // a non-doc row (e.g. `invited`), a non-comment row, or a row whose comment/doc is gone simply
      // returns NULLs for the missing fields — the panel then renders its generic per-type summary.
      const rows = await db
        .select({
          id: notifications.id,
          type: notifications.type,
          refId: notifications.refId,
          read: notifications.read,
          createdAt: notifications.createdAt,
          slug: docs.slug,
          docTitle: docs.title,
          // workspace-notifications S-001 (F1): the emit-time label snapshot, rendered as-is for
          // workspace rows. NO live workspaces join (would leak a removed member the current name).
          refLabel: notifications.refLabel,
          // actorName = the member's name, falling back to the guest's typed name (AS-027).
          memberName: user.name,
          guestName: comments.guestName,
          // AS-028: a truncated excerpt of the comment body — built in SQL so a long body never
          // ships in full. IN-APP ONLY (C-012/C-014). NULL when there is no resolvable comment.
          snippet: sql<string | null>`left(${comments.body}, ${SNIPPET_MAX})`,
        })
        .from(notifications)
        .leftJoin(annotations, eq(annotations.id, notifications.refId))
        .leftJoin(docs, eq(docs.id, annotations.docId))
        .leftJoin(comments, eq(comments.id, notifications.commentId))
        .leftJoin(user, eq(user.id, comments.authorId))
        .where(eq(notifications.userId, userId))
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .offset(offset)
        .limit(limit);
      return rows.map((r) => ({
        id: r.id,
        type: r.type,
        refId: r.refId,
        read: r.read,
        createdAt: r.createdAt,
        slug: r.slug ?? null,
        docTitle: r.docTitle ?? null,
        refLabel: r.refLabel ?? null,
        // Member name wins; else the guest's typed name; else null (no resolvable comment, AS-029).
        actorName: r.memberName ?? r.guestName ?? null,
        snippet: r.snippet ?? null,
      })) as NotificationRow[];
    },

    async countUnreadForUser(userId) {
      const [row] = await db
        .select({ n: count() })
        .from(notifications)
        .where(and(eq(notifications.userId, userId), eq(notifications.read, false)));
      return Number(row?.n ?? 0);
    },

    async markRead(userId, id) {
      // Scoped by BOTH userId AND id: a foreign id (Carol's row) matches no row for Bob, so the
      // update is a no-op — never a 403 that would disclose the row exists (C-008/AS-017). Setting
      // read=true on an already-read row is idempotent (C-010).
      await db
        .update(notifications)
        .set({ read: true })
        .where(and(eq(notifications.userId, userId), eq(notifications.id, id)));
    },

    async markAllRead(userId) {
      // Only the user's still-unread rows flip — nothing unread → 0 rows touched (C-010 no-op).
      const flipped = await db
        .update(notifications)
        .set({ read: true })
        .where(and(eq(notifications.userId, userId), eq(notifications.read, false)))
        .returning({ id: notifications.id });
      return flipped.length;
    },
  };
}
