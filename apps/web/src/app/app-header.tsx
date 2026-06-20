import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useQuery, skipToken } from "@tanstack/react-query";
import { UserMenu } from "./user-menu";
import { useTheme } from "./theme-provider";
import { useBootstrap } from "@/features/workspaces/hooks/use-bootstrap";
import { workspaceLabel } from "@/features/workspaces/types";
import { queryKeys } from "@/features/workspaces/lib/query-keys";
import { isCompact, useBreakpoint } from "@/hooks/use-breakpoint";
import { Icon } from "@/components/icon";
import { NotificationsBell } from "@/features/notifications/components/notifications-bell";

// AppHeader (web-core S-005): the thin top bar, styled with Tailwind utilities reading the
// anchord @theme tokens (no shell.css). DESIGN.md §App shell — `surface` bg + a `line` hairline
// at the bottom (applied by AppShell's <header>); chrome recedes.
//   - LEFT: a `Workspace › Project › Doc` breadcrumb (AS-017) — last crumb emphasized (`ink`),
//     parents `muted`, separators `faint`.
//   - RIGHT (AS-018): a context-actions slot · search (⌕, `/` focuses) · theme toggle ·
//     notifications bell (placeholder — GAP-003) · the user avatar menu (▾ → settings, sign-out).
//   The workspace switcher is NEVER here — it's the sidebar's single anchor (C-005 / AS-018.T2).
//   On mobile (AS-019) search collapses to an icon and theme/notifications/sign-out fold into the
//   avatar menu, which stays visible.

export interface Crumb {
  /** Stable key + emphasis target. */
  id: string;
  label: string;
  /** When set, the crumb is a link to this route (a parent crumb). The last/active crumb omits it. */
  to?: string;
  /** True while a name is still resolving (project crumb on a cold deep-link) → show a skeleton. */
  loading?: boolean;
}

