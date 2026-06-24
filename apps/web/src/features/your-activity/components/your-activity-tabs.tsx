// your-activity-actions S-002 — the two-tab bar for the "Your activity" page (M7: the tab container
// is built EXACTLY ONCE here; this story owns the shell). Mirrors the prototype's `.me-tabs` /
// `.me-tab.active` (teal underline) + `.me-tab .pill` unread count, but uses THIS spec's `?tab`
// param semantics (set by the parent). The For-you tab carries an unread pill; the Your-actions tab
// carries NONE (C-004 — no unread/mark/count concept on Your actions).

export type YourActivityTab = "for-you" | "actions";

export function YourActivityTabs({
  value,
  onChange,
  unreadCount,
}: {
  value: YourActivityTab;
  onChange: (tab: YourActivityTab) => void;
  /** For-you unread count for the pill (from useUnreadCount). Your actions never shows a pill (C-004). */
  unreadCount: number;
}) {
  return (
    <div
      role="tablist"
      aria-label="Your activity"
      className="mb-[18px] flex items-center gap-1 border-b border-line"
    >
      <button
        type="button"
        role="tab"
        id="tab-for-you"
        aria-selected={value === "for-you"}
        aria-controls="panel-for-you"
        data-testid="me-tab-for-you"
        data-active={value === "for-you" ? "1" : "0"}
        onClick={() => onChange("for-you")}
        className={
          "-mb-px mr-[18px] inline-flex items-center gap-2 border-b-2 px-1 py-2.5 text-sm transition-colors " +
          (value === "for-you"
            ? "border-accent font-semibold text-ink"
            : "border-transparent font-medium text-muted hover:text-ink")
        }
      >
        For you
        <span
          data-testid="me-tab-for-you-pill"
          className={
            "inline-grid h-[17px] min-w-[17px] place-items-center rounded-full px-[5px] font-mono text-[10px] " +
            (unreadCount > 0
              ? "bg-accent text-on-accent"
              : "bg-elev text-subtle")
          }
        >
          {unreadCount}
        </span>
      </button>

      <button
        type="button"
        role="tab"
        id="tab-actions"
        aria-selected={value === "actions"}
        aria-controls="panel-actions"
        data-testid="me-tab-actions"
        data-active={value === "actions" ? "1" : "0"}
        onClick={() => onChange("actions")}
        className={
          "-mb-px mr-[18px] inline-flex items-center gap-2 border-b-2 px-1 py-2.5 text-sm transition-colors " +
          (value === "actions"
            ? "border-accent font-semibold text-ink"
            : "border-transparent font-medium text-muted hover:text-ink")
        }
      >
        Your actions
      </button>
    </div>
  );
}
