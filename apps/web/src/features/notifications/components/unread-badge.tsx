// The unread count pill on the bell (notifications-email S-006). Teal accent per DESIGN.md
// (the single accent — never purple/orange), hidden entirely when the count is 0 (AS-016).
// GAP-003: the display caps at "9+" so a large backlog never overflows the chrome.

export function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null; // AS-016: no badge when nothing is unread.
  const label = count > 9 ? "9+" : String(count); // GAP-003 cap.
  return (
    <span
      data-testid="notifications-badge"
      aria-label={`${count} unread`}
      className="pointer-events-none absolute -right-0.5 -top-0.5 inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-accent px-[3px] text-[9px] font-semibold leading-none text-on-accent"
    >
      {label}
    </span>
  );
}
