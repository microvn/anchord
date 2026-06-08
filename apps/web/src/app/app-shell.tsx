import { Outlet } from "react-router-dom";
import { UserMenu } from "./user-menu";

// AppShell placeholder (S-001) — the minimal authenticated chrome. Feature screens
// (ProjectBrowser, doc viewer, share, diff) are OUT of web-core scope; they mount into
// the content outlet, owned by their feature `-ui` specs. This slice just needs an
// authenticated shell so AS-002 ("lands on the app") is observable: a thin top bar with
// the UserMenu (→ sign out, AS-005) and an empty content outlet.
export function AppShell() {
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center justify-between border-b border-line bg-surface px-4 py-2.5">
        <span className="font-serif text-base tracking-tight text-ink">anchord</span>
        <UserMenu />
      </header>
      <main className="flex-1" data-testid="app-content">
        <Outlet />
      </main>
    </div>
  );
}
