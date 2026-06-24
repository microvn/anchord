import { Button } from "@/components/ui/button";
import { groupByDay } from "@/features/your-activity/lib/group-by-day";
import { InboxRow } from "@/features/your-activity/components/inbox-row";
import type { NotificationItem } from "@/features/notifications/types";

// your-activity-inbox S-001 (AS-002 / C-006) — the day-grouped inbox list. Grouping is client-side
// over the flat accumulated list (newest day first, newest row first within a day), computed in the
// viewer's timezone. A "Load more" control pages in beyond page 1 when the server reports more.

export function InboxList({
  items,
  hasMore = false,
  isFetchingMore = false,
  onLoadMore,
  onOpen,
  onMarkRead,
}: {
  items: NotificationItem[];
  hasMore?: boolean;
  isFetchingMore?: boolean;
  onLoadMore?: () => void;
  onOpen?: (item: NotificationItem) => void;
  onMarkRead?: (item: NotificationItem) => void;
}) {
  const groups = groupByDay(items);

  return (
    <div data-testid="inbox-list">
      {groups.map((group) => (
        <div key={group.key}>
          {/* Day label (Anchord-Design `.me-day-label`): a mono label + a hairline. */}
          <div className="flex items-center gap-2.5 px-0.5 pb-2 pt-3.5">
            <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-subtle">
              {group.label}
            </span>
            <span className="h-px flex-1 bg-line" />
          </div>
          {/* The per-day card (Anchord-Design `.me-list`): bordered, rounded (--r-lg = 11px),
              overflow-hidden so the rows' bottom dividers clip into one card, on the surface bg. */}
          <div className="flex flex-col overflow-hidden rounded-[11px] border border-line bg-surface">
            {group.items.map((item) => (
              <InboxRow key={item.id} item={item} onOpen={onOpen} onMarkRead={onMarkRead} />
            ))}
          </div>
        </div>
      ))}

      {hasMore && (
        <div className="flex justify-center pt-4">
          <Button
            type="button"
            variant="secondary"
            data-testid="inbox-load-more"
            disabled={isFetchingMore}
            onClick={onLoadMore}
          >
            {isFetchingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
