import { cloneElement, isValidElement, useState, type ReactElement, type ReactNode } from "react";
import { Outlet } from "react-router-dom";
import { AppHeader } from "./app-header";
import { isCompact, useBreakpoint } from "../lib/use-breakpoint";
import { Icon } from "../components/icon";
import { Sheet, SheetContent, SheetTitle } from "../components/ui/sheet";

// AppShell (web-core S-001 chrome, S-003 design-system + responsive, S-004 left sidebar). The
// authenticated management chrome restructured into [ AppSidebar | (AppHeader + content outlet) ],
// re-skinned to Anchord-Design `shell.css`:
//
//   - LEFT SIDEBAR (S-004): brand · `+ New doc` · workspace switcher · nav · Members footer, on a
//     recessed surface. Persistent inline on desktop/laptop; collapses to an icon rail via the
//     sidebar chevron (AS-015); becomes an off-canvas Sheet drawer on tablet/mobile, opened from
//     the header hamburger, with the switcher at the drawer top (AS-016).
//   - HEADER (S-005): a thin top bar in `main` (the `.header` surface). It carries the mobile
//     drawer toggle on the left and the AppHeader (breadcrumb + account/utilities cluster).
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
    <div className="flex h-screen min-h-full overflow-hidden bg-paper" data-tier={tier}>
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
        {/* HEADER (thin, low-contrast — chrome recedes). The `.header` skin carries the `surface`
            bg + `line` hairline; the bg-surface/border-line utilities are kept so the S-003
            design-token assertion still matches the banner. The mobile drawer toggle sits on the
            left; AppHeader carries the breadcrumb + account/utilities cluster. */}
        <header className="header bg-surface border-line">
          {compact && (
            <button
              type="button"
              aria-label="Open navigation"
              aria-expanded={drawerOpen}
              data-testid="drawer-toggle"
              onClick={() => setDrawerOpen(true)}
              className="icon-btn hamburger min-h-[40px] min-w-[40px]"
            >
              <Icon name="menu" size={18} />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <AppHeader />
          </div>
        </header>

        <main className="min-w-0 flex-1 overflow-y-auto thin-scroll" data-testid="app-content">
          <Outlet />
        </main>
      </div>

      {/* Off-canvas drawer — the sidebar as a shadcn Sheet at tablet/mobile, opened from the header
          hamburger. radix owns the focus trap / outside-click / Esc; we skin the panel with
          `.drawer-sheet`. The switcher sits at the drawer top (AS-016, handled by the sidebar order). */}
      {compact && (
        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetContent
            side="left"
            showCloseButton={false}
            data-testid="side-drawer"
            aria-label="Workspace navigation"
            className="drawer-sheet"
          >
            <SheetTitle className="sr-only">Workspace navigation</SheetTitle>
            {/* Full (non-collapsed) sidebar inside the drawer — switcher at the top (AS-016). */}
            {sidebarSlot}
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
