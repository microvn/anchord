import { useNavigate } from "react-router-dom";
import { Icon } from "@/components/icon";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  useNotifications,
  useMarkRead,
  useMarkAllRead,
} from "@/features/notifications/hooks/use-notifications";
import { relativeTime, headlineParts, iconFor, deepLinkFor } from "@/features/notifications/lib/format";
import type { NotificationItem } from "@/features/notifications/types";

// The bell dropdown panel (notifications-email S-006): header + "mark all read", the recent-N list,
// and an empty state. Opening the panel triggers the list read but NEVER marks anything read (C-009);
// clicking a row marks JUST that row and deep-links to its thread (AS-014). Restyle per DESIGN.md:
// chrome recedes — each row leads with a per-type line-glyph (teal when unread, subtle when read),
// then a headline with weight on the actor (ink) + doc title (the one teal link); comment-type rows
// quote a snippet behind a teal left-rule. Teal is the ONLY accent — no colored dots, no discs.

function NotificationRow({
  item,
  onActivate,
}: {
  item: NotificationItem;
  onActivate: (item: NotificationItem) => void;
}) {
  const unread = !item.read;
  const head = headlineParts(item);
  return (
    <button
      type="button"
      data-testid={`notification-row-${item.id}`}
      data-unread={item.read ? undefined : "true"}
      onClick={() => onActivate(item)}
      className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left outline-none transition-colors hover:bg-elev focus:bg-elev"
    >
      {/* Leading type glyph — conveys KIND by shape; teal when unread, subtle when read (the unread
          signal, replacing the old dot). A line-glyph, never a colored disc (DESIGN.md). */}
      <span className={`mt-px flex-none ${unread ? "text-accent" : "text-subtle"}`}>
        <Icon name={iconFor(item.type)} size={13} />
      </span>
      <span className="min-w-0 flex-1">
        {/* AS-026/AS-027/AS-029: the headline as styled spans — actor (ink/medium), generic-or-
            connective verb (muted), and the doc title (the one teal link). Read rows recede to
            muted. The whole line truncates. */}
        <span className="block truncate text-[12.5px]">
          {head.actor ? (
            <span className={unread ? "font-medium text-ink" : "text-muted"}>{head.actor} </span>
          ) : null}
          <span className={unread ? "text-muted" : "text-subtle"}>{head.verb}</span>
          {head.title ? (
            <>
              <span className={unread ? "text-muted" : "text-subtle"}>{head.titleSeparator}</span>
              <span className={`font-medium ${unread ? "text-accent" : "text-muted"}`}>
                {head.title}
              </span>
            </>
          ) : null}
        </span>
        {/* AS-028: the comment excerpt — IN-APP ONLY, untrusted user text as inert React children
            (never dangerouslySetInnerHTML). Quoted behind a teal left-rule; comment-types only,
            omitted when absent (AS-029). */}
        {item.snippet ? (
          <span
            data-testid={`notification-snippet-${item.id}`}
            className="mt-0.5 block truncate border-l-2 border-accent-soft pl-2 text-[11.5px] text-muted"
          >
            {item.snippet}
          </span>
        ) : null}
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
