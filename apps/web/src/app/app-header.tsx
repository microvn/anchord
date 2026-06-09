import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { UserMenu } from "./user-menu";
import { useTheme } from "./theme-provider";
import { useBootstrap } from "../features/workspaces/use-bootstrap";
import { isCompact, useBreakpoint } from "../lib/use-breakpoint";

// AppHeader (web-core S-005): the thin top bar. DESIGN.md §App shell — `surface` bg + a `line`
// hairline at the bottom; chrome recedes.
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
}

// Derive the breadcrumb crumbs from the route pathname + the active workspace name. Pure +
// DOM-free so it's unit-testable. Doc/project NAMES aren't loadable in web-core (those screens
// live in workspace-project-ui) → fall back to the route id/slug as the crumb label; do NOT
// invent a fetch (dispatch note). Only the levels present in the route are shown.
export function deriveCrumbs(pathname: string, workspaceName: string | undefined): Crumb[] {
  const crumbs: Crumb[] = [];
  const ws = pathname.match(/^\/w\/([^/]+)/)?.[1];
  if (!ws) return crumbs;
  crumbs.push({ id: `ws-${ws}`, label: workspaceName ?? ws });

  const project = pathname.match(/\/projects\/([^/]+)/)?.[1];
  if (project) crumbs.push({ id: `project-${project}`, label: project });

  const doc = pathname.match(/\/docs\/([^/]+)/)?.[1];
  // `/docs` (the All-docs list) carries no id segment → no doc crumb; only a concrete doc id does.
  if (doc && doc !== "new") crumbs.push({ id: `doc-${doc}`, label: doc });

  return crumbs;
}

function Breadcrumb({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav data-testid="header-breadcrumb" aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <Fragment key={c.id}>
            {i > 0 && (
              <span data-testid="header-separator" aria-hidden="true" className="text-faint">
                ›
              </span>
            )}
            <span
              data-testid={`crumb-${c.id}`}
              // AS-017: last crumb emphasized (`ink`); parents `muted`.
              className={`truncate text-sm ${last ? "font-medium text-ink" : "text-muted"}`}
              aria-current={last ? "page" : undefined}
            >
              {c.label}
            </span>
          </Fragment>
        );
      })}
    </nav>
  );
}

// The search affordance — an expanded input on desktop (`/` focuses it, AS-018.T1) or a collapsed
// icon button on mobile (AS-019). The `/` shortcut is wired only when the input is present.
function HeaderSearch({ compact }: { compact: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);

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

  if (compact) {
    return (
      <button
        type="button"
        data-testid="header-search-icon"
        aria-label="Search"
        className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-md border border-line bg-surface text-muted hover:border-accent hover:text-ink"
      >
        <span aria-hidden="true">⌕</span>
      </button>
    );
  }

  return (
    <div data-testid="header-search" className="relative flex items-center">
      <span aria-hidden="true" className="pointer-events-none absolute left-2 text-faint">
        ⌕
      </span>
      <input
        ref={inputRef}
        data-testid="header-search-input"
        type="search"
        aria-label="Search"
        placeholder="Search  /"
        className="min-h-[36px] w-56 rounded-md border border-line bg-sunken pl-7 pr-3 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none"
      />
    </div>
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
      className={
        inMenu
          ? "flex min-h-[40px] w-full items-center gap-2 rounded-sm px-3 text-left text-sm text-ink hover:bg-accent-soft"
          : "flex min-h-[40px] min-w-[40px] items-center justify-center rounded-md border border-line bg-surface text-muted hover:border-accent hover:text-ink"
      }
    >
      <span aria-hidden="true">◐</span>
      {inMenu && <span>Theme: {theme === "dark" ? "Dark" : "Light"}</span>}
    </button>
  );
}

// GAP-003: no backend notifications-count endpoint exists yet → an INERT placeholder bell with
// NO unread badge. When a notifications slice ships it gets the count + badge.
function NotificationsBell({ testid, inMenu }: { testid: string; inMenu?: boolean }) {
  return (
    <button
      type="button"
      data-testid={testid}
      aria-label="Notifications"
      disabled
      className={
        inMenu
          ? "flex min-h-[40px] w-full items-center gap-2 rounded-sm px-3 text-left text-sm text-muted"
          : "flex min-h-[40px] min-w-[40px] items-center justify-center rounded-md border border-line bg-surface text-muted"
      }
    >
      <span aria-hidden="true">🔔</span>
      {inMenu && <span>Notifications</span>}
    </button>
  );
}

// `contextActions` is the per-screen slot (e.g. a teal Share on a doc screen). Feature screens
// fill it; web-core renders it empty.
export function AppHeader({ contextActions }: { contextActions?: ReactNode }) {
  const { pathname } = useLocation();
  const query = useBootstrap();
  const tier = useBreakpoint();
  const compact = isCompact(tier);

  const workspaceId = pathname.match(/^\/w\/([^/]+)/)?.[1] ?? query.data?.activeWorkspaceId ?? undefined;
  const workspaceName = query.data?.workspaces.find((w) => w.id === workspaceId)?.name;
  const crumbs = deriveCrumbs(pathname, workspaceName);

  // On mobile the theme toggle + notifications fold into the avatar menu (AS-019).
  const folded = compact ? (
    <>
      <ThemeToggle testid="menu-theme-toggle" inMenu />
      <NotificationsBell testid="menu-notifications" inMenu />
    </>
  ) : undefined;

  return (
    <div className="flex min-w-0 items-center gap-3">
      {/* LEFT: breadcrumb (AS-017). */}
      <div className="min-w-0 flex-1">
        <Breadcrumb crumbs={crumbs} />
      </div>

      {/* RIGHT: account + utilities cluster (AS-018). The switcher is intentionally absent (C-005). */}
      <div data-testid="header-right" className="flex shrink-0 items-center gap-2">
        <div data-testid="header-context-actions" className="flex items-center gap-2">
          {contextActions}
        </div>
        <HeaderSearch compact={compact} />
        {/* Inline theme + notifications on desktop; folded into the avatar menu on mobile. */}
        {!compact && <ThemeToggle testid="header-theme-toggle" />}
        {!compact && <NotificationsBell testid="header-notifications" />}
        <UserMenu foldedItems={folded} />
      </div>
    </div>
  );
}
