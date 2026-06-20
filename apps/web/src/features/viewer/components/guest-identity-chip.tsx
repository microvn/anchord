// GuestIdentityChip (annotation-core S-007 / AS-016, C-007): the persistent identity chip in the top
// bar for a logged-out commenter. Shows a `?` avatar disc + the SESSION name + a Rename control that
// advances the session name everywhere it appears (the chip here + the name that rides each guest
// comment). It sits NEXT TO the Sign in CTA in `ViewerTopBar`. The name is owned by `useGuestIdentity`
// (sessionStorage-backed); this is a pure presentational chip. Testids match the retired composer
// `guest-id` block (`guest-id` / `guest-name` / `guest-rename`) so the look + hooks carry over.
//
// The name renders via React children (auto-escaped) — it's an inert plaintext label, never HTML
// (AS-019); the source pool is clean so this is display only.
export function GuestIdentityChip({
  name,
  onRename,
}: {
  /** the session-stable guest display name (from useGuestIdentity). */
  name: string;
  /** advance to the next pool name (updates the session name everywhere). */
  onRename: () => void;
}) {
  return (
    <div
      data-testid="guest-id"
      className="flex flex-none items-center gap-1.5 rounded-md border border-line bg-sunken py-1 pl-1 pr-1.5"
    >
      <span
        aria-hidden
        className="flex h-6 w-6 flex-none items-center justify-center rounded-full border border-line bg-surface text-[12px] text-subtle"
      >
        ?
      </span>
      <span
        data-testid="guest-name"
        aria-label="Your name"
        className="max-w-[140px] truncate text-[12px] font-semibold text-ink"
      >
        {name}
      </span>
      <button
        type="button"
        data-testid="guest-rename"
        onClick={onRename}
        className="flex-none cursor-pointer rounded-[5px] px-1 text-[11px] font-semibold text-accent hover:text-accent-strong"
      >
        Rename
      </button>
    </div>
  );
}
