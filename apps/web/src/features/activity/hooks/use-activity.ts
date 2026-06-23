import { useQuery } from "@tanstack/react-query";
import { toApiError, type ApiError } from "@/lib/api/api-error";
import { unwrapEnvelope } from "@/features/workspaces/hooks/use-bootstrap";
import { fetchActivity } from "@/features/activity/services/client";
import type { ActivityEventRow } from "@/features/activity/types";

// The workspace activity feed read (workspace-activity S-001). Keyed by workspaceId + page so each
// page is its own cache entry and switching workspace never shows stale data (GAP-001 pattern).
//
// C-007: the feed is recent-first, paginated server-side (default 20 / cap 50). The screen pages
// 1:1 (one server page = one feed page); day-grouping is rendered CLIENT-SIDE over the flat list in
// the VIEWER's timezone (a day may straddle a page boundary — the grouping merges same-day headers).

/** The pagination envelope the backend adds alongside `items`. */
export interface ActivityPaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

export interface ActivityPage {
  items: ActivityEventRow[];
  pagination?: ActivityPaginationMeta;
}

interface ActivityResult {
  items: ActivityEventRow[];
  pagination?: ActivityPaginationMeta;
}

/** Feed page size — 20 (C-007). One server page = one feed page (server-side paging). */
export const ACTIVITY_PAGE_SIZE = 20;

/** The query key for ONE workspace's activity feed at ONE page. */
function activityKey(workspaceId: string, page: number) {
  return ["w", workspaceId, "activity", "page", page] as const;
}

/**
 * GET …/activity?page= — one page of the workspace feed. The screen lifts `page` state and feeds it
 * here; each page is a distinct cache entry. Errors normalize to ApiError so the screen renders the
 * shared ErrorState with a Retry that re-runs this query (AS-005).
 */
export function useActivity(workspaceId: string, page = 1) {
  return useQuery<ActivityPage, ApiError>({
    queryKey: activityKey(workspaceId, page),
    retry: (failureCount, error) => !error?.isUnauthenticated && failureCount < 1,
    queryFn: async (): Promise<ActivityPage> => {
      const res = unwrapEnvelope<ActivityResult>(
        await fetchActivity(workspaceId, page, ACTIVITY_PAGE_SIZE),
      );
      if (res.error) throw toApiError(res.error);
      return { items: res.data?.items ?? [], pagination: res.data?.pagination };
    },
  });
}
