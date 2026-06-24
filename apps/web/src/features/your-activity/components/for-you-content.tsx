import { useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { Skeleton } from "@/components/skeleton";
import { useForYouInbox } from "@/features/your-activity/hooks/use-for-you-inbox";
import { InboxList } from "@/features/your-activity/components/inbox-list";
import { InboxToolbar } from "@/features/your-activity/components/inbox-toolbar";
import {
  useUnreadCount,
  useMarkRead,
  useMarkAllRead,
} from "@/features/notifications/hooks/use-notifications";
import type { NotificationItem } from "@/features/notifications/types";

// your-activity-inbox S-001 — the For-you inbox as a STANDALONE, composable component (## Linked
// Fields producer obligation): the sibling `your-activity-actions` (2b) mounts this as its first
// tab when it introduces the two-tab bar. It owns ONLY the For-you read + states; the page wrapper
// (your-activity-page.tsx) owns the account-scoped page chrome. No tab bar here (M7 — the dead
// "Your actions" tab is NOT rendered; 2b owns the tab container, built exactly once).
//
// S-002 — unread management is layered on here: an unread count pill + "Mark all read" + an
// "Unread only" filter (the `InboxToolbar`), and a per-row "mark read" control wired down through
// the list. The mark mutations are the EXISTING notification hooks (useMarkRead/useMarkAllRead),
// which already invalidate the list + unread-count query keys on success (C-002: read-own-only +
// existence-hiding inherited from those endpoints — a foreign mark is a server-side no-op that the
// FE treats identically, AS-010). The count comes from useUnreadCount (the same polled slice the
// bell uses), NOT recomputed client-side, so it stays consistent with the badge.
//
// States (AS-005): a delayed skeleton while the first page loads; a retryable ErrorState on failure
// (never a blank page); an EmptyState ("You're all caught up") when there is nothing. The empty copy
// names the cross-workspace nature WITHOUT promising "mentions" (C-005 — mentions are spec 3).

export function ForYouContent({
  onOpen,
}: {
  /** Open an item's detail (the detail view lands in S-003). */
  onOpen?: (item: NotificationItem) => void;
}) {
  const inbox = useForYouInbox();
  const unreadCountQuery = useUnreadCount();
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();
  const [unreadOnly, setUnreadOnly] = useState(false);

  if (inbox.isLoading) {
    return <Skeleton rows={5} />;
  }

  if (inbox.isError) {
    return <ErrorState message={inbox.error?.message} onRetry={inbox.refetch} />;
  }

  if (inbox.items.length === 0) {
    return (
      <EmptyState
        title="You're all caught up"
        description="Replies and feedback across your workspaces show up here."
      />
    );
  }

  // The unread count is the polled server count (consistent with the bell badge), not a recount of
  // the loaded pages. The "Unread only" filter, by contrast, narrows the LOADED rows client-side.
  const unreadCount = unreadCountQuery.data?.count ?? 0;
  const visible = unreadOnly ? inbox.items.filter((it) => !it.read) : inbox.items;

  return (
    <div data-testid="for-you-content">
      <InboxToolbar
        unreadCount={unreadCount}
        unreadOnly={unreadOnly}
        onToggleUnreadOnly={() => setUnreadOnly((v) => !v)}
        onMarkAll={() => markAllRead.mutate()}
        markAllDisabled={unreadCount === 0}
        markAllPending={markAllRead.isPending}
      />

      {visible.length === 0 ? (
        // AS-009: the filter is on but nothing is unread among the loaded rows.
        <EmptyState
          title="No unread items"
          description="You've read everything here. Turn off “Unread only” to see the rest."
        />
      ) : (
        <InboxList
          items={visible}
          hasMore={!unreadOnly && inbox.hasMore}
          isFetchingMore={inbox.isFetchingMore}
          onLoadMore={inbox.loadMore}
          onOpen={onOpen}
          onMarkRead={(item) => markRead.mutate(item.id)}
        />
      )}
    </div>
  );
}
