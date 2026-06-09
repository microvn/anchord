import { cloneElement, isValidElement, useState, type ReactElement, type ReactNode } from "react";
import { Outlet } from "react-router-dom";
import { AppHeader } from "./app-header";
import { isCompact, useBreakpoint } from "../lib/use-breakpoint";

// AppShell (web-core S-001 chrome, S-003 design-system + responsive, S-004 left sidebar). The
// authenticated management chrome restructured into [ AppSidebar | (AppHeader + content outlet) ]:
//
//   - LEFT SIDEBAR (S-004): brand · `+ New doc` · workspace switcher · nav · Members footer, on a
//     recessed surface. Persistent inline on desktop/laptop; collapses to an icon rail via the
//     sidebar chevron (AS-015); becomes an off-canvas drawer on tablet/mobile, opened from the
//     header hamburger, with the switcher at the drawer top (AS-016).
//   - HEADER (S-005 will finalize): a thin top bar in `main`. For now it carries the mobile drawer
//     toggle on the left and the ACCOUNT (UserMenu) on the right — the account lives in the header,
//     NOT the sidebar footer (C-005). S-005 adds the breadcrumb + the full utilities cluster.
//
// `sidebarSlot` is the connected sidebar the real app supplies (app.tsx → <WorkspaceSidebar />,
// which mounts the workspaces-ui <WorkspaceSwitcher /> and admin-gates Members from the bootstrap
// role). It's optional so the shell renders provider-free in web-core's bare shell tests.
export function AppShell({ sidebarSlot }: { sidebarSlot?: ReactNode }) {
  const tier = useBreakpoint();
  const compact = isCompact(tier);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  // Drive the sidebar's collapse state (desktop icon rail, AS-015) from the shell, by cloning the
  // connected sidebar element with the shell-owned collapse props. On compact the sidebar is a
  // drawer (AS-016, full width), so the rail collapse doesn't apply there.
  const railSidebar = isValidElement(sidebarSlot)
    ? cloneElement(sidebarSlot as ReactElement<{ collapsed?: boolean; onToggleCollapse?: () => void }>, {
        collapsed,
        onToggleCollapse: () => setCollapsed((v) => !v),
      })
    : sidebarSlot;

  return (
    <div className="flex min-h-full" data-tier={tier}>
      {/* Persistent left sidebar — inline on desktop/laptop only (S-004). At compact it moves into
          the off-canvas drawer below. `side-region` testid preserved for the S-003 responsive shell. */}
      {!compact && (
        <div data-testid="side-region" className="shrink-0">
          {/* The sidebar's collapse chevron toggles shell-owned `collapsed` (cloned in above),
              so the rail width is shell state (AS-015). */}
          {railSidebar}
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* HEADER (thin, low-contrast — chrome recedes). The mobile drawer toggle sits on the
            left; AppHeader (S-005) carries the breadcrumb + the account/utilities cluster. The
            account (avatar menu + sign-out) lives here, not the sidebar (C-005); the switcher
            never appears here (it's the sidebar's single anchor, C-005 / AS-018.T2). */}
        <header className="flex items-center gap-2 border-b border-line bg-surface px-4 py-2.5">
          {compact && (
            <button
              type="button"
              aria-label="Open navigation"
              aria-expanded={drawerOpen}
              data-testid="drawer-toggle"
              onClick={() => setDrawerOpen((v) => !v)}
              className="flex min-h-[40px] min-w-[40px] shrink-0 items-center justify-center rounded-md border border-line bg-surface text-ink hover:border-accent"
            >
              <span aria-hidden="true">≡</span>
            </button>
          )}
          <div className="min-w-0 flex-1">
            <AppHeader />
          </div>
        </header>

        <main className="min-w-0 flex-1" data-testid="app-content">
          <Outlet />
        </main>
      </div>

      {/* Off-canvas drawer — the sidebar as a sheet at tablet/mobile, opened from the header
          hamburger. The switcher sits at the drawer top (AS-016, handled by the sidebar order). */}
      {compact && drawerOpen && (
        <div
          data-testid="side-drawer"
          role="dialog"
          aria-label="Workspace navigation"
          className="fixed inset-y-0 left-0 z-20 w-[280px] max-w-[85vw] border-r border-line bg-sunken"
        >
          <div className="flex justify-end p-1">
            <button
              type="button"
              aria-label="Close navigation"
              onClick={() => setDrawerOpen(false)}
              className="flex min-h-[40px] min-w-[40px] items-center justify-center text-muted hover:text-ink"
            >
              <span aria-hidden="true">✕</span>
            </button>
          </div>
          {/* Full (non-collapsed) sidebar inside the drawer — switcher at the top (AS-016). */}
          {sidebarSlot}
        </div>
      )}
    </div>
  );
}
