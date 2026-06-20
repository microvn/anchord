import { api } from "@/lib/api";
import type { EdenResult } from "@/lib/api/use-api-query";
import type { NotificationPage } from "@/features/notifications/types";

// Typed request thunks for the in-app notification bell (notifications-email S-006) —
// `GET /api/me/notifications`, `GET /api/me/notifications/unread-count`,
// `POST /api/me/notifications/:id/read`, `POST /api/me/notifications/read-all`.
//
// Same pattern + rationale as workspaces/settings clients: the backend mounts these routes
// CONDITIONALLY (`if (deps.notifications) …`), so the exported treaty type doesn't surface them
// through chaining. We reach them through the same runtime treaty client (it resolves paths
// dynamically) and annotate the return ourselves. `App` stays the real type — this is the one
// place the cast lives; component/hook tests mock THIS module, so the cast is never exercised.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const treaty = api as any;

/** GET /api/me/notifications — the caller's recent notifications, newest-first, paginated. */
export function listNotifications(page = 1): Promise<EdenResult<NotificationPage>> {
  return treaty.api.me.notifications.get({ query: { page } }) as Promise<EdenResult<NotificationPage>>;
}

/** GET /api/me/notifications/unread-count — the unread badge count. */
export function fetchUnreadCount(): Promise<EdenResult<{ count: number }>> {
  return treaty.api.me.notifications["unread-count"].get() as Promise<EdenResult<{ count: number }>>;
}

/** POST /api/me/notifications/:id/read — mark ONE row read (no-op if not the caller's). */
export function markNotificationRead(id: string): Promise<EdenResult<{ read: boolean }>> {
  return treaty.api.me.notifications({ id }).read.post() as Promise<EdenResult<{ read: boolean }>>;
}

/** POST /api/me/notifications/read-all — mark every unread row read. */
export function markAllNotificationsRead(): Promise<EdenResult<{ marked: number }>> {
  return treaty.api.me.notifications["read-all"].post() as Promise<EdenResult<{ marked: number }>>;
}
