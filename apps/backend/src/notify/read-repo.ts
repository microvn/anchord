// Drizzle-backed READ surface for the in-app notification bell (notifications-email S-006).
//
// Distinct from notify/repo.ts (the WRITE glue the notify service uses): this is the read +
// mark side the /api/me/notifications routes drive. THIN glue — no business logic; every query
// is scoped to a single userId (C-008 READ-OWN-ONLY) so a caller can only ever see / mutate
// their own rows. A mark scoped by (userId, id) that matches nothing is a silent no-op (the
// cross-user / already-gone case — AS-017), and `read` only ever moves false→true (C-010
// monotonic): set { read: true } re-applied is idempotent.

import { and, count, desc, eq } from "drizzle-orm";
import { annotations, docs, notifications } from "../db/schema";
import type { DB } from "../db/client";
import type { NotificationType } from "./types";

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
      // LEFT JOIN annotations → docs so each row carries its doc slug for the deep-link. LEFT (not
      // inner) so a row whose refId isn't an annotation (e.g. `invited`) still returns, with slug null.
      const rows = await db
        .select({
          id: notifications.id,
          type: notifications.type,
          refId: notifications.refId,
          read: notifications.read,
          createdAt: notifications.createdAt,
          slug: docs.slug,
        })
        .from(notifications)
        .leftJoin(annotations, eq(annotations.id, notifications.refId))
        .leftJoin(docs, eq(docs.id, annotations.docId))
        .where(eq(notifications.userId, userId))
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .offset(offset)
        .limit(limit);
      return rows.map((r) => ({ ...r, slug: r.slug ?? null })) as NotificationRow[];
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
