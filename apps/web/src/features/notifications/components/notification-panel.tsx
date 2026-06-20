import { useNavigate } from "react-router-dom";
import { Icon } from "@/components/icon";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  useNotifications,
  useMarkRead,
  useMarkAllRead,
} from "@/features/notifications/hooks/use-notifications";
import { relativeTime, summaryFor, deepLinkFor } from "@/features/notifications/lib/format";
import type { NotificationItem } from "@/features/notifications/types";

// The bell dropdown panel (notifications-email S-006): header + "mark all read", the recent-N list,
// and an empty state. Opening the panel triggers the list read but NEVER marks anything read (C-009);
// clicking a row marks JUST that row and deep-links to its thread (AS-014). Teal accent + chrome-
// recedes per DESIGN.md; the unread dot is the only colored mark in a row.

function NotificationRow({
  item,
  onActivate,
}: {
  item: NotificationItem;
  onActivate: (item: NotificationItem) => void;
}) {
  return (
    <button
      type="button"
      data-testid={`notification-row-${item.id}`}
      data-unread={item.read ? undefined : "true"}
      onClick={() => onActivate(item)}
      className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left outline-none transition-colors hover:bg-elev focus:bg-elev"
    >
      {/* Unread dot — teal, the row's only accent; an invisible spacer keeps read rows aligned. */}
      <span
        data-testid={item.read ? undefined : `notification-unread-dot-${item.id}`}
        aria-hidden="true"
        className={`mt-[5px] size-[7px] flex-none rounded-full ${item.read ? "bg-transparent" : "bg-accent"}`}
      />
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[12.5px] ${item.read ? "text-muted" : "text-ink"}`}>
          {summaryFor(item.type)}
        </span>
        <span className="mt-0.5 block text-[11px] text-subtle">{relativeTime(item.createdAt)}</span>
      </span>
    </button>
  );
}

export function NotificationPanel({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  // The panel is OPEN whenever it renders, so the list query is enabled here (the read happens on
  // open — C-009 — but does not mark anything read).
  const query = useNotifications(true);
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();

  const items = query.data?.items ?? [];
  const hasUnread = items.some((i) => !i.read);

  // AS-014: clicking a row marks JUST that row read, then deep-links to its thread (when resolvable).
  function activate(item: NotificationItem) {
    markRead.mutate(item.id);
    const href = deepLinkFor(item);
    onClose();
    if (href) navigate(href);
  }

  return (
    <div data-testid="notification-panel" className="w-[320px] max-w-[90vw]">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="text-[12.5px] font-semibold text-ink">Notifications</span>
        <button
          type="button"
          data-testid="notifications-mark-all"
          disabled={!hasUnread || markAll.isPending}
          onClick={() => markAll.mutate()}
          className="rounded px-1.5 py-0.5 text-[11.5px] text-accent transition-colors hover:bg-elev disabled:cursor-default disabled:text-subtle disabled:hover:bg-transparent"
        >
          Mark all read
        </button>
      </div>

      {query.isPending ? (
        <div data-testid="notifications-loading" className="px-3 py-6 text-center text-[12px] text-subtle">
          Loading…
        </div>
      ) : items.length === 0 ? (
        // AS-016: empty state — no rows, no badge (the badge is driven by the unread-count query).
        <div
          data-testid="notifications-empty"
          className="flex flex-col items-center gap-2 px-3 py-8 text-center"
        >
          <Icon name="inbox" size={22} />
          <span className="text-[12.5px] text-muted">You're all caught up</span>
        </div>
      ) : (
        <ScrollArea className="max-h-[360px]">
          <ul className="p-1">
            {items.map((item) => (
              <li key={item.id}>
                <NotificationRow item={item} onActivate={activate} />
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
    </div>
  );
}
