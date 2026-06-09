import { useState, type ReactNode } from "react";
import { Outlet } from "react-router-dom";
import { UserMenu } from "./user-menu";
import { isCompact, useBreakpoint } from "../lib/use-breakpoint";

// AppShell (S-001 chrome, S-003 design-system + responsive). The authenticated chrome:
// a thin low-contrast top bar (chrome recedes behind content — DESIGN.md) + a side region
// + the content outlet. Feature screens mount into the outlet (owned by feature `-ui` specs).
//
// S-003 / AS-010: the shell reflows off the ONE breakpoint hook (C-003). On desktop/laptop
// the side region is persistent inline; on tablet/mobile it collapses to an off-canvas
// drawer toggled by a button. Every interactive control is ≥40px (tap-target rule).
// `workspaceSlot` is the top-bar workspace-name SLOT (the spec's hand-off point): the real
// app fills it with the workspaces-ui <WorkspaceSwitcher /> (app.tsx). It's optional so the
// AppShell stays provider-free on its own — web-core's shell tests render it bare without
// needing the workspaces data layer.
export function AppShell({ workspaceSlot }: { workspaceSlot?: ReactNode }) {
  const tier = useBreakpoint();
  const compact = isCompact(tier);
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex min-h-full flex-col" data-tier={tier}>
      <header className="flex items-center justify-between border-b border-line bg-surface px-4 py-2.5">
        <div className="flex items-center gap-2">
          {/* Drawer toggle only exists at tablet/mobile (compact); desktop shows the side
              region inline so no toggle is needed. ≥40px tap target. */}
          {compact && (
            <button
              type="button"
              aria-label="Open navigation"
              aria-expanded={drawerOpen}
              data-testid="drawer-toggle"
              onClick={() => setDrawerOpen((v) => !v)}
              className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-md border border-line bg-surface text-ink hover:border-accent"
            >
              <span aria-hidden="true">≡</span>
            </button>
          )}
          <span className="font-serif text-base tracking-tight text-ink">anchord</span>
          {/* workspaces-ui S-001 fills this workspace-name slot with the <WorkspaceSwitcher />. */}
          {workspaceSlot}
        </div>
        <UserMenu />
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Persistent side region — inline on desktop/laptop only. */}
        {!compact && (
          <nav
            data-testid="side-region"
            className="w-[236px] shrink-0 border-r border-line bg-surface"
            aria-label="Workspace navigation"
          />
        )}

        <main className="min-w-0 flex-1" data-testid="app-content">
          <Outlet />
        </main>
      </div>

      {/* Off-canvas drawer — the side region as a sheet at tablet/mobile, toggled above. */}
      {compact && drawerOpen && (
        <div
          data-testid="side-drawer"
          role="dialog"
          aria-label="Workspace navigation"
          className="fixed inset-y-0 left-0 z-20 w-[280px] max-w-[85vw] border-r border-line bg-elev"
        >
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setDrawerOpen(false)}
            className="flex min-h-[40px] min-w-[40px] items-center justify-center text-muted hover:text-ink"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      )}
    </div>
  );
}
