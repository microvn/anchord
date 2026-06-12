import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { UserMenu } from "./user-menu";
import { useTheme } from "./theme-provider";
import { useBootstrap } from "@/features/workspaces/use-bootstrap";
import { isCompact, useBreakpoint } from "@/lib/use-breakpoint";
import { Icon } from "@/components/icon";

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
    <nav
      data-testid="header-breadcrumb"
      aria-label="Breadcrumb"
      className="flex min-w-0 flex-[0_1_auto] items-center gap-[7px]"
    >
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <Fragment key={c.id}>
            {i > 0 && (
              <span data-testid="header-separator" aria-hidden="true" className="text-[13px] text-faint">
                ›
              </span>
            )}
            <span
              data-testid={`crumb-${c.id}`}
              // AS-017: last crumb emphasized (`ink`, semibold); parents `muted`.
              className={`cursor-default truncate text-[12.5px] ${last ? "font-semibold text-ink" : "text-muted"}`}
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

// GAP-003: no backend notifications-count endpoint exists yet. The bell keeps the prototype's
// shape (an active hairline icon-button, NOT dimmed) but is INERT — no unread count is faked,
// so it shows no badge. When a notifications slice ships it gets the real count + a teal pill.
function NotificationsBell({ testid, inMenu }: { testid: string; inMenu?: boolean }) {
  return (
    <button
      type="button"
      data-testid={testid}
      aria-label="Notifications"
      className={`relative ${inMenu ? MENU_ITEM : ICON_BTN}`}
    >
      <Icon name="bell" size={16} />
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
