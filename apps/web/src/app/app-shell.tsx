import { cloneElement, isValidElement, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { Outlet } from "react-router-dom";
import { AppHeader } from "./app-header";
import { isCompact, useBreakpoint } from "../lib/use-breakpoint";
import {
  Sidebar,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "../components/ui/sidebar";

// AppShell (web-core S-001 chrome, S-003 design-system + responsive, S-004 left sidebar),
// rebuilt on the shadcn Sidebar PRIMITIVE. `SidebarProvider` owns the collapse↔icon-rail state,
// the mobile off-canvas Sheet, the keyboard toggle and cookie persistence.
//
//   - LEFT SIDEBAR (S-004): the connected <WorkspaceSidebar/> (brand · +New doc · switcher ·
//     nav · Members) on the recessed `--sidebar` (= --sunken) surface. Persistent inline on
//     desktop/laptop (tagged `side-region`); collapses to an icon rail via the SidebarTrigger
//     (AS-015); becomes the primitive's Sheet drawer at tablet/mobile (tagged `side-drawer`,
//     AS-016), opened from the header trigger.
//   - HEADER (S-005): a thin top bar carrying the mobile drawer toggle + the AppHeader
//     (breadcrumb + account/utilities cluster).
//
// `sidebarSlot` is the connected sidebar app.tsx supplies; it's optional so the shell renders
// provider-clean in web-core's bare shell tests.

// The inner shell, mounted INSIDE SidebarProvider so it can read `useSidebar()` (mobile open
// state + toggle). It selects the responsive testid wrappers off the single anchord breakpoint.
function ShellInner({ sidebarSlot }: { sidebarSlot?: ReactNode }) {
  const tier = useBreakpoint();
  const compact = isCompact(tier);

  // At compact the connected sidebar is re-tagged `side-drawer` so the AS-016 drawer assertions
  // find the primitive's Sheet. With no slot (web-core's bare shell tests) we still render an
  // empty `side-drawer` Sidebar so the off-canvas drawer exists.
  const drawerSidebar = isValidElement(sidebarSlot)
    ? cloneElement(sidebarSlot as ReactElement<{ dataTestId?: string }>, { dataTestId: "side-drawer" })
    : (
        <Sidebar data-testid="side-drawer" collapsible="offcanvas" className="bg-sunken" />
      );

  return (
    <>
      {/* Persistent inline sidebar — desktop/laptop only (S-004). At compact `side-region` is
          absent from the tree (AS-016 / S-003). */}
      {!compact && <div data-testid="side-region" className="contents">{sidebarSlot}</div>}

      {/* At compact the sidebar is the primitive's off-canvas Sheet (mounted only when open),
          tagged `side-drawer`. The header SidebarTrigger toggles it. */}
      {compact && drawerSidebar}

      <SidebarInset className="min-w-0 bg-paper">
        {/* HEADER (thin, low-contrast — chrome recedes). bg-surface + a `line` hairline. */}
        <header className="flex h-[52px] flex-none items-center gap-3 border-b border-line bg-surface pl-4 pr-[14px]">
          {compact && (
            <SidebarTrigger
              aria-label="Open navigation"
              data-testid="drawer-toggle"
              className="size-auto min-h-[40px] min-w-[40px] text-muted hover:text-ink"
            />
          )}
          <div className="min-w-0 flex-1">
            <AppHeader />
          </div>
        </header>

        <main className="min-w-0 flex-1 overflow-y-auto" data-testid="app-content">
          <Outlet />
        </main>
      </SidebarInset>
    </>
  );
}

export function AppShell({ sidebarSlot }: { sidebarSlot?: ReactNode }) {
  return (
    <SidebarProvider
      // Width computed-matched to shell.css .sidebar (--rail-w: 248px); the shadcn default is 16rem.
      style={{ "--sidebar-width": "248px" } as CSSProperties}
      className="h-screen min-h-full overflow-hidden bg-paper"
    >
      <ShellInner sidebarSlot={sidebarSlot} />
    </SidebarProvider>
  );
}
