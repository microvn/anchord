import type { ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { Brandmark, Icon } from "../components/icon";
import { Button } from "../components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from "../components/ui/sidebar";

// AppSidebar (web-core S-004): the left workspace-nav frame, rebuilt on the shadcn Sidebar
// PRIMITIVE (`@/components/ui/sidebar`) instead of a hand-rolled <aside> + shell.css. The
// primitive natively owns collapse↔icon-rail (`collapsible="icon"`), the mobile off-canvas
// Sheet, keyboard toggle and state persistence — so there is no bespoke layout CSS here.
// Every surface reads the anchord `--sidebar-*` tokens (mapped to --sunken/--accent-soft/…
// in styles.css), so the recessed teal look follows the active theme.
//
// Top-to-bottom order (AS-012): brand + collapse trigger · `+ New doc` (flat teal) · the
// workspace switcher slot (owned by workspaces-ui — mounted, not rebuilt; C-005) · the primary
// nav (Dashboard · All docs · Projects · Activity) · a Members footer (admin-only, AS-014).
//
// This component is PRESENTATIONAL: the active workspace's admin role + the switcher come in as
// props/slots, so the bare AppShell (web-core S-003 shell tests) can render it without the
// workspaces data layer. app.tsx wires the connected <WorkspaceSidebar />.

export interface NavDestination {
  to: string;
  label: string;
  /** A single-glyph icon shown in the collapsed rail (kept for the AS-015 rail fallback + tests). */
  glyph: string;
  /** The Anchord-Design Icon name for this destination (stroke icon in the rail + beside the label). */
  icon: string;
}

/** A project entry in the sidebar PROJECTS group — the doc-grouping tier under OVERVIEW. */
export interface SidebarProject {
  id: string;
  name: string;
  /** Browse-visible doc count, shown as a quiet number on the right. */
  docCount?: number;
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

export function AppSidebar({
  switcherSlot,
  isAdmin = false,
  newDocHref = "#",
  membersHref = "#",
  nav = [],
  projects = [],
  projectsHref = "#",
  onNewDoc,
  // The shell tags the rendered Sidebar so its responsive tests can find it: the persistent
  // inline rail is `app-sidebar`/`side-region` on desktop; the same Sidebar renders as the
  // off-canvas Sheet at compact, tagged `side-drawer` (AS-016).
  dataTestId = "app-sidebar",
}: {
  switcherSlot?: ReactNode;
  isAdmin?: boolean;
  newDocHref?: string;
  membersHref?: string;
  nav?: NavDestination[];
  /** PROJECTS group: the workspace's projects with per-project doc counts (doc-grouping tier). */
  projects?: SidebarProject[];
  /** Base /w/:id path so the PROJECTS group can link to /w/:id/projects. */
  projectsHref?: string;
  /** When provided, the `+ New doc` button calls this instead of navigating (opens the dialog). */
  onNewDoc?: () => void;
  dataTestId?: string;
}) {
  const { pathname } = useLocation();
  // Mirror NavLink's match semantics: Dashboard (the workspace index) matches only the exact
  // `base` path; the others match their segment + any descendant. Driving `isActive` here lets
  // us pass it to the primitive's SidebarMenuButton (data-[active=true]) AND merge the anchord
  // active utilities onto the same NavLink element (asChild) that carries aria-current (AS-013).
  const isNavActive = (item: NavDestination) =>
    item.label === "Dashboard"
      ? pathname === item.to || pathname === `${item.to}/`
      : pathname === item.to || pathname.startsWith(`${item.to}/`);

  return (
    <Sidebar
      collapsible="icon"
      data-testid={dataTestId}
      // `bg-sidebar` resolves to --sunken (the recessed surface — chrome recedes behind
      // content); the bg-sunken utility is kept so the S-004 design-token assertion matches
      // this element regardless of the primitive's own bg-sidebar class.
      className="bg-sunken"
    >
      {/* 1. Brand + collapse trigger (AS-012 order #1, AS-015 toggle via the primitive's rail). */}
      <SidebarHeader>
        <div className="flex items-center gap-2 px-1">
          <NavLink to={newDocHref ? newDocHref.replace(/\/docs\/new$/, "") || "/" : "/"} className="flex min-w-0 items-center gap-2 text-ink no-underline">
            <Brandmark size={22} />
            <span
              data-testid="sidebar-brand"
              className="truncate font-serif text-[17px] font-medium tracking-[-0.02em] group-data-[collapsible=icon]:hidden"
            >
              anchord
            </span>
          </NavLink>
          <SidebarTrigger
            data-testid="sidebar-collapse"
            aria-label="Collapse sidebar"
            className="ml-auto text-muted hover:text-ink group-data-[collapsible=icon]:hidden"
          />
        </div>
      </SidebarHeader>

      <SidebarContent>
        {/* 2. Primary action — `+ New doc` (flat teal, compact ~32px). Collapses to a `+`.
            With onNewDoc it opens the publish dialog in place; otherwise it links to newDocHref. */}
        <SidebarGroup className="pb-0">
          <Button
            asChild={!onNewDoc}
            size="sm"
            data-testid="sidebar-new-doc"
            title="New doc"
            onClick={onNewDoc}
            className="h-8 w-full justify-start gap-2 bg-accent font-semibold text-on-accent hover:bg-accent-strong group-data-[collapsible=icon]:w-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
          >
            {onNewDoc ? (
              <>
                <Icon name="plus" size={16} />
                <span className="group-data-[collapsible=icon]:hidden">New doc</span>
              </>
            ) : (
              <NavLink to={newDocHref}>
                <Icon name="plus" size={16} />
                <span className="group-data-[collapsible=icon]:hidden">New doc</span>
              </NavLink>
            )}
          </Button>
        </SidebarGroup>

        {/* 3. Workspace switcher slot (AS-012; C-005 — the single switcher anchor). Owned by
            workspaces-ui — mounted here, never rebuilt. */}
        <SidebarGroup data-testid="sidebar-switcher-slot" className="py-0">
          {switcherSlot}
        </SidebarGroup>

        {/* 4. Primary nav (AS-012 order #4; active marking AS-013). */}
        <SidebarGroup>
          <SidebarGroupLabel className="font-mono text-[11px] font-medium tracking-[0.12em] text-subtle">
            Overview
          </SidebarGroupLabel>
          <SidebarMenu data-testid="sidebar-nav" aria-label="Primary">
            {nav.map((item) => {
              const active = isNavActive(item);
              return (
                <SidebarMenuItem key={item.label}>
                  <SidebarMenuButton
                    asChild
                    isActive={active}
                    tooltip={item.label}
                    // AS-013 active treatment, anchord style. The primitive's data-[active=true]
                    // already paints accent-soft bg + accent-ink text via the --sidebar-accent
                    // tokens; we ALSO append the explicit anchord utilities (bg-accent-soft /
                    // text-accent-ink + a 2px teal left bar via ::before) so the look is
                    // token-exact and the S-004 class-presence assertions match this element.
                    // With asChild these classes merge onto the NavLink <a> (which carries the
                    // testid + aria-current), so testid + active styling sit on one element.
                    className={[
                      "relative text-muted",
                      active
                        ? "bg-accent-soft text-accent-ink before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-r before:bg-accent before:content-['']"
                        : "",
                    ].join(" ")}
                  >
                    <NavLink
                      to={item.to}
                      end={item.label === "Dashboard"}
                      data-testid={`sidebar-nav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
                      title={item.label}
                    >
                      <Icon name={item.icon} size={17} />
                      <span>{item.label}</span>
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>

        {/* PROJECTS group — the doc-grouping tier under OVERVIEW. Lists the workspace's projects
            with per-project doc counts; the active project highlights; `+ New project` routes to
            the Projects screen (which hosts the create dialog). Hidden in the collapsed icon rail. */}
        {projects.length > 0 && (
          <SidebarGroup className="group-data-[collapsible=icon]:hidden" data-testid="sidebar-projects-group">
            <SidebarGroupLabel className="font-mono text-[11px] font-medium tracking-[0.12em] text-subtle">
              Projects
            </SidebarGroupLabel>
            <SidebarMenu aria-label="Projects">
              {projects.map((p) => {
                const to = `${projectsHref}?project=${p.id}`;
                const active = pathname.startsWith(`${projectsHref}`) && pathname.includes("/projects");
                return (
                  <SidebarMenuItem key={p.id}>
                    <SidebarMenuButton asChild className="relative text-muted">
                      <NavLink
                        to={to}
                        data-testid={`sidebar-project-${p.id}`}
                        title={p.name}
                        className={active ? "text-accent-ink" : undefined}
                      >
                        <Icon name="folder" size={16} />
                        <span className="truncate">{p.name}</span>
                        {p.docCount != null && (
                          <span className="ml-auto font-mono text-[10px] tabular-nums text-subtle">
                            {p.docCount}
                          </span>
                        )}
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
              <SidebarMenuItem>
                <SidebarMenuButton asChild className="text-muted">
                  <NavLink to={projectsHref} data-testid="sidebar-new-project" title="New project">
                    <Icon name="plus" size={16} />
                    <span>New project</span>
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        )}
      </SidebarContent>

      {/* 5. Footer — Members, admin-only (AS-014, C-006). The account is NOT here; it lives in
          the header (C-005). A non-admin member simply doesn't get the Members entry. */}
      {isAdmin && (
        <SidebarFooter className="border-t border-sidebar-border">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                tooltip="Members"
                className="relative text-muted data-[active=true]:before:absolute data-[active=true]:before:inset-y-1 data-[active=true]:before:left-0 data-[active=true]:before:w-0.5 data-[active=true]:before:rounded-r data-[active=true]:before:bg-accent"
              >
                <NavLink to={membersHref} data-testid="sidebar-members" title="Members">
                  <Icon name="settings" size={17} />
                  <span>Members</span>
                </NavLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      )}
    </Sidebar>
  );
}
