import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "../lib/auth-client";
import { Icon } from "../components/icon";
import { MENU_ITEM } from "./app-header";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";

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
          <span className="inline-flex size-[26px] items-center justify-center rounded-full bg-accent-soft font-mono text-[10.5px] font-semibold text-accent-ink">
            AC
          </span>
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        data-testid="user-menu"
        // Anchord menu surface: `elev` bg + a `line` hairline + the pop shadow (drops shadcn zinc).
        className="w-[236px] rounded-[11px] border border-line bg-elev p-1.5 shadow-[var(--shadow-pop)]"
      >
        {/* Folded utilities (mobile, AS-019): theme toggle + notifications live here when the
            header has condensed. Empty on desktop, where they sit inline in the header. */}
        {foldedItems}
        <button
          type="button"
          data-testid="menu-settings"
          onClick={() => setOpen(false)}
          // No settings route ships in web-core (workspace-project-ui owns it) — inert placeholder.
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
