import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "../lib/auth-client";

// UserMenu (S-001 AS-005 sign-out; S-005 AS-018 the header avatar menu). The account avatar
// anchors the header right edge; its menu offers Settings + Sign out. Calling better-auth
// signOut clears the server session cookie; we then return to the sign-in screen. No client
// token to clear (C-001). The account lives in the HEADER, never the sidebar (C-005).
//
// On mobile (AS-019) the standalone theme toggle + notifications fold INTO this menu — the
// caller passes `foldedItems` (rendered above Settings/Sign out) and the avatar stays visible.
export function UserMenu({ foldedItems }: { foldedItems?: ReactNode }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  async function handleSignOut() {
    await signOut();
    navigate("/signin", { replace: true });
  }

  return (
    <div className="relative">
      <button
        type="button"
        data-testid="user-menu-trigger"
        aria-label="Account menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        // ≥40px tap target (AS-019). The avatar anchors the header's right edge.
        className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-md border border-line bg-surface px-3 text-sm text-ink hover:border-accent"
      >
        <span>Account</span>
        <span aria-hidden="true" className="ml-1 text-faint">
          ▾
        </span>
      </button>
      {open && (
        <div
          data-testid="user-menu"
          className="absolute right-0 mt-1 w-48 rounded-md border border-line bg-elev p-1 shadow-lg"
        >
          {/* Folded utilities (mobile, AS-019): theme toggle + notifications live here when the
              header has condensed. Empty on desktop, where they sit inline in the header. The menu
              items stay plain <button>s (native button role) so S-001 AS-005's getByRole("button",
              {name:/sign out/i}) keeps matching — an explicit role="menuitem" would shadow it. */}
          {foldedItems}
          <button
            type="button"
            data-testid="menu-settings"
            // No settings route ships in web-core (workspace-project-ui owns it) — inert placeholder.
            className="flex min-h-[40px] w-full items-center rounded-sm px-3 text-left text-sm text-ink hover:bg-accent-soft"
          >
            Settings
          </button>
          <button
            type="button"
            data-testid="menu-sign-out"
            onClick={handleSignOut}
            className="flex min-h-[40px] w-full items-center rounded-sm px-3 text-left text-sm text-ink hover:bg-accent-soft"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
