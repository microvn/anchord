import { Icon } from "@/components/icon";

// your-activity-inbox S-002 — the For-you inbox toolbar (Anchord-Design `.me-bar`): an "Unread only"
// toggle on the left and a "Mark all read" action on the right. The unread COUNT pill sits with the
// "Unread only" toggle (this 2a page is single-surface — there is no tab bar, so the pill that the
// prototype puts on the `.me-tab` lives here on the For-you label/toolbar instead; tab-pill checklist).
//
// Mark-all is disabled when nothing is unread (AS-008) — an idempotent no-op surface, matching the
// bell. All state lives above (ForYouContent); this is a pure presentational control.

export function InboxToolbar({
  unreadCount,
  unreadOnly,
  onToggleUnreadOnly,
  onMarkAll,
  markAllDisabled,
  markAllPending,
}: {
  unreadCount: number;
  unreadOnly: boolean;
  onToggleUnreadOnly: () => void;
  onMarkAll: () => void;
  markAllDisabled: boolean;
  markAllPending?: boolean;
}) {
  const hasUnread = unreadCount > 0;
  return (
    <div className="mb-3.5 flex flex-wrap items-center gap-2.5" data-testid="inbox-toolbar">
      {/* "Unread only" toggle (Anchord-Design `.unread-toggle`) — a faux checkbox + label, plus the
          unread count pill so the count is visible without a tab bar (tab-pill). */}
      <button
        type="button"
        data-testid="inbox-unread-toggle"
        aria-pressed={unreadOnly}
        onClick={onToggleUnreadOnly}
        className={
          "inline-flex h-[30px] items-center gap-[7px] rounded-md border px-[11px] text-[13px] font-medium transition-colors " +
          (unreadOnly
            ? "border-transparent bg-accent-soft text-accent-ink"
            : "border-line bg-surface text-muted hover:border-subtle hover:text-ink")
        }
      >
        <span
          aria-hidden="true"
          className={
            "grid size-4 place-items-center rounded-[5px] border-[1.5px] " +
            (unreadOnly
              ? "border-accent bg-accent text-on-accent"
              : "border-faint text-transparent")
          }
        >
          <Icon name="check" size={11} />
        </span>
        Unread only
        <span
          data-testid="inbox-unread-pill"
          className={
            "inline-grid h-[17px] min-w-[17px] place-items-center rounded-full px-[5px] font-mono text-[10px] " +
            (hasUnread ? "bg-accent text-on-accent" : "bg-elev text-subtle")
          }
        >
          {unreadCount > 99 ? "99+" : unreadCount}
        </span>
      </button>

      {/* Mark all read (Anchord-Design `.me-mark-all`) — pinned right; disabled when nothing unread. */}
      <button
        type="button"
        data-testid="inbox-mark-all"
        onClick={onMarkAll}
        disabled={markAllDisabled || markAllPending}
        className="ml-auto cursor-pointer border-none bg-none text-xs font-semibold text-accent-ink hover:underline disabled:cursor-default disabled:text-faint disabled:no-underline"
      >
        {markAllPending ? "Marking…" : "Mark all read"}
      </button>
    </div>
  );
}
