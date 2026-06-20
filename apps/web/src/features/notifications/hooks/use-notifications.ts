import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApiQuery } from "@/lib/api/use-api-query";
import { unwrapEnvelope } from "@/features/workspaces/hooks/use-bootstrap";
import {
  listNotifications,
  fetchUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
} from "@/features/notifications/services/client";
import type { NotificationPage } from "@/features/notifications/types";

// React Query owns the notification server state (notifications-email S-006). Notifications are
// USER-scoped, NOT workspace-scoped (C-008) — so the keys are top-level (`["me","notifications",…]`),
// NOT under the workspace key tree, mirroring the settings/tokens slice.
//
// GAP-003 (recorded decision): the unread count is POLLED on a 45s `refetchInterval` (a quiet
// cadence — async review is not real-time; 45s keeps the badge fresh without chattering). The
// badge caps display at "9+" (see <UnreadBadge/>). Both are UI-only, not behavior-shaping.

const LIST_KEY = ["me", "notifications", "list"] as const;
const COUNT_KEY = ["me", "notifications", "unread-count"] as const;

/** GAP-003: poll the unread count every 45s. */
const UNREAD_POLL_MS = 45_000;

/** AS-013/AS-016: the unread badge count, polled. Always enabled (the bell is always mounted). */
export function useUnreadCount() {
  return useApiQuery<{ count: number }>(COUNT_KEY, () => fetchUnreadCount(), {
    refetchInterval: UNREAD_POLL_MS,
  });
}

/**
 * AS-012/AS-016: the recent notifications page (newest-first). Gated by `enabled` so the list only
 * fetches when the panel is OPEN — opening the bell triggers the read, but reading the list does NOT
 * mark anything read (C-009: clearing is on CLICK, never on open).
 */
export function useNotifications(enabled: boolean) {
  return useApiQuery<NotificationPage>(LIST_KEY, () => listNotifications(1), { enabled });
}

/**
 * AS-014/C-009/C-010: mark ONE notification read on CLICK. On success, invalidate the list + the
 * unread count so the row flips and the badge decrements. Idempotent server-side (re-marking a read
 * row is a no-op), so a double-click is harmless.
 */
export function useMarkRead() {
  const queryClient = useQueryClient();
  return useMutation<{ read: boolean }, Error, string>({
    mutationFn: async (id) => {
      const res = unwrapEnvelope<{ read: boolean }>(await markNotificationRead(id));
      if (res.error || !res.data) throw new Error("mark-read-failed");
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: LIST_KEY });
      void queryClient.invalidateQueries({ queryKey: COUNT_KEY });
    },
  });
}

/** AS-015: mark ALL read, then invalidate the list + count so every row flips and the badge clears. */
export function useMarkAllRead() {
  const queryClient = useQueryClient();
  return useMutation<{ marked: number }, Error, void>({
    mutationFn: async () => {
      const res = unwrapEnvelope<{ marked: number }>(await markAllNotificationsRead());
      if (res.error || !res.data) throw new Error("mark-all-read-failed");
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: LIST_KEY });
      void queryClient.invalidateQueries({ queryKey: COUNT_KEY });
    },
  });
}
