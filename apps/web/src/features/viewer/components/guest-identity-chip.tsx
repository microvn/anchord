import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

// GuestIdentityChip (annotation-core S-007 / AS-016, C-007): the persistent identity chip in the top
// bar for a logged-out commenter. Shows a `?` hint disc + the SESSION name + a Rename control that
// re-rolls the session name everywhere it appears (the chip here + the name that rides each guest
// comment). It sits NEXT TO the Sign in CTA in `ViewerTopBar`. The name is owned by `useGuestIdentity`
// (sessionStorage-backed); this is a pure presentational chip. Testids match the retired composer
// `guest-id` block (`guest-id` / `guest-name` / `guest-rename`) so the look + hooks carry over.
//
// The `?` disc is a ShadCN Tooltip trigger (hover/focus) explaining the handle is a TEMPORARY guest
// identity for this session — so the bare `adjective-animal-suffix` handle isn't a mystery, without
// crowding the top bar with always-on copy (AS-016: the chip implies "commenting as <name>").
//
// The name renders via React children (auto-escaped) — it's an inert plaintext label, never HTML
// (AS-019); the source pool is clean so this is display only.
export function GuestIdentityChip({
  name,
  onRename,
}: {
  /** the session-stable guest display name (from useGuestIdentity). */
  name: string;
  /** re-roll to a different random name (updates the session name everywhere). */
  onRename: () => void;
}) {
  return (
    <div
      data-testid="guest-id"
      className="flex flex-none items-center gap-1.5 rounded-md border border-line bg-sunken py-1 pl-1 pr-1.5"
    >
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-testid="guest-id-hint"
              aria-label="About your guest name"
              // The `?` hint is a hover/focus tooltip trigger — useless on a touch device and pure
              // bar-width cost there, so it's hidden below `sm` and the chip stays compact on a phone.
              className="hidden h-6 w-6 flex-none cursor-help items-center justify-center rounded-full border border-line bg-surface text-[12px] text-subtle hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:flex"
            >
              ?
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            align="start"
            data-testid="guest-id-tooltip"
            className="max-w-[260px] text-left"
          >
            <p className="font-semibold">You're commenting as a guest</p>
            <p className="mt-0.5 opacity-90">
              <span className="font-medium">{name}</span> is a temporary name for this session. Your
              comments show under it — sign in to comment with your account.
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <span
        data-testid="guest-name"
        aria-label="Your name"
        className="max-w-[64px] truncate text-[12px] font-semibold text-ink sm:max-w-[140px]"
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
