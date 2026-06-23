import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useApiQuery } from "@/lib/api/use-api-query";
import { unwrapEnvelope } from "@/features/workspaces/hooks/use-bootstrap";
import {
  fetchNotificationPreferences,
  updateNotificationPreference,
} from "@/features/notifications/services/client";
import type {
  NotificationPreferences,
  PreferenceOverrideInput,
} from "@/features/notifications/types/preferences";

// React Query owns the notification-preferences server state (notification-preferences S-003).
// Account-level, not workspace-scoped (preferences sync across devices — email is sent by the
// backend), so the key is top-level, mirroring the tokens/notifications slices.
//
// GAP-001 (resolved → AS-009): LIVE per-toggle save — each switch persists on change OPTIMISTICALLY
// (the UI flips immediately), reverts + toasts on failure, with NO explicit Save button. Mirrors the
// AppearanceSection apply-immediately pattern.

const PREFS_KEY = ["me", "notifications", "preferences"] as const;

/** AS-008/AS-012: the caller's effective preferences — the live taxonomy the section renders from. */
export function useNotificationPreferences() {
  return useApiQuery<NotificationPreferences>(PREFS_KEY, () => fetchNotificationPreferences());
}

/**
 * AS-009: persist one (type, channel, enabled) override, optimistically. On error, roll the cache
 * back to the pre-toggle snapshot and toast — the switch visibly reverts. On success the server's
 * recomputed effective set replaces the cache (so a locked/unsupported edge can never stick).
 */
export function useUpdateNotificationPreference() {
  const queryClient = useQueryClient();
  return useMutation<
    NotificationPreferences,
    Error,
    PreferenceOverrideInput,
    { previous: NotificationPreferences | undefined }
  >({
    mutationFn: async (override) => {
      const res = unwrapEnvelope<NotificationPreferences>(await updateNotificationPreference(override));
      if (res.error || !res.data) throw new Error("update-preference-failed");
      return res.data;
    },
    onMutate: async (override) => {
      // Cancel in-flight reads so an optimistic write isn't clobbered by a stale refetch.
      await queryClient.cancelQueries({ queryKey: PREFS_KEY });
      const previous = queryClient.getQueryData<NotificationPreferences>(PREFS_KEY);
      if (previous) {
        queryClient.setQueryData<NotificationPreferences>(PREFS_KEY, {
          ...previous,
          preferences: previous.preferences.map((p) =>
            p.type === override.type && p.channel === override.channel
              ? { ...p, enabled: override.enabled }
              : p,
          ),
        });
      }
      return { previous };
    },
    onError: (_err, _override, context) => {
      // Revert the optimistic flip and surface the failure (AS-009 error path).
      if (context?.previous) {
        queryClient.setQueryData<NotificationPreferences>(PREFS_KEY, context.previous);
      }
      toast.error("Couldn't save that preference. Try again.");
    },
    onSuccess: (data) => {
      // Replace the cache with the server's recomputed effective set (authoritative).
      queryClient.setQueryData<NotificationPreferences>(PREFS_KEY, data);
    },
  });
}
