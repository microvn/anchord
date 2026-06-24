import { useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { Skeleton } from "@/components/skeleton";
import { ActivityFeed } from "@/features/activity/components/activity-feed";
import { ActivityDetailPage } from "@/features/activity/components/activity-detail-page";
import { useMyActivity } from "@/features/your-activity/hooks/use-my-activity";
import type { MyActivityRow } from "@/features/your-activity/types";
import type { ActivityEventRow } from "@/features/activity/types";

// your-activity-actions S-001 — the "Your actions" feed as a STANDALONE, composable component (S-002
// will mount it as the second tab of the two-tab "Your activity" page; this story does NOT build the
// tab shell). It is a THIN CONSUMER (C4 / C-007): it fetches `/api/me/activity` and renders the rows
// through workspace-activity's EXISTING feed/row/chips/detail components — no feed rebuild.
//
// AS-001/002/003: the rows are served recent-first + carry `workspaceName` (AS-002 label) + the
// publish meta; <ActivityFeed> day-groups them client-side in the viewer's timezone (AS-003) and
// renders each via the reused <ActivityRow>. AS-004: "Load more" pages older actions. AS-005: opening
// a row shows the REUSED <ActivityDetailPage> in place (no new detail). AS-007: an empty feed shows
// the personal empty copy. AS-008: a failed fetch shows a retryable error (never a blank tab).

export function YourActionsContent({
  onOpen,
}: {
  /**
   * S-002 host hook: when provided, the parent owns "open" (e.g. routes to a detail page) and NO
   * in-place detail renders here. When omitted (this story), the component manages its own selection
   * and shows the reused detail IN PLACE with a Back control (mirrors ForYouContent's `sel` pattern).
   */
  onOpen?: (row: MyActivityRow) => void;
}) {
  const feed = useMyActivity();
  const [sel, setSel] = useState<MyActivityRow | null>(null);

  // AS-008: a failed load → a retryable error state, never a blank tab.
  if (feed.isError) {
    return (
      <div data-testid="your-actions" className="rounded-[11px] border border-line bg-surface">
        <ErrorState message={feed.error?.message ?? null} onRetry={feed.refetch} />
      </div>
    );
  }

  // Loading: the shape-matching skeleton (not a spinner).
  if (feed.isLoading) {
    return (
      <div data-testid="your-actions" className="rounded-[11px] border border-line bg-surface px-2 py-2">
        <Skeleton rows={6} />
      </div>
    );
  }

  // AS-007: a user who has done nothing yet — the personal empty copy (NOT the workspace feed's).
  if (feed.rows.length === 0) {
    return (
      <div data-testid="your-actions" className="rounded-[11px] border border-line bg-surface">
        <EmptyState
          title="No activity yet"
          description="Things you publish, comment on and share will appear here."
        />
      </div>
    );
  }

  // AS-005: opening a row shows the REUSED detail component in place (no 2b rebuild). The personal
  // feed has no per-event detail-url route in this story, so we render the row we already have +
  // its related list empty (related-by-doc is a workspace-scoped surface, not used here).
  if (!onOpen && sel) {
    return (
      <div data-testid="your-actions">
        <ActivityDetailPage event={sel} related={[]} backHref="#" />
        <button
          type="button"
          data-testid="your-actions-back"
          onClick={() => setSel(null)}
          className="mx-auto mt-2 block text-[12.5px] text-subtle hover:text-ink"
        >
          Back to your actions
        </button>
      </div>
    );
  }

  const handleOpen = (event: ActivityEventRow) => {
    const row = event as MyActivityRow;
    if (onOpen) onOpen(row);
    else setSel(row);
  };

  return (
    <div data-testid="your-actions">
      {feed.rows.length > 0 && <ActivityFeed rows={feed.rows} onOpen={handleOpen} />}
      {feed.hasMore && (
        <div className="mt-6 flex justify-center">
          <button
            type="button"
            data-testid="your-actions-load-more"
            onClick={feed.loadMore}
            disabled={feed.isFetchingMore}
            className="rounded-[8px] border border-line bg-surface px-4 py-1.5 text-[12.5px] font-medium text-ink hover:border-subtle disabled:opacity-60"
          >
            {feed.isFetchingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
