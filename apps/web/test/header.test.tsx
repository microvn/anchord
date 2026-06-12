import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// web-core S-005 — the app HEADER: breadcrumb (LEFT) + account/utilities cluster (RIGHT).
//
// LOGIC is unit-tested with the bootstrap/auth-client MOCKED: the breadcrumb crumbs + order +
// emphasis (AS-017), the header-right cluster — context-actions slot · search · theme toggle ·
// notifications bell placeholder · avatar menu with settings + sign-out (AS-018.T1), the switcher
// being ABSENT from the header (AS-018.T2 / C-005), the mobile fold (AS-019), and the C-005
// two-way no-duplication (switcher only in sidebar; account only in header). Pure pixel/visual
// (hairline thickness, breadcrumb color tokens beyond class presence) is [→MANUAL] per DESIGN.md.

const env = (body: unknown) => ({ data: { success: true, data: body }, error: null });

let bootstrap: unknown = env({ userId: "me", workspaces: [], activeWorkspaceId: null });
const fetchBootstrap = mock(async () => bootstrap);

mock.module("@/features/workspaces/client", () => ({
  fetchBootstrap,
  setActiveWorkspace: mock(async (id: string) => env({ activeWorkspaceId: id })),
  fetchMembers: mock(async () => env({ members: [], invitations: [] })),
  createWorkspace: mock(async () => env({})),
  renameWorkspace: mock(async () => env({})),
  inviteMember: mock(async () => env({})),
  removeMember: mock(async () => env({})),
  changeMemberRole: mock(async () => env({})),
  acceptInvitation: mock(async () => env({})),
  rejectInvitation: mock(async () => env({})),
}));

// bun's mock.module registry is process-global, so this mock MUST export the FULL auth-client
// surface other test files import (signIn/signUp/verify…), not just signOut — a partial mock
// would make their imports throw "Export named … not found".
mock.module("@/lib/api/auth-client", () => ({
  signIn: { email: mock(async () => ({ data: null, error: null })), social: mock(async () => ({})) },
  signUp: { email: mock(async () => ({ data: { user: {} }, error: null })) },
  signOut: mock(async () => ({ data: { success: true }, error: null })),
  sendVerificationEmail: mock(async () => ({ data: {}, error: null })),
  verifyEmail: mock(async () => ({ data: {}, error: null })),
  getSession: mock(async () => ({ data: { user: { email: "a@b.co" } }, error: null })),
  useSession: () => ({ data: { user: { email: "a@b.co" } }, isPending: false }),
  authClient: {},
}));

const { AppHeader } = await import("@/app/app-header");
const { AppShell } = await import("@/app/app-shell");
const { WorkspaceSidebar } = await import("@/app/workspace-sidebar");
const { AppSidebar } = await import("@/app/app-sidebar");
const { ThemeProvider } = await import("@/app/theme-provider");
const { SidebarProvider } = await import("@/components/ui/sidebar");

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function setWidth(width: number) {
  act(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
    window.dispatchEvent(new Event("resize"));
  });
}
// Pin an explicit DESKTOP width per-test rather than capturing window.innerWidth at import time:
// bun's process-global module/DOM state means a sibling test file may have left the window at a
// mobile width before this module loads, so a captured "original" can't be trusted.
const DESKTOP_WIDTH = 1440;

const WS = env({
  userId: "me",
  activeWorkspaceId: "ws-1",
  workspaces: [{ id: "ws-1", name: "Acme", slug: "acme", role: "admin", adminName: "Me" }],
});

