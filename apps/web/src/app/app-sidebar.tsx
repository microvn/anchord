import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";

// AppSidebar (web-core S-004): the left workspace-nav frame. DESIGN.md §App shell — the sidebar
// sits on a RECESSED (lower-contrast `sunken`) surface so chrome recedes behind content; only the
// active nav item lights up (accent-soft bg + 2px teal left bar + accent-ink text).
//
// Top-to-bottom order (AS-012): brand + collapse chevron · `+ New doc` (solid) · the workspace
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
// Responsive (AS-016) is owned by AppShell: at mobile this same sidebar renders inside an
// off-canvas drawer with the switcher at the top.

export interface NavDestination {
  to: string;
  label: string;
  /** A single-glyph icon shown in the collapsed rail (and beside the label when open). */
  glyph: string;
}

// GAP-002: the destination SCREENS (Dashboard / All docs / Projects / Activity) are owned by
// workspace-project-ui and not built here. The shell renders the nav + ROUTES to them regardless;
// a destination with no screen yet routes to a placeholder. `base` is the active workspace path.
export function navDestinations(base: string): NavDestination[] {
  return [
    { to: `${base}`, label: "Dashboard", glyph: "▦" },
    { to: `${base}/docs`, label: "All docs", glyph: "▤" },
    { to: `${base}/projects`, label: "Projects", glyph: "◳" },
    { to: `${base}/activity`, label: "Activity", glyph: "◷" },
  ];
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
    <div
      data-testid="app-sidebar"
      data-collapsed={collapsed ? "true" : "false"}
      // RECESSED surface (AS-012): `sunken` is below the content `paper`/`surface`. The width
      // collapses to the ~56px icon rail (AS-015).
      className={`flex h-full flex-col border-r border-line bg-sunken ${
        collapsed ? "w-[56px]" : "w-[248px]"
      }`}
    >
      {/* 1. Brand + collapse chevron (AS-012 order #1, AS-015 toggle). */}
      <div className="flex items-center justify-between px-3 py-3">
        {!collapsed && (
          <span data-testid="sidebar-brand" className="font-serif text-base tracking-tight text-ink">
            anchord
          </span>
        )}
        <button
          type="button"
          data-testid="sidebar-collapse"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand" : "Collapse"}
          onClick={onToggleCollapse}
          className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-md text-muted hover:bg-elev hover:text-ink"
        >
          <span aria-hidden="true">{collapsed ? "›" : "‹"}</span>
        </button>
      </div>

      {/* 2. Primary action — `+ New doc` (solid). Collapses to a bare `+` glyph (AS-015). */}
      <div className="px-3 pb-2">
        <NavLink
          to={newDocHref}
          data-testid="sidebar-new-doc"
          title="New doc"
          className="flex min-h-[40px] items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-paper hover:bg-accent-strong"
        >
          <span aria-hidden="true">+</span>
          {!collapsed && <span>New doc</span>}
        </NavLink>
      </div>

      {/* 3. Workspace switcher slot (AS-012; C-005 — the single switcher anchor). When collapsed
          the rail shows a workspace glyph in its place. The slot is owned by workspaces-ui. */}
      <div className="px-3 pb-2" data-testid="sidebar-switcher-slot">
        {collapsed ? (
          <div
            data-testid="sidebar-switcher-glyph"
            title="Workspace"
            aria-label="Workspace"
            className="flex min-h-[40px] items-center justify-center rounded-md text-muted hover:bg-elev hover:text-ink"
          >
            <span aria-hidden="true">⬢</span>
          </div>
        ) : (
          switcherSlot
        )}
      </div>

      {/* 4. Primary nav (AS-012 order #4; active marking AS-013). */}
      <nav data-testid="sidebar-nav" aria-label="Primary" className="flex flex-1 flex-col gap-0.5 px-3 py-1">
        {nav.map((item) => (
          <NavLink
            key={item.label}
            to={item.to}
            // `end` on Dashboard (the workspace index) so it isn't marked active on child routes.
            end={item.label === "Dashboard"}
            data-testid={`sidebar-nav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
            title={item.label}
            className={({ isActive }) =>
              [
                "relative flex min-h-[40px] items-center gap-2.5 rounded-md px-3 text-sm",
                // AS-013 active styling: accent-soft bg + accent-ink text + 2px teal left bar.
                isActive
                  ? "bg-accent-soft text-accent-ink before:absolute before:inset-y-1.5 before:left-0 before:w-[2px] before:rounded-full before:bg-accent before:content-['']"
                  : "text-muted hover:bg-elev hover:text-ink",
                collapsed ? "justify-center" : "",
              ].join(" ")
            }
          >
            <span aria-hidden="true" className="text-base leading-none">
              {item.glyph}
            </span>
            {!collapsed && <span>{item.label}</span>}
          </NavLink>
        ))}
      </nav>

      {/* 5. Footer — Members / Settings, admin-only (AS-014, C-006). The account is NOT here; it
          lives in the header (C-005). A non-admin member simply doesn't get the Members entry. */}
      <div className="mt-auto border-t border-line px-3 py-2">
        {isAdmin ? (
          <NavLink
            to={membersHref}
            data-testid="sidebar-members"
            title="Members / Settings"
            className={({ isActive }) =>
              [
                "flex min-h-[40px] items-center gap-2.5 rounded-md px-3 text-sm",
                isActive ? "bg-accent-soft text-accent-ink" : "text-muted hover:bg-elev hover:text-ink",
                collapsed ? "justify-center" : "",
              ].join(" ")
            }
          >
            <span aria-hidden="true">⚙</span>
            {!collapsed && <span>Members</span>}
          </NavLink>
        ) : null}
      </div>
    </div>
  );
}
