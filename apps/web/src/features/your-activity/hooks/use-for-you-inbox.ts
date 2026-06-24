import { useCallback, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { peelEnvelope } from "@/lib/api/use-api-query";
import { toApiError, type ApiError } from "@/lib/api/api-error";
import { listNotifications } from "@/features/notifications/services/client";
import type { NotificationItem, NotificationPage } from "@/features/notifications/types";

// your-activity-inbox S-001 — the For-you page's paged read. The bell's `useNotifications` fetches
// page 1 only (C-006: the bell is the recent-N surface); the full-page inbox is a "load more"
// surface that accumulates pages, so it gets its OWN hook here — reusing the SAME `listNotifications`
// client thunk, keyed under the `["me","notifications","list"]` tree (a sibling of the bell's
// `["me","notifications","list"]` single-page key, distinguished by a `,page` suffix so the two
// consumers never collide). React Query owns the server state; this hook owns only the page count.
//
// C-006: day grouping is rendered client-side over this flat accumulated list (in the for-you-content
// component); the read caps at 50/page server-side, so a deep inbox pages in. C-009: the read is the
// caller's notifications across workspaces with NO membership filter — a left workspace's items still
// appear (matching the bell). C-002: read-own scoping is inherited from the endpoint (no extra work).

const LIST_KEY = ["me", "notifications", "list"] as const;

export interface ForYouInbox {
  /** The accumulated items across every loaded page, newest-first. */
  items: NotificationItem[];
  /** True until the first page resolves. */
  isLoading: boolean;
  /** True if any loaded page failed. */
  isError: boolean;
  /** The first error, if any (drives the ErrorState message). */
  error: ApiError | null;
  /** True while a subsequent page is in flight (the "Load more" busy state). */
  isFetchingMore: boolean;
  /** True when the server reports another page beyond the last loaded one. */
  hasMore: boolean;
  /** Load the next page (no-op when there is no more). */
  loadMore: () => void;
  /** Re-run every loaded page (the ErrorState Retry). */
  refetch: () => void;
}

/**
 * The For-you inbox read. `enabled` gates the fetch (the page is always mounted, so it defaults on).
 * Pages accumulate: `loadMore` bumps the page count, and each page is its own query so a later page
 * failing doesn't drop the pages already shown.
 */
export function useForYouInbox(enabled = true): ForYouInbox {
  const [pageCount, setPageCount] = useState(1);

  const results = useQueries({
    queries: Array.from({ length: pageCount }, (_, i) => {
      const page = i + 1;
      return {
        queryKey: [...LIST_KEY, page] as const,
        enabled,
        queryFn: async (): Promise<NotificationPage> => {
          let res;
          try {
            res = await listNotifications(page);
          } catch (thrown) {
            throw toApiError(thrown);
          }
          if (res.error) throw toApiError(res.error);
          return peelEnvelope(res.data) as NotificationPage;
        },
      };
    }),
  });

  const items = results.flatMap((r) => r.data?.items ?? []);
  const isLoading = results[0]?.isLoading ?? true;
  const errored = results.find((r) => r.isError);
  const last = results[results.length - 1];
  // The newest page's pagination tells us whether another page exists.
  const hasMore = !!last?.data?.pagination?.hasNext;
  // A subsequent page that's still loading (not the first) is the "load more" busy state.
  const isFetchingMore = results.slice(1).some((r) => r.isLoading || r.isFetching);

  const loadMore = useCallback(() => {
    if (hasMore) setPageCount((n) => n + 1);
  }, [hasMore]);

  const refetch = useCallback(() => {
    for (const r of results) void r.refetch();
  }, [results]);

  return {
    items,
    isLoading,
    isError: !!errored,
    error: (errored?.error as ApiError) ?? null,
    isFetchingMore,
    hasMore,
    loadMore,
    refetch,
  };
}
