// HTTP route mount for the in-app notification READ surface (notifications-email S-006).
//
// USER-scoped, NOT workspace-scoped — a notification is personal (C-008): the gate is
// requireSession + actor.userId alone, never a /api/w/:workspaceId path. The earlier
// stories WRITE rows into the notifications table; this reads them back for the bell.
//
// Contract (all under /api/me/notifications, all session-gated, all scoped WHERE userId = actor.userId):
//   GET    /api/me/notifications?page=&limit=   → 200 { items, pagination }  recent-first (AS-012)
//   GET    /api/me/notifications/unread-count    → 200 { count }              (AS-013)
//   POST   /api/me/notifications/:id/read        → 200 { read: true }         mark ONE read (AS-014/C-009)
//   POST   /api/me/notifications/read-all        → 200 { marked }             mark all read (AS-015)
//
// C-008 READ-OWN-ONLY: every read + every mark is scoped to actor.userId. A cross-user mark is
// a NO-OP (the WHERE clause matches no row), never a 403 that would leak the row's existence
// (AS-017). C-010 idempotency: marking an already-read row, or read-all with nothing unread, is a
// no-op; `read` is monotonic to true (last-write-wins) — re-marking never flips it back.

import { Elysia } from "elysia";
import { apiEnvelope } from "../http/envelope";
import { requireSession, type SessionResolver } from "../http/auth-gate";
import { paginationQuery, paginate, type PaginationParams } from "../http/pagination";
import { createNotificationReadRepo, type NotificationReadRepo } from "../notify/read-repo";
import type { DB } from "../db/client";

// Bell page size: default 20, cap 50 (the recent-N surface — no infinite scroll in v0).
const notificationsPage = paginationQuery({ defaultLimit: 20, maxLimit: 50 });

export interface NotificationsRoutesDeps {
  db?: DB;
  /** Pre-built read repo (tests). Wins over `db`. */
  repo?: NotificationReadRepo;
  resolveSession: SessionResolver;
}

export function notificationsRoutes(deps: NotificationsRoutesDeps) {
  const repo: NotificationReadRepo =
    deps.repo ??
    (() => {
      if (!deps.db) throw new Error("notificationsRoutes requires either `repo` or `db`");
      return createNotificationReadRepo(deps.db);
    })();

  return apiEnvelope(new Elysia())
    .use(requireSession({ resolveSession: deps.resolveSession }))
    // GET /api/me/notifications — the caller's recent notifications, newest-first, paginated.
    // C-008: only rows WHERE user_id = actor.userId — another user's rows never appear (AS-012/AS-017).
    .get("/api/me/notifications", async ({ query, actor }) => {
      const page = notificationsPage.parse(query) as PaginationParams;
      const total = await repo.countForUser(actor.userId);
      const items = await repo.listForUser(actor.userId, {
        offset: (page.page - 1) * page.limit,
        limit: page.limit,
      });
      return paginate(items, { page: page.page, limit: page.limit, total });
    })
    // GET /api/me/notifications/unread-count — how many of the caller's rows are unread (AS-013).
    .get("/api/me/notifications/unread-count", async ({ actor }) => {
      const count = await repo.countUnreadForUser(actor.userId);
      return { count };
    })
    // POST /api/me/notifications/:id/read — mark ONE row read. Scoped to actor.userId, so marking
    // a row that is not the caller's matches nothing → no-op (AS-017), and re-marking an already-read
    // row is idempotent (C-010). Always returns { read: true } — the unread badge derives from the
    // unread-count read, not from this response, so a no-op and a real flip look identical to the client.
    .post("/api/me/notifications/:id/read", async ({ params, actor }) => {
      await repo.markRead(actor.userId, params.id);
      return { read: true };
    })
    // POST /api/me/notifications/read-all — mark every unread row read for the caller (AS-015).
    // Nothing unread → 0 rows touched (C-010 idempotent). Returns the count of rows flipped.
    .post("/api/me/notifications/read-all", async ({ actor }) => {
      const marked = await repo.markAllRead(actor.userId);
      return { marked };
    });
}
