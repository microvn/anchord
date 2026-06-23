import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { Skeleton } from "@/components/skeleton";
import { ActivityRow } from "@/features/activity/components/activity-row";
import { groupByDay } from "@/features/activity/lib/group-by-day";
import type { ActivityEventRow } from "@/features/activity/types";

// The day-grouped feed list (workspace-activity S-001 — the `ActivityFeed` presentational piece).
//
// ROWS-AS-PROPS (export contract / ## Linked Fields): takes rows + loading/error/retry, NOT bound
// to the workspace fetch — a wrapper does the fetch and passes rows down, so the personal "Your
// actions" feed (2b) reuses this same component with a different fetch.
//
// AS-002: groups the flat recent-first list into day buckets CLIENT-SIDE in the viewer's timezone
// (Today / Yesterday / dated), most-recent day first, newest-first within each day, each header
// showing the day's event count (C-007). AS-004 empty / AS-005 error states reuse the shared
// primitives.

export function ActivityFeed({
  rows,
  loading = false,
  error = null,
  onRetry,
  onOpen,
}: {
  rows: ActivityEventRow[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onOpen?: (event: ActivityEventRow) => void;
}) {
  // AS-005: a failed load renders the retryable ErrorState, never a blank page.
  if (error) {
    return (
      <div className="rounded-[11px] border border-line bg-surface">
        <ErrorState message={error} onRetry={onRetry} />
      </div>
    );
  }

  // Loading: the shape-matching skeleton (not a spinner).
  if (loading) {
    return (
      <div className="rounded-[11px] border border-line bg-surface px-2 py-2">
        <Skeleton rows={6} />
      </div>
    );
  }

  // AS-004: a fresh workspace with no recorded events shows the empty state.
  if (rows.length === 0) {
    return (
      <div className="rounded-[11px] border border-line bg-surface">
        <EmptyState
          title="No activity yet"
          description="Comments, publishes and version changes across the workspace will appear here."
        />
      </div>
    );
  }

  const groups = groupByDay(rows);
  return (
    <div data-testid="activity-feed" className="flex flex-col gap-6">
      {groups.map((group) => (
        <div key={group.key} className="flex flex-col gap-2">
          <div className="flex items-center gap-3" data-testid="activity-day-group">
            <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-subtle" data-testid="activity-day-label">
              {group.label}
            </span>
            <span className="h-px flex-1 bg-line" />
            <span className="font-mono text-[11px] text-subtle tabular-nums">
              {group.rows.length} {group.rows.length === 1 ? "event" : "events"}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {group.rows.map((event) => (
              <ActivityRow key={event.id} event={event} onOpen={onOpen} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
