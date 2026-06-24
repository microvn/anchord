import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { Skeleton } from "@/components/skeleton";
import { useForYouInbox } from "@/features/your-activity/hooks/use-for-you-inbox";
import { InboxList } from "@/features/your-activity/components/inbox-list";
import type { NotificationItem } from "@/features/notifications/types";

// your-activity-inbox S-001 — the For-you inbox as a STANDALONE, composable component (## Linked
// Fields producer obligation): the sibling `your-activity-actions` (2b) mounts this as its first
// tab when it introduces the two-tab bar. It owns ONLY the For-you read + states; the page wrapper
// (your-activity-page.tsx) owns the account-scoped page chrome. No tab bar here (M7 — the dead
// "Your actions" tab is NOT rendered; 2b owns the tab container, built exactly once).
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

  return (
    <InboxList
      items={inbox.items}
      hasMore={inbox.hasMore}
      isFetchingMore={inbox.isFetchingMore}
      onLoadMore={inbox.loadMore}
      onOpen={onOpen}
    />
  );
}
