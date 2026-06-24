import { useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { Skeleton } from "@/components/skeleton";
import { groupRowsByDay } from "@/features/your-activity/lib/group-by-day";
import { ActionsRow } from "@/features/your-activity/components/actions-row";
import { ActionsDetail } from "@/features/your-activity/components/actions-detail";
import { useMyActivity } from "@/features/your-activity/hooks/use-my-activity";
import type { MyActivityRow } from "@/features/your-activity/types";

// your-activity-actions S-001 — the "Your actions" feed, in the PERSONAL component family (C-007,
// reversed): it must match the Anchord-Design prototype's personal Your-actions screen, NOT the
// workspace timeline. So it renders its OWN day-grouped list of `.me-list` cards + `<ActionsRow>` +
// `<ActionsDetail>` (mirrors the For-you `inbox-*` family), never the workspace `<ActivityFeed>` /
// `<ActivityDetailPage>`.
//
// AS-001/002/003: rows arrive recent-first carrying `workspaceName` (the per-row workspace label) +
// the publish/comment meta; we day-group them client-side in the viewer's timezone, newest-day-first.
// AS-004: "Load more" pages older actions into the same list. AS-005: opening a row shows the
// personal `<ActionsDetail>` in place (with "Open in doc" when a slug survives). AS-006: a
// lost-access row still lists with the backend's genericized fields (no leaked content, no deep-link).
// AS-007: an empty feed shows the personal empty copy. AS-008: a failed fetch shows a retryable error.

export function YourActionsContent({
  onOpen,
}: {
  /**
   * S-002 host hook: when provided, the parent owns "open" and NO in-place detail renders here. When
   * omitted (this story), the component manages its own selection and shows `<ActionsDetail>` in place
   * with a Back control (mirrors ForYouContent's `sel` pattern).
   */
  onOpen?: (row: MyActivityRow) => void;
}) {
  const feed = useMyActivity();
  const [sel, setSel] = useState<MyActivityRow | null>(null);

  // AS-008: a failed load → a retryable error state, never a blank tab.
  if (feed.isError) {
    return (
      <div data-testid="your-actions">
        <ErrorState message={feed.error?.message ?? null} onRetry={feed.refetch} />
      </div>
    );
  }

  // Loading: the shape-matching skeleton (not a spinner).
  if (feed.isLoading) {
    return (
      <div data-testid="your-actions" className="rounded-[12px] border border-line bg-surface px-2 py-2">
        <Skeleton rows={6} />
      </div>
    );
  }

  // AS-007: a user who has done nothing yet — the personal empty copy (NOT the workspace feed's).
  if (feed.rows.length === 0) {
    return (
      <div data-testid="your-actions" className="rounded-[12px] border border-line bg-surface">
        <EmptyState
          title="No activity yet"
          description="Things you publish, comment on and share will appear here."
        />
      </div>
    );
  }

  // AS-005: opening a row shows the personal detail in place — unless the host owns navigation.
  if (!onOpen && sel) {
    return (
      <div data-testid="your-actions">
        <ActionsDetail row={sel} onBack={() => setSel(null)} />
      </div>
    );
  }

  const open = (row: MyActivityRow) => {
    if (onOpen) onOpen(row);
    else setSel(row);
  };

  const groups = groupRowsByDay(feed.rows);

  return (
    <div data-testid="your-actions">
      {groups.map((group) => (
        <div key={group.key}>
          {/* Day label (Anchord-Design `.me-day-label`): a mono uppercase label + a filler hairline,
              NO "N events" count (C-007 — the personal list never counts). */}
          <div className="flex items-center gap-2.5 px-0.5 pb-2 pt-3.5">
            <span
              data-testid="actions-day-label"
              className="font-mono text-[11px] uppercase tracking-[0.1em] text-subtle"
            >
              {group.label}
            </span>
            <span className="h-px flex-1 bg-line" />
          </div>

          {/* The day's bordered rounded `.me-list` card; rows separated by hairlines. */}
          <div
            data-testid="actions-list"
            className="overflow-hidden rounded-[12px] border border-line bg-surface"
          >
            {group.items.map((row) => (
              <ActionsRow key={row.id} row={row} onOpen={open} />
            ))}
          </div>
        </div>
      ))}

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
