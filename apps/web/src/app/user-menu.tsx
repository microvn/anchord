import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "../lib/auth-client";

// UserMenu (S-001, AS-005): sign out. Calling better-auth signOut clears the server
// session cookie; we then return to the sign-in screen. No client token to clear (C-001).
export function UserMenu() {
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
        aria-label="Account menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="min-h-[40px] min-w-[40px] rounded-md border border-line bg-surface px-3 text-sm text-ink"
      >
        Account
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-40 rounded-md border border-line bg-elev p-1 shadow-lg">
          <button
            type="button"
            onClick={handleSignOut}
            className="min-h-[40px] w-full rounded-sm px-3 text-left text-sm text-ink hover:bg-accent-soft"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
