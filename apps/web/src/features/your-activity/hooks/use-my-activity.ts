import { useCallback, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { peelEnvelope } from "@/lib/api/use-api-query";
import { toApiError, type ApiError } from "@/lib/api/api-error";
import { listMyActivity } from "@/features/your-activity/services/client";
import type { MyActivityPage, MyActivityRow } from "@/features/your-activity/types";

// your-activity-actions S-001 — the personal "Your actions" paged read. Mirrors the For-you inbox
// hook (use-for-you-inbox): a "load more" surface that ACCUMULATES pages, each page its own query so
// a later page failing never drops the rows already shown. React Query owns the server state; this
// hook owns only the page count. C-003: the read is recent-first + paginated server-side (cap 50);
// day grouping is rendered CLIENT-SIDE by the reused ActivityFeed (in the viewer's timezone).
// C-001: the actor is the session caller (server-derived) — the client never sends an actorUserId.

const LIST_KEY = ["me", "activity", "list"] as const;

export interface MyActivity {
  /** The accumulated rows across every loaded page, newest-first. */
  rows: MyActivityRow[];
  /** True until the first page resolves. */
  isLoading: boolean;
  /** True if any loaded page failed. */
  isError: boolean;
  /** The first error, if any (drives the ErrorState message). */
  error: ApiError | null;
  /** True while a subsequent page is in flight (the "Load more" busy state). */
  isFetchingMore: boolean;
  /** True when the server reports another page beyond the last loaded one (AS-004). */
  hasMore: boolean;
  /** Load the next page (no-op when there is no more). */
  loadMore: () => void;
  /** Re-run every loaded page (the ErrorState Retry — AS-008). */
  refetch: () => void;
}

/**
 * The "Your actions" read. `enabled` gates the fetch (the tab may be unmounted until selected).
 * Pages accumulate: `loadMore` bumps the page count, and each page is its own query.
 */
export function useMyActivity(enabled = true): MyActivity {
  const [pageCount, setPageCount] = useState(1);

  const results = useQueries({
    queries: Array.from({ length: pageCount }, (_, i) => {
      const page = i + 1;
      return {
        queryKey: [...LIST_KEY, page] as const,
        enabled,
        queryFn: async (): Promise<MyActivityPage> => {
          let res;
          try {
            res = await listMyActivity(page);
          } catch (thrown) {
            throw toApiError(thrown);
          }
          if (res.error) throw toApiError(res.error);
          return peelEnvelope(res.data) as MyActivityPage;
        },
      };
    }),
  });

  const rows = results.flatMap((r) => r.data?.items ?? []);
  const isLoading = results[0]?.isLoading ?? true;
  const errored = results.find((r) => r.isError);
  const last = results[results.length - 1];
  const hasMore = !!last?.data?.pagination?.hasNext;
  const isFetchingMore = results.slice(1).some((r) => r.isLoading || r.isFetching);

  const loadMore = useCallback(() => {
    if (hasMore) setPageCount((n) => n + 1);
  }, [hasMore]);

  const refetch = useCallback(() => {
    for (const r of results) void r.refetch();
  }, [results]);

  return {
    rows,
    isLoading,
    isError: !!errored,
    error: (errored?.error as ApiError) ?? null,
    isFetchingMore,
    hasMore,
    loadMore,
    refetch,
  };
}