beforeEach(() => {
  fetchBootstrap.mockClear();
  bootstrap = WS;
  setWidth(DESKTOP_WIDTH);
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

// Render the CONNECTED header (binds the breadcrumb to the bootstrap + route) at a route.
function renderHeader(path: string) {
  return render(
    <ThemeProvider>
      <QueryClientProvider client={client()}>
        <MemoryRouter initialEntries={[path]}>
          <AppHeader />
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("web-core S-005 — header breadcrumb (AS-017)", () => {
  it("AS-017: the header shows a `Workspace › Project › Doc` breadcrumb in order, last crumb emphasized (ink), parents muted, separator faint", async () => {
    const bc = within(await renderAndFindBreadcrumb("/w/ws-1/projects/proj-7/docs/doc-9"));
    const crumbs = bc.getAllByTestId(/^crumb-/);
    // Three crumbs in order: workspace name (from bootstrap) › project › doc.
    expect(crumbs).toHaveLength(3);
    expect(crumbs[0]).toHaveTextContent("Acme");
    expect(crumbs[1]).toHaveTextContent("proj-7");
    expect(crumbs[2]).toHaveTextContent("doc-9");

    // Last crumb emphasized = ink; parents = muted.
    expect(crumbs[2].className).toContain("text-ink");
    expect(crumbs[0].className).toContain("text-muted");
    expect(crumbs[1].className).toContain("text-muted");

    // Separators are faint.
    const sep = bc.getAllByTestId("header-separator")[0];
    expect(sep.className).toContain("text-faint");
  });

  it("AS-017: on a workspace-root screen only the workspace crumb shows (no invented project/doc crumbs)", async () => {
    const bc = within(await renderAndFindBreadcrumb("/w/ws-1"));
    const crumbs = bc.getAllByTestId(/^crumb-/);
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]).toHaveTextContent("Acme");
    // The single (last) crumb is emphasized.
    expect(crumbs[0].className).toContain("text-ink");
  });
});

async function renderAndFindBreadcrumb(path: string) {
  renderHeader(path);
  return await screen.findByTestId("header-breadcrumb");
}

describe("web-core S-005 — header right cluster (AS-018.T1)", () => {
  it("AS-018.T1: the header right shows context-actions slot · search · theme toggle · notifications bell · avatar menu", async () => {
    renderHeader("/w/ws-1");
    await screen.findByTestId("header-breadcrumb");
    const right = screen.getByTestId("header-right");
    expect(within(right).getByTestId("header-context-actions")).toBeInTheDocument();
    expect(within(right).getByTestId("header-search")).toBeInTheDocument();
    expect(within(right).getByTestId("header-theme-toggle")).toBeInTheDocument();
    expect(within(right).getByTestId("header-notifications")).toBeInTheDocument();
    expect(within(right).getByTestId("user-menu-trigger")).toBeInTheDocument();
  });

  it("AS-018.T1: pressing `/` focuses the search input", async () => {
    const user = userEvent.setup();
    renderHeader("/w/ws-1");
    await screen.findByTestId("header-breadcrumb");
    const search = screen.getByTestId("header-search-input") as HTMLInputElement;
    expect(search).not.toHaveFocus();
    await user.keyboard("/");
    expect(search).toHaveFocus();
  });

  it("AS-018.T1: opening the avatar menu reveals Settings and Sign out", async () => {
    const user = userEvent.setup();
    renderHeader("/w/ws-1");
    await screen.findByTestId("header-breadcrumb");
    await user.click(screen.getByTestId("user-menu-trigger"));
    const menu = screen.getByTestId("user-menu");
    expect(within(menu).getByText("Settings")).toBeInTheDocument();
    expect(within(menu).getByText("Sign out")).toBeInTheDocument();
  });

  it("AS-018.T1: the notifications bell is an inert placeholder with no unread badge (GAP-003)", async () => {
    renderHeader("/w/ws-1");
    await screen.findByTestId("header-breadcrumb");
    const bell = screen.getByTestId("header-notifications");
    // GAP-003: no backend count endpoint yet → no badge element rendered.
    expect(within(bell).queryByTestId("notifications-badge")).not.toBeInTheDocument();
  });
});

describe("web-core S-005 — switcher is NOT in the header (AS-018.T2 / C-005)", () => {
  it("AS-018.T2: the workspace switcher does NOT appear in the header (it lives in the sidebar)", async () => {
    renderHeader("/w/ws-1");
    await screen.findByTestId("header-breadcrumb");
    // C-005: the single switcher anchor is the sidebar — never duplicated into the header.
    expect(screen.queryByTestId("ws-switcher-trigger")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-switcher-slot")).not.toBeInTheDocument();
  });
});

describe("web-core S-005 — mobile fold (AS-019)", () => {
  it("AS-019: at mobile width search collapses to an icon and theme/notifications/sign-out fold into the avatar menu (which stays visible)", async () => {
    const user = userEvent.setup();
    setWidth(360);
    renderHeader("/w/ws-1");
    await screen.findByTestId("header-breadcrumb");

    // Search is an icon button at mobile, not the expanded input.
    expect(screen.getByTestId("header-search-icon")).toBeInTheDocument();
    expect(screen.queryByTestId("header-search-input")).not.toBeInTheDocument();

    // The standalone theme toggle + notifications are NOT shown inline at mobile…
    expect(screen.queryByTestId("header-theme-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("header-notifications")).not.toBeInTheDocument();

    // …the avatar menu stays visible and holds the folded items.
    const trigger = screen.getByTestId("user-menu-trigger");
    expect(trigger).toBeInTheDocument();
    expect(trigger.className).toContain("min-h-[40px]"); // ≥40px tap target
    await user.click(trigger);
    const menu = screen.getByTestId("user-menu");
    expect(within(menu).getByTestId("menu-theme-toggle")).toBeInTheDocument();
    expect(within(menu).getByTestId("menu-notifications")).toBeInTheDocument();
    expect(within(menu).getByText("Sign out")).toBeInTheDocument();
  });
});

describe("web-core S-005 — C-005 no duplication (both directions)", () => {
  it("C-005: the switcher is not rendered in the header (header owns the account, not the switcher)", async () => {
    renderHeader("/w/ws-1");
    await screen.findByTestId("header-breadcrumb");
    expect(screen.queryByTestId("ws-switcher-trigger")).not.toBeInTheDocument();
    // The account avatar/menu IS in the header.
    expect(screen.getByTestId("user-menu-trigger")).toBeInTheDocument();
  });

  it("C-005: the account (avatar menu / sign-out) is NOT rendered in the sidebar (sidebar owns the switcher)", () => {
    render(
      <ThemeProvider>
        <QueryClientProvider client={client()}>
          <SidebarProvider>
            <MemoryRouter initialEntries={["/w/ws-1"]}>
              <AppSidebar switcherSlot={<div data-testid="ws-switcher-trigger">switcher</div>} isAdmin />
            </MemoryRouter>
          </SidebarProvider>
        </QueryClientProvider>
      </ThemeProvider>,
    );
    const sidebar = screen.getByTestId("app-sidebar");
    // The sidebar owns the switcher…
    expect(within(sidebar).getByTestId("ws-switcher-trigger")).toBeInTheDocument();
    // …but never the account avatar menu or a sign-out control (those are the header's).
    expect(within(sidebar).queryByTestId("user-menu-trigger")).not.toBeInTheDocument();
    expect(within(sidebar).queryByText("Sign out")).not.toBeInTheDocument();
  });
});

describe("web-core S-005 — theme toggle flips dark/light", () => {
  it("AS-018.T1: clicking the theme toggle flips the root theme marker", async () => {
    const user = userEvent.setup();
    renderHeader("/w/ws-1");
    await screen.findByTestId("header-breadcrumb");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    await user.click(screen.getByTestId("header-theme-toggle"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    await user.click(screen.getByTestId("header-theme-toggle"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
