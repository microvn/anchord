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
  useSidebar,
} from "../components/ui/sidebar";

// AppSidebar (web-core S-004): the left workspace-nav frame, rebuilt on the shadcn Sidebar
// PRIMITIVE (`@/components/ui/sidebar`) instead of a hand-rolled <aside> + shell.css. The
// primitive natively owns collapse↔icon-rail (`collapsible="icon"`), the mobile off-canvas
// Sheet, keyboard toggle and state persistence — so there is no bespoke layout CSS here.
// Every surface reads the anchord `--sidebar-*` tokens (mapped to --sunken/--accent-soft/…
// in styles.css), so the recessed teal look follows the active theme.
//
// Top-to-bottom order (AS-012): brand + collapse trigger · `+ New doc` (flat teal) · the
// workspace switcher slot (owned by workspaces-ui — mounted, not rebuilt; C-005) · the OVERVIEW
// nav (Dashboard · All docs WITH a count badge · Projects · Activity) · a RECENT group (the
// most-recent docs + a "→ View all docs" link) · a Members footer (admin-only, AS-014).
// 1:1 with Anchord-Design shell.jsx — the 2nd group is RECENT docs, NOT a projects list.
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

/** A recent-doc entry in the sidebar RECENT group (icon + truncated title → the doc viewer). */
export interface SidebarRecentDoc {
  slug: string;
  title: string;
  /** The Anchord-Design Icon name for this doc's format chip. */
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

export function AppSidebar({
  switcherSlot,
  isAdmin = false,
  newDocHref = "#",
  membersHref = "#",
  nav = [],
  recentDocs = [],
  totalDocs,
  docsHref = "#",
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
  /** RECENT group: the most-recent docs (≈6), icon + title → the doc viewer. */
  recentDocs?: SidebarRecentDoc[];
  /** Total workspace doc count — the teal pill on the `All docs` nav item. */
  totalDocs?: number;
  /** Base /w/:id/docs path — the "→ View all docs" link + the All-docs nav target. */
  docsHref?: string;
  /** When provided, the `+ New doc` button calls this instead of navigating (opens the dialog). */
  onNewDoc?: () => void;
  dataTestId?: string;
}) {
  const { pathname } = useLocation();
  const { toggleSidebar } = useSidebar();
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
              className="truncate font-serif text-[19px] font-medium tracking-[-0.03em] group-data-[collapsible=icon]:hidden"
            >
              anchord
            </span>
          </NavLink>
          <button
            type="button"
            data-testid="sidebar-collapse"
            aria-label="Collapse sidebar"
            onClick={toggleSidebar}
            className="ml-auto grid size-7 flex-none place-items-center rounded-md text-muted hover:bg-elev hover:text-ink group-data-[collapsible=icon]:hidden"
          >
            <Icon name="chevLeft" size={16} />
          </button>
        </div>
      </SidebarHeader>

      {/* gap-0 + explicit per-group spacing matches the prototype's `.sb-body` rhythm (block
          flow with margin-top on each group), not the shadcn default gap-2 between groups.
          px-[10px] gives the 10px L / 11px R content inset (227px items inside the 248px rail). */}
      <SidebarContent className="gap-0 px-[10px] py-[4px] pb-[10px]">
        {/* 2. Primary action — `+ New doc` (flat teal, compact ~32px). Collapses to a `+`.
            With onNewDoc it opens the publish dialog in place; otherwise it links to newDocHref.
            `.sb-action` = padding 2px 0 10px → pt-[2px] pb-[10px], no horizontal pad (inset owned
            by SidebarContent). */}
        <SidebarGroup className="px-0 pt-[2px] pb-[10px]">
          <Button
            asChild={!onNewDoc}
            size="sm"
            data-testid="sidebar-new-doc"
            title="New doc"
            onClick={onNewDoc}
            className="h-8 w-full justify-start gap-2 rounded-md px-[11px] text-[12.5px] font-semibold bg-accent text-on-accent hover:bg-accent-strong has-[>svg]:px-[11px] group-data-[collapsible=icon]:w-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
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
        {/* `.switcher` carries margin-bottom 8px in the prototype → mb-2 here (the trigger's own
            38px height is set in workspace-switcher.tsx). px-0: inset owned by SidebarContent. */}
        <SidebarGroup data-testid="sidebar-switcher-slot" className="px-0 py-0 mb-2">
          {switcherSlot}
        </SidebarGroup>

        {/* 4. Primary nav (AS-012 order #4; active marking AS-013). `.nav-group` = margin-top 12px
            (mt-3); px-0 because SidebarContent owns the 10px inset. */}
        <SidebarGroup className="px-0 py-0 mt-3">
          <SidebarGroupLabel className="h-auto px-[9px] pb-[6px] font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-subtle">
            Overview
          </SidebarGroupLabel>
          {/* gap-px → 1px between rows (the prototype's block rows collapse the 1px top+bottom
              margins to 1px; flex gap-px reproduces that without margin collapse). */}
          <SidebarMenu data-testid="sidebar-nav" aria-label="Primary" className="gap-px">
            {nav.map((item) => {
              const active = isNavActive(item);
              return (
                <SidebarMenuItem key={item.label}>
                  <SidebarMenuButton
                    asChild
                    isActive={active}
                    tooltip={item.label}
                    // AS-013 active treatment, anchord style (1:1 with shell.css .nav-item.active):
                    // a fully-rounded teal-SOFT pill filling the row — bg accent-soft, text +
                    // icon accent-ink, semibold. NO left bar (the prototype's "Dashboard" is a
                    // solid pill). With asChild these classes merge onto the NavLink <a> (which
                    // carries the testid + aria-current), so testid + active styling are one node.
                    // Geometry computed-matched to shell.css .nav-item: 33px row · 12.5px/600 ·
                    // lh 18.75px · rounded-sm (6px) · 0 9px padding · 10px gap · 17px icon. The
                    // shadcn default (h-8 text-sm p-2 gap-2 rounded-md) is overridden here.
                    className={[
                      "h-[33px] gap-[10px] rounded-sm p-0 px-[9px] text-[12.5px] font-medium leading-[18.75px] [&>svg]:size-[17px]",
                      "text-muted [&_svg]:text-subtle",
                      // Hover = .nav-item:hover (bg --elev, text --ink, icon --muted) — override the
                      // shadcn default hover:bg-sidebar-accent (accent-soft) which is the ACTIVE look.
                      // Focus-visible = teal ring.
                      // The prototype has no :active (press) rule → press stays at the hover look;
                      // neutralise the shadcn variant's active:bg-sidebar-accent (accent-soft) flash.
                      "hover:bg-elev hover:text-ink hover:[&_svg]:text-muted active:bg-elev active:text-ink focus-visible:ring-2 focus-visible:ring-accent",
                      active
                        ? "bg-accent-soft font-semibold text-accent-ink [&_svg]:text-accent-ink hover:bg-accent-soft hover:text-accent-ink hover:[&_svg]:text-accent-ink active:bg-accent-soft active:text-accent-ink data-[active=true]:bg-accent-soft data-[active=true]:font-semibold data-[active=true]:text-accent-ink"
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
                      {/* All docs carries a teal count pill (total docs), like the prototype's "8". */}
                      {item.label === "All docs" && totalDocs != null && (
                        <span
                          data-testid="sidebar-docs-count"
                          className="ml-auto inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-accent px-1 font-mono text-[10px] font-semibold tabular-nums text-on-accent group-data-[collapsible=icon]:hidden"
                        >
                          {totalDocs}
                        </span>
                      )}
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>

        {/* RECENT group — the most-recent docs (≈6), 1:1 with shell.jsx (NOT a projects list).
            Each row: a small format-icon chip + the truncated title → the doc viewer. A
            "→ View all docs" link closes the group. Hidden in the collapsed icon rail. */}
        {recentDocs.length > 0 && (
          <SidebarGroup className="px-0 py-0 mt-[14px] group-data-[collapsible=icon]:hidden" data-testid="sidebar-recent-group">
            <SidebarGroupLabel className="h-auto px-[9px] pb-[6px] font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-subtle">
              Recent
            </SidebarGroupLabel>
            <SidebarMenu aria-label="Recent docs" className="gap-px">
              {recentDocs.map((d) => (
                <SidebarMenuItem key={d.slug}>
                  <SidebarMenuButton asChild className="h-8 gap-[9px] rounded-sm p-0 px-[9px] text-[12.5px] leading-[18.75px] text-muted hover:bg-elev hover:text-ink active:bg-elev active:text-ink focus-visible:ring-2 focus-visible:ring-accent">
                    <NavLink
                      to={`/d/${d.slug}`}
                      data-testid={`sidebar-recent-${d.slug}`}
                      title={d.title}
                      className="group/doc"
                    >
                      <span className="grid size-5 flex-none place-items-center rounded-[5px] border border-line bg-elev text-subtle group-hover/doc:border-transparent group-hover/doc:bg-accent-soft group-hover/doc:text-accent-ink">
                        <Icon name={d.icon} size={12} />
                      </span>
                      <span className="truncate">{d.title}</span>
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              <SidebarMenuItem>
                <SidebarMenuButton asChild className="h-8 gap-[9px] rounded-sm p-0 px-[9px] text-[12.5px] leading-[18.75px] text-subtle hover:bg-elev hover:text-ink active:bg-elev active:text-ink focus-visible:ring-2 focus-visible:ring-accent">
                  <NavLink to={docsHref} data-testid="sidebar-view-all-docs" title="View all docs">
                    <span className="grid size-5 flex-none place-items-center">
                      <Icon name="arrowRight" size={13} />
                    </span>
                    <span>View all docs</span>
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
        <SidebarFooter className="border-t border-sidebar-border px-[10px] py-2">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={pathname.startsWith(membersHref)}
                tooltip="Members"
                className="h-[33px] gap-[10px] rounded-sm p-0 px-[9px] text-[12.5px] font-medium leading-[18.75px] [&>svg]:size-[17px] text-muted [&_svg]:text-subtle hover:bg-elev hover:text-ink hover:[&_svg]:text-muted active:bg-elev active:text-ink focus-visible:ring-2 focus-visible:ring-accent data-[active=true]:bg-accent-soft data-[active=true]:font-semibold data-[active=true]:text-accent-ink data-[active=true]:[&_svg]:text-accent-ink data-[active=true]:active:bg-accent-soft data-[active=true]:active:text-accent-ink"
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