/** Capitalize the first letter of a label (workspace "default" → "Default"). */
function capitalizeFirst(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Page-segment → display label for workspace sub-routes (AS-025). A segment not listed falls back
// to its capitalized self so a new route is never blank.
const SEGMENT_LABEL: Record<string, string> = {
  docs: "All Docs",
  projects: "Projects",
  members: "Members",
  activity: "Activity",
  search: "Search",
};

// Derive the breadcrumb crumbs from the route pathname (C-008). Pure + DOM-free so it's
// unit-testable. The caller resolves the dynamic labels (workspace label, project name) and passes
// them in — this never fetches. Crumbs carry `to` for parent (link) levels; the last crumb is the
// active page (no `to`). A project crumb whose name hasn't resolved yet is marked `loading`.
//   - /settings[...]            → "Account" (static) › "Settings" [› Section]   (account branch)
//   - /w/:id                    → workspace root crumb ALONE (dashboard, AS-024)
//   - /w/:id/docs               → workspace › "All Docs"          (AS-025)
//   - /w/:id/projects           → workspace › "Projects"          (AS-025)
//   - /w/:id/projects/:pid      → workspace › [project name]      (AS-026, name from cache)
export function deriveCrumbs(
  pathname: string,
  opts: { workspaceLabel?: string; projectName?: string } = {},
): Crumb[] {
  // Account branch — settings lives outside the workspace path (AS-028).
  if (pathname === "/settings" || pathname.startsWith("/settings/")) {
    const crumbs: Crumb[] = [{ id: "account", label: "Account" }]; // static root, never a link
    const section = pathname.match(/^\/settings\/([^/]+)/)?.[1];
    // The Account section's leaf would duplicate the static "Account" root, so the section leaf is
    // appended for every section EXCEPT account → /settings and /settings/account both read
    // "Account › Settings". When the leaf is suppressed, "Settings" stays the active last crumb.
    const leaf = section && section !== "account" ? section : undefined;
    crumbs.push({ id: "settings", label: "Settings", to: leaf ? "/settings" : undefined });
    if (leaf) crumbs.push({ id: `settings-${leaf}`, label: capitalizeFirst(leaf) });
    return crumbs;
  }

  const ws = pathname.match(/^\/w\/([^/]+)/)?.[1];
  if (!ws) return [];
  const home = `/w/${ws}`;
  const rootLabel = opts.workspaceLabel ?? ws;
  const rest = pathname.slice(home.length).replace(/^\/+/, "");
  // Dashboard / workspace root — the root crumb alone, active (AS-024).
  if (!rest) return [{ id: `ws-${ws}`, label: rootLabel }];

  // Root crumb becomes a link to the workspace home (AS-027).
  const crumbs: Crumb[] = [{ id: `ws-${ws}`, label: rootLabel, to: home }];
  const seg = rest.split("/");
  if (seg[0] === "projects" && seg[1]) {
    // Project detail → workspace › [project name] (AS-026). Skeleton until the name resolves.
    crumbs.push({
      id: `project-${seg[1]}`,
      label: opts.projectName ?? "",
      loading: !opts.projectName,
    });
  } else {
    crumbs.push({ id: `page-${seg[0]}`, label: SEGMENT_LABEL[seg[0]] ?? capitalizeFirst(seg[0]) });
  }
  return crumbs;
}

function Breadcrumb({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav
      data-testid="header-breadcrumb"
      aria-label="Breadcrumb"
      className="flex min-w-0 flex-[0_1_auto] items-center gap-[7px]"
    >
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        // AS-027: last crumb = active page, emphasized (`ink`), not a link; parents are `muted` links.
        const base = `truncate text-[12.5px] ${last ? "font-semibold text-ink" : "text-muted"}`;
        return (
          <Fragment key={c.id}>
            {i > 0 && (
              <span data-testid="header-separator" aria-hidden="true" className="text-[13px] text-faint">
                ›
              </span>
            )}
            {c.loading ? (
              <span
                data-testid={`crumb-${c.id}`}
                aria-label="Loading"
                className="inline-block h-[12px] w-16 animate-pulse rounded bg-elev align-middle"
              />
            ) : c.to && !last ? (
              <Link
                to={c.to}
                data-testid={`crumb-${c.id}`}
                className={`${base} cursor-pointer transition-colors hover:text-ink`}
              >
                {c.label}
              </Link>
            ) : (
              <span
                data-testid={`crumb-${c.id}`}
                className={`${base} cursor-default`}
                aria-current={last ? "page" : undefined}
              >
                {c.label}
              </span>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}

// Chrome icon-button — a ~28px hairline-quiet control (theme toggle / bell / drawer trigger).
const ICON_BTN =
  "inline-flex size-7 flex-none items-center justify-center rounded-md border border-transparent bg-transparent text-muted transition-colors hover:bg-elev hover:text-ink disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted";
// A menu row inside a DropdownMenu (folded utilities + settings/sign-out). Exported so the
// UserMenu's Settings/Sign-out rows share the exact anchord row styling.
export const MENU_ITEM =
  "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-[7px] text-left text-[12.5px] text-ink outline-none transition-colors hover:bg-surface focus:bg-surface data-[highlighted]:bg-surface [&>svg]:flex-none [&>svg]:text-subtle";

// The search affordance — an expanded input on desktop (`/` focuses it, AS-018.T1) or a collapsed
// icon button on mobile (AS-019). The `/` shortcut is wired only when the input is present.
function HeaderSearch({ compact, workspaceId }: { compact: boolean; workspaceId?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const [value, setValue] = useState("");

  useEffect(() => {
    if (compact) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      const el = e.target as HTMLElement | null;
      // Don't hijack `/` while the user is typing in another field.
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [compact]);

  // S-005: submitting the search navigates to the workspace search results route. With no
  // active workspace (e.g. pre-resolve) the input is inert rather than navigating nowhere.
  function submit() {
    const q = value.trim();
    if (!q || !workspaceId) return;
    navigate(`/w/${workspaceId}/search?q=${encodeURIComponent(q)}`);
  }

  if (compact) {
    return (
      <button
        type="button"
        data-testid="header-search-icon"
        aria-label="Search"
        className={ICON_BTN}
        onClick={() => workspaceId && navigate(`/w/${workspaceId}/search`)}
      >
        <Icon name="search" size={16} />
      </button>
    );
  }

  return (
    <label
      data-testid="header-search"
      className="flex h-[30px] w-[210px] cursor-text items-center gap-2 rounded-md border border-transparent bg-elev px-[9px] text-subtle transition-colors hover:border-line focus-within:border-line"
    >
      <Icon name="search" size={15} />
      <input
        ref={inputRef}
        data-testid="header-search-input"
        type="search"
        aria-label="Search"
        placeholder="Search docs…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        className="min-w-0 flex-1 border-none bg-transparent text-[12.5px] text-ink outline-none placeholder:text-subtle"
      />
      <span className="rounded border border-line bg-surface px-[5px] py-px font-mono text-[10px] text-subtle">/</span>
    </label>
  );
}

function ThemeToggle({ testid, inMenu }: { testid: string; inMenu?: boolean }) {
  const { theme, toggleTheme } = useTheme();
  return (
    <button
      type="button"
      data-testid={testid}
      aria-label="Toggle theme"
      onClick={toggleTheme}
      className={inMenu ? MENU_ITEM : ICON_BTN}
    >
      <Icon name={theme === "dark" ? "sun" : "moon"} size={16} />
      {inMenu && <span>{theme === "dark" ? "Light theme" : "Dark theme"}</span>}
    </button>
  );
}

// notifications-email S-006: the real bell — unread badge (polled) + dropdown panel — now lives in
// `@/features/notifications/components/notifications-bell` (imported above), replacing the former
// inert GAP-003 placeholder. The header just slots it in (desktop) / folds it into the avatar menu
// (mobile), exactly where the placeholder sat.

// `contextActions` is the per-screen slot (e.g. a teal Share on a doc screen). Feature screens
// fill it; web-core renders it empty.
export function AppHeader({ contextActions }: { contextActions?: ReactNode }) {
  const { pathname } = useLocation();
  const query = useBootstrap();
  const tier = useBreakpoint();
  const compact = isCompact(tier);

  const workspaceId = pathname.match(/^\/w\/([^/]+)/)?.[1] ?? query.data?.activeWorkspaceId ?? undefined;
  const ws = query.data?.workspaces.find((w) => w.id === workspaceId);
  // AS-017: the same label the switcher shows — title-cased workspace name, with the owner's
  // auto-created "default" workspace reading "My Default" (workspaceLabel owns that rule).
  const wsLabel = ws ? workspaceLabel(ws) : undefined;
  // AS-026: on a project route, resolve the project's real name from the per-project browse cache
  // the ProjectDocsScreen populates. enabled:false → the header NEVER fetches; it reads the cache
  // reactively (skeleton until the screen fills it). No new request is issued from the header.
  const projectId = pathname.match(/^\/w\/[^/]+\/projects\/([^/]+)/)?.[1];
  const projectCache = useQuery<{ project?: { name?: string } } | undefined>({
    queryKey: workspaceId && projectId
      ? [...queryKeys.docs(workspaceId), "project", projectId]
      : ["noop-project-crumb"],
    // skipToken = never fetch from the header; read the cache the screen populates (reactively).
    queryFn: skipToken,
  });
  const projectName = projectId ? projectCache.data?.project?.name : undefined;
  const crumbs = deriveCrumbs(pathname, { workspaceLabel: wsLabel, projectName });

  // On mobile the theme toggle + notifications fold into the avatar menu (AS-019).
  const folded = compact ? (
    <>
      <ThemeToggle testid="menu-theme-toggle" inMenu />
      <NotificationsBell testid="menu-notifications" inMenu />
    </>
  ) : undefined;

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {/* LEFT: breadcrumb (AS-017). */}
      <div className="min-w-0 flex-1">
        <Breadcrumb crumbs={crumbs} />
      </div>

      {/* RIGHT: account + utilities cluster (AS-018). The switcher is intentionally absent (C-005). */}
      <div data-testid="header-right" className="ml-auto flex items-center gap-1">
        <div data-testid="header-context-actions" className="flex items-center gap-2">
          {contextActions}
        </div>
        <HeaderSearch compact={compact} workspaceId={workspaceId} />
        {/* Inline theme + notifications on desktop; folded into the avatar menu on mobile. */}
        {!compact && <div className="mx-1 h-[18px] w-px flex-none bg-line" />}
        {!compact && <ThemeToggle testid="header-theme-toggle" />}
        {!compact && <NotificationsBell testid="header-notifications" />}
        <div className="mx-1 h-[18px] w-px flex-none bg-line" />
        <UserMenu foldedItems={folded} />
      </div>
    </div>
  );
}
