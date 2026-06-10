import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Brandmark, Icon } from "../components/icon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/ui/tooltip";

// AppSidebar (web-core S-004): the left workspace-nav frame, re-skinned to Anchord-Design's
// `shell.css` (.sidebar/.newdoc/.switcher/.nav-item/.sb-foot). DESIGN.md §App shell — the sidebar
// sits on a RECESSED (`sunken`) surface so chrome recedes behind content; only the active nav item
// lights up (accent-soft bg + 2px teal left bar + accent-ink text).
//
// Top-to-bottom order (AS-012): brand + collapse chevron · `+ New doc` (flat teal) · the workspace
// switcher slot (owned by workspaces-ui — mounted here, not rebuilt) · the primary nav
// (Dashboard · All docs · Projects · Activity) · a Members/Settings footer (admin-only, AS-014).
//
// This component is PRESENTATIONAL: the active workspace's admin role + the switcher come in as
// props/slots, so the bare AppShell (web-core S-003 tests) can render it without the workspaces
// data layer. app.tsx wires the connected <WorkspaceSidebar /> that supplies the real switcher +
// role from the /api/me bootstrap.
//
// Collapse (AS-015): the chevron toggles an icon RAIL (~56px) — glyphs + tooltips only; the
// switcher slot is replaced by a workspace glyph and `+ New doc` by a bare `+`. Toggling restores.
// Responsive (AS-016) is owned by AppShell: at compact this same sidebar renders inside an
// off-canvas Sheet drawer with the switcher at the top.

export interface NavDestination {
  to: string;
  label: string;
  /** A single-glyph icon shown in the collapsed rail (kept for the AS-015 rail fallback + tests). */
  glyph: string;
  /** The Anchord-Design Icon name for this destination (stroke icon in the rail + beside the label). */
  icon: string;
}

// GAP-002: the destination SCREENS (Dashboard / All docs / Projects / Activity) are owned by
// workspace-project-ui and not built here. The shell renders the nav + ROUTES to them regardless;
// a destination with no screen yet routes to a placeholder. `base` is the active workspace path.
export function navDestinations(base: string): NavDestination[] {
  return [
    { to: `${base}`, label: "Dashboard", glyph: "▦", icon: "dashboard" },
    { to: `${base}/docs`, label: "All docs", glyph: "▤", icon: "docs" },
    { to: `${base}/projects`, label: "Projects", glyph: "◳", icon: "folder" },
    { to: `${base}/activity`, label: "Activity", glyph: "◷", icon: "activity" },
  ];
}

// Wrap a rail control in a shadcn Tooltip ONLY when collapsed (the label is hidden then). shadcn
// owns the tooltip behavior (portal, keyboard, focus); we skin its content with `.rail-tip`.
function RailTip({ label, collapsed, children }: { label: string; collapsed: boolean; children: ReactNode }) {
  if (!collapsed) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" className="rail-tip border-0 bg-ink text-paper">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function AppSidebar({
  switcherSlot,
  isAdmin = false,
  collapsed = false,
  onToggleCollapse,
  newDocHref = "#",
  membersHref = "#",
  nav = [],
}: {
  switcherSlot?: ReactNode;
  isAdmin?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  newDocHref?: string;
  membersHref?: string;
  nav?: NavDestination[];
}) {
  return (
    <TooltipProvider delayDuration={150}>
      <aside
        data-testid="app-sidebar"
        data-collapsed={collapsed ? "true" : "false"}
        // `.sidebar` carries the recessed `sunken` surface + rail width from shell.css; the
        // `bg-sunken` utility is kept so the S-004 design-token assertion still matches.
        className="sidebar thin-scroll bg-sunken"
      >
        {/* 1. Brand + collapse chevron (AS-012 order #1, AS-015 toggle). */}
        <div className="sb-top">
          <span className="brand">
            <Brandmark size={22} />
            {!collapsed && (
              <span data-testid="sidebar-brand" className="brand-name">
                anchord
              </span>
            )}
          </span>
          <button
            type="button"
            data-testid="sidebar-collapse"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand" : "Collapse"}
            onClick={onToggleCollapse}
            className="icon-btn collapse-btn"
          >
            <Icon name="chevLeft" size={16} />
          </button>
        </div>

        <div className="sb-body thin-scroll">
          {/* 2. Primary action — `+ New doc` (flat teal). Collapses to a bare `+` glyph (AS-015). */}
          <div className="sb-action">
            <RailTip label="New doc" collapsed={collapsed}>
              <NavLink to={newDocHref} data-testid="sidebar-new-doc" title="New doc" className="newdoc">
                <Icon name="plus" size={16} />
                {!collapsed && <span className="lbl">New doc</span>}
              </NavLink>
            </RailTip>
          </div>

          {/* 3. Workspace switcher slot (AS-012; C-005 — the single switcher anchor). When collapsed
              the rail shows a workspace glyph in its place. The slot is owned by workspaces-ui. */}
          <div data-testid="sidebar-switcher-slot">
            {collapsed ? (
              <RailTip label="Workspace" collapsed={collapsed}>
                <div
                  data-testid="sidebar-switcher-glyph"
                  title="Workspace"
                  aria-label="Workspace"
                  className="switcher-rail"
                >
                  <span className="ws-glyph">W</span>
                </div>
              </RailTip>
            ) : (
              switcherSlot
            )}
          </div>

          {/* 4. Primary nav (AS-012 order #4; active marking AS-013). */}
          <nav data-testid="sidebar-nav" aria-label="Primary" className="nav-group">
            {!collapsed && <div className="group-label mono-label">Overview</div>}
            {nav.map((item) => (
              <RailTip key={item.label} label={item.label} collapsed={collapsed}>
                <NavLink
                  to={item.to}
                  // `end` on Dashboard (the workspace index) so it isn't marked active on child routes.
                  end={item.label === "Dashboard"}
                  data-testid={`sidebar-nav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
                  title={item.label}
                  className={({ isActive }) =>
                    // AS-013 active styling lives in `.nav-item.active` (accent-soft bg + accent-ink
                    // + 2px teal left bar). The Tailwind utilities are ALSO appended so the S-004
                    // class-presence assertions (bg-accent-soft / text-accent-ink / before:bg-accent)
                    // keep matching the same element.
                    [
                      "nav-item",
                      isActive
                        ? "active bg-accent-soft text-accent-ink before:bg-accent"
                        : "",
                    ].join(" ")
                  }
                >
                  <Icon name={item.icon} size={17} className="ic" />
                  {!collapsed && <span className="lbl">{item.label}</span>}
                </NavLink>
              </RailTip>
            ))}
          </nav>
        </div>

        {/* 5. Footer — Members / Settings, admin-only (AS-014, C-006). The account is NOT here; it
            lives in the header (C-005). A non-admin member simply doesn't get the Members entry. */}
        <div className="sb-foot">
          {isAdmin ? (
            <RailTip label="Members & Settings" collapsed={collapsed}>
              <NavLink
                to={membersHref}
                data-testid="sidebar-members"
                title="Members / Settings"
                className={({ isActive }) =>
                  ["nav-item", isActive ? "active bg-accent-soft text-accent-ink" : ""].join(" ")
                }
              >
                <Icon name="settings" size={17} className="ic" />
                {!collapsed && <span className="lbl">Members</span>}
              </NavLink>
            </RailTip>
          ) : null}
        </div>
      </aside>
    </TooltipProvider>
  );
}
