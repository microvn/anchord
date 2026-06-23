import { useQuery } from "@tanstack/react-query";
import { toApiError, type ApiError } from "@/lib/api/api-error";
import { unwrapEnvelope } from "@/features/workspaces/hooks/use-bootstrap";
import { fetchActivity } from "@/features/activity/services/client";
import type { ActivityCategory, ActivityCategoryCounts, ActivityEventRow } from "@/features/activity/types";

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
  /** S-003: per-category counts over the viewer's visible set (each segment's own count). */
  counts?: ActivityCategoryCounts;
}

interface ActivityResult {
  items: ActivityEventRow[];
  pagination?: ActivityPaginationMeta;
  counts?: ActivityCategoryCounts;
}

/** Feed page size — 20 (C-007). One server page = one feed page (server-side paging). */
export const ACTIVITY_PAGE_SIZE = 20;

/** The query key for ONE workspace's activity feed at ONE page + category (S-003). */
function activityKey(workspaceId: string, page: number, category: ActivityCategory) {
  return ["w", workspaceId, "activity", "page", page, "category", category] as const;
}

/**
 * GET …/activity?page=&category= — one page of the workspace feed for one category. The screen lifts
 * `page` + `category` state and feeds them here; each page+category is a distinct cache entry. Errors
 * normalize to ApiError so the screen renders the shared ErrorState with a Retry (AS-005). The
 * response carries per-category `counts` (S-003) over the viewer's visible set.
 */
export function useActivity(workspaceId: string, page = 1, category: ActivityCategory = "all") {
  return useQuery<ActivityPage, ApiError>({
    queryKey: activityKey(workspaceId, page, category),
    retry: (failureCount, error) => !error?.isUnauthenticated && failureCount < 1,
    queryFn: async (): Promise<ActivityPage> => {
      const res = unwrapEnvelope<ActivityResult>(
        await fetchActivity(workspaceId, page, ACTIVITY_PAGE_SIZE, category),
      );
      if (res.error) throw toApiError(res.error);
      return { items: res.data?.items ?? [], pagination: res.data?.pagination, counts: res.data?.counts };
    },
  });
}
