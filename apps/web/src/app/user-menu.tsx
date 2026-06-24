import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { signOut, useSession } from "@/lib/api/auth-client";
import { Icon } from "@/components/icon";
import { initials } from "@/lib/initials";
import { MENU_ITEM } from "./app-header";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// UserMenu (S-001 AS-005 sign-out; S-005 AS-018 the header avatar menu). The account avatar
// anchors the header right edge; its menu offers Settings + Sign out, re-skinned to the
// Anchord-Design `.menu` look on a shadcn DropdownMenu (radix owns open/close, outside-click,
// keyboard + portal). Calling better-auth signOut clears the server session cookie; we then
// return to the sign-in screen. No client token to clear (C-001). The account lives in the
// HEADER, never the sidebar (C-005).
//
// On mobile (AS-019) the standalone theme toggle + notifications fold INTO this menu — the
// caller passes `foldedItems` (rendered above Settings/Sign out) and the avatar stays visible.
//
// NOTE: the menu items are NATIVE <button>s (not radix DropdownMenuItem) so they keep the
// implicit button role — S-001 AS-005's getByRole("button", {name:/sign out/i}) depends on it.
// We close the menu manually onClick; radix still provides the focus trap + outside-click.
export function UserMenu({ foldedItems }: { foldedItems?: ReactNode }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const { data: session } = useSession();
  const name = session?.user?.name?.trim() || null;
  const email = session?.user?.email ?? null;
  const initialsText = initials(name ?? email);

  async function handleSignOut() {
    setOpen(false);
    await signOut();
    navigate("/signin", { replace: true });
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="user-menu-trigger"
          aria-label="Account menu"
          // ≥40px tap target (AS-019); the avatar anchors the header's right edge.
          className="inline-flex min-h-[40px] min-w-[40px] items-center justify-center rounded-md text-muted transition-colors hover:bg-elev"
        >
          {/* A round teal-tinted chip with the user's initials (Anchord-Design `.avatar`,
              rounded-full). 28px to match the prototype's "ML" header avatar. */}
          <span
            data-testid="user-menu-avatar"
            className="inline-flex size-7 items-center justify-center rounded-full bg-accent-soft font-mono text-[10.5px] font-semibold text-accent-ink"
          >
            {initialsText}
          </span>
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        data-testid="user-menu"
        // Anchord menu surface: `elev` bg + a `line` hairline + the pop shadow (drops shadcn zinc).
        className="w-[236px] rounded-[11px] border border-line bg-elev p-1.5 shadow-[var(--shadow-pop)]"
      >
        {/* Identity header — round avatar + name/email (1:1 with shell.jsx AccountMenu). */}
        {(name || email) && (
          <>
            <div className="flex items-center gap-2.5 px-2 pb-2.5 pt-2">
              <span className="inline-flex size-8 flex-none items-center justify-center rounded-full bg-accent-soft font-mono text-[11px] font-semibold text-accent-ink">
                {initialsText}
              </span>
              <div className="min-w-0">
                {name && <div className="truncate text-[12.5px] font-semibold text-ink">{name}</div>}
                {email && <div className="truncate text-[11px] text-subtle">{email}</div>}
              </div>
            </div>
            <div className="-mx-1.5 mb-1 h-px bg-line" />
          </>
        )}
        {/* Folded utilities (mobile, AS-019): theme toggle + notifications live here when the
            header has condensed. Empty on desktop, where they sit inline in the header. */}
        {foldedItems}
        <button
          type="button"
          data-testid="menu-your-activity"
          // your-activity-inbox S-001: open the account-scoped "Your activity" page (For-you
          // inbox). Same pattern as Settings — close the menu, then navigate to /me/activity.
          onClick={() => {
            setOpen(false);
            navigate("/me/activity");
          }}
          className={MENU_ITEM}
        >
          <Icon name="inbox" size={16} />
          Your activity
        </button>
        <button
          type="button"
          data-testid="menu-settings"
          // account-settings S-001 (AS-001): open the account-level Settings area (Account
          // section by default). Close the menu, then navigate to /settings.
          onClick={() => {
            setOpen(false);
            navigate("/settings");
          }}
          className={MENU_ITEM}
        >
          <Icon name="settings" size={16} />
          Settings
        </button>
        <button type="button" data-testid="menu-sign-out" onClick={handleSignOut} className={MENU_ITEM}>
          <Icon name="logout" size={16} />
          Sign out
        </button>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
