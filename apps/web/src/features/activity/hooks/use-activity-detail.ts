import { useQuery } from "@tanstack/react-query";
import { ApiError, toApiError } from "@/lib/api/api-error";
import { unwrapEnvelope } from "@/features/workspaces/hooks/use-bootstrap";
import { fetchActivityEvent, fetchActivityRelated } from "@/features/activity/services/client";
import type { ActivityEventDetail, ActivityEventRow } from "@/features/activity/types";

// The activity event DETAIL reads (workspace-activity S-004). Two reads, two cache entries:
//   - the single event (enriched with the current docSlug/projectName for "Open doc"), AS-014/AS-018
//   - "More on this doc" related events on the same doc, access-filtered (C-003)
//
// A hidden/nonexistent event 404s (existence-hiding, AS-010) → the screen renders a not-found state.

/** GET …/activity/:eventId — one event's detail. 404 → ApiError (not-found state). */
export function useActivityEvent(workspaceId: string, eventId: string) {
  return useQuery<ActivityEventDetail, ApiError>({
    queryKey: ["w", workspaceId, "activity", "event", eventId] as const,
    // A 404 (hidden / nonexistent — existence-hiding) won't become found on retry; surface it at
    // once. Other transient errors get one retry (unless unauthenticated, which bounces to sign-in).
    retry: (failureCount, error) =>
      !error?.isUnauthenticated && error?.status !== 404 && error?.code !== "NOT_FOUND" && failureCount < 1,
    queryFn: async (): Promise<ActivityEventDetail> => {
      const res = unwrapEnvelope<{ event: ActivityEventDetail }>(
        await fetchActivityEvent(workspaceId, eventId),
      );
      if (res.error) throw toApiError(res.error);
      if (!res.data?.event)
        throw new ApiError({ message: "Event not found", code: "NOT_FOUND", status: 404, isUnauthenticated: false });
      return res.data.event;
    },
  });
}

/**
 * GET …/activity/:eventId/related — "More on this doc". `enabled` so the screen only fetches related
 * once the event itself loaded (avoids a redundant 404 race while the event is still resolving).
 */
export function useActivityRelated(workspaceId: string, eventId: string, enabled: boolean) {
  return useQuery<ActivityEventRow[], ApiError>({
    queryKey: ["w", workspaceId, "activity", "related", eventId] as const,
    enabled,
    retry: (failureCount, error) => !error?.isUnauthenticated && failureCount < 1,
    queryFn: async (): Promise<ActivityEventRow[]> => {
      const res = unwrapEnvelope<{ items: ActivityEventRow[] }>(
        await fetchActivityRelated(workspaceId, eventId),
      );
      if (res.error) throw toApiError(res.error);
      return res.data?.items ?? [];
    },
  });
}
