import { useQuery } from "@tanstack/react-query";
import { toApiError, type ApiError } from "@/lib/api/api-error";
import { unwrapEnvelope } from "@/features/workspaces/hooks/use-bootstrap";
import { fetchActivityStats } from "@/features/activity/services/client";
import type { ActivityStats } from "@/features/activity/types";

// The stats-rail read (workspace-activity S-007). Keyed by workspaceId so each workspace has its own
// cache entry. The rail summarizes a trailing 7-day window (C-006) over the viewer's VISIBLE set
// (C-003) — the server computes both; the FE just renders the result.

/** The query key for ONE workspace's stats rail. */
function statsKey(workspaceId: string) {
  return ["w", workspaceId, "activity", "stats"] as const;
}

/**
 * GET …/activity/stats — the workspace activity stats rail. Returns the 7-day counts, the
 * most-active contributors (ranked highest-first), and the busiest doc — all scoped to what the
 * viewer can see (AS-028). Errors normalize to ApiError; the rail simply renders nothing on error
 * (it is a secondary summary, never the primary feed).
 */
export function useActivityStats(workspaceId: string) {
  return useQuery<ActivityStats, ApiError>({
    queryKey: statsKey(workspaceId),
    retry: (failureCount, error) => !error?.isUnauthenticated && failureCount < 1,
    queryFn: async (): Promise<ActivityStats> => {
      const res = unwrapEnvelope<ActivityStats>(await fetchActivityStats(workspaceId));
      if (res.error) throw toApiError(res.error);
      return {
        counts: res.data?.counts ?? { all: 0, comments: 0, versions: 0, sharing: 0, people: 0 },
        contributors: res.data?.contributors ?? [],
        busiestDoc: res.data?.busiestDoc ?? null,
      };
    },
  });
}
