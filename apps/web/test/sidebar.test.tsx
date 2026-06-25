import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { ReactNode } from "react";
import { render, screen, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { SidebarProvider } from "@/components/ui/sidebar";

// web-core S-004 — the left workspace-nav sidebar (AS-012..016 + C-006).
//
// The LOGIC is unit-tested with the bootstrap/client MOCKED: structure + order (AS-012),
// active-by-route (AS-013), admin-gating of Members (AS-014 / C-006), collapse-to-rail state
// (AS-015), and the mobile off-canvas drawer toggle (AS-016). Pure pixel/responsive-visual
// (recessed-surface contrast, rail width in px, drawer animation) is [→MANUAL] against DESIGN.md.

const env = (body: unknown) => ({ data: { success: true, data: body }, error: null });

let bootstrap: unknown = env({ userId: "me", workspaces: [], activeWorkspaceId: null });
const fetchBootstrap = mock(async () => bootstrap);

mock.module("@/features/workspaces/services/client", () => ({
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

// Mock the auth client so AppShell's UserMenu (header account) renders without a backend. bun's
// mock.module registry is process-global, so this mock must export the FULL auth-client surface
// other test files import (signIn/signUp/verify…), not just signOut — a partial mock would make
// their imports throw "Export named … not found".
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

const { AppSidebar, navDestinations } = await import("@/app/app-sidebar");
const { WorkspaceSidebar } = await import("@/app/workspace-sidebar");
const { AppShell } = await import("@/app/app-shell");

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function setWidth(width: number) {
  act(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
    window.dispatchEvent(new Event("resize"));
  });
}
// Pin a DESKTOP width: the shadcn Sidebar primitive only renders its inline rail when the
// viewport is non-compact (useIsMobile → isCompact(useBreakpoint)); at compact it becomes a
// Sheet that mounts content only when open. The structural AS-012/013/014 assertions need the
// inline rail in the DOM, so render at desktop.
const DESKTOP_WIDTH = 1440;

// The primitive components (Sidebar / SidebarTrigger / SidebarMenuButton) read SidebarProvider
// context, so the presentational AppSidebar must mount inside a provider — it's part of the new
// shell DOM contract (the real shell wraps it the same way).
function withProvider(node: ReactNode) {
  return <SidebarProvider>{node}</SidebarProvider>;
}

const ADMIN_WS = env({
  userId: "me",
  activeWorkspaceId: "ws-1",
  workspaces: [{ id: "ws-1", name: "default", slug: "default", role: "admin", adminName: "Me" }],
});
const MEMBER_WS = env({
  userId: "me",
  activeWorkspaceId: "ws-1",
  workspaces: [{ id: "ws-1", name: "default", slug: "default", role: "member", adminName: "Lan" }],
});

beforeEach(() => {
  fetchBootstrap.mockClear();
  bootstrap = ADMIN_WS;
  setWidth(DESKTOP_WIDTH);
});

// A bare presentational sidebar with all four nav destinations + an admin Members footer.
function renderSidebar(props: Partial<Parameters<typeof AppSidebar>[0]> = {}) {
  return render(
    withProvider(
      <MemoryRouter initialEntries={["/w/ws-1"]}>
        <AppSidebar nav={navDestinations("/w/ws-1")} isAdmin {...props} />
      </MemoryRouter>,
    ),
  );
}

describe("web-core S-004 — sidebar frame + order (AS-012)", () => {
  it("AS-012: the sidebar shows brand · +New doc · switcher slot · nav (Dashboard·All docs·Projects·Activity) · Members footer, in that order", () => {
    renderSidebar({ switcherSlot: <div data-testid="the-switcher">switcher</div> });
    const sidebar = screen.getByTestId("app-sidebar");

    // The five regions exist.
    expect(within(sidebar).getByTestId("sidebar-brand")).toHaveTextContent("Anchord");
    expect(within(sidebar).getByTestId("sidebar-new-doc")).toHaveTextContent("New doc");
    expect(within(sidebar).getByTestId("the-switcher")).toBeInTheDocument();
    const nav = within(sidebar).getByTestId("sidebar-nav");
    expect(within(nav).getByTestId("sidebar-nav-dashboard")).toBeInTheDocument();
    expect(within(nav).getByTestId("sidebar-nav-all-docs")).toBeInTheDocument();
    expect(within(nav).getByTestId("sidebar-nav-projects")).toBeInTheDocument();
    expect(within(nav).getByTestId("sidebar-nav-activity")).toBeInTheDocument();
    expect(within(sidebar).getByTestId("sidebar-members")).toBeInTheDocument();

    // Document order: brand → new-doc → switcher → nav → members (DESIGN.md top-to-bottom).
    const order = ["sidebar-brand", "sidebar-new-doc", "the-switcher", "sidebar-nav", "sidebar-members"].map(
      (id) => within(sidebar).getByTestId(id),
    );
    for (let i = 1; i < order.length; i++) {
      // node[i-1] precedes node[i] in DOM order.
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("AS-012: the sidebar sits on a recessed (lower-contrast `sunken`) surface vs content", () => {
    renderSidebar();
    // `sunken` is below `paper`/`surface` in the @theme scale — the chrome-recedes contract.
    expect(screen.getByTestId("app-sidebar").className).toContain("bg-sunken");
  });
});

describe("web-core S-004 — active nav item by route (AS-013)", () => {
  it("AS-013: the current section's nav item is marked active (a full teal-soft pill — accent-soft bg + accent-ink text + semibold), others are not", () => {
    render(
      withProvider(
        <MemoryRouter initialEntries={["/w/ws-1/docs"]}>
          <AppSidebar nav={navDestinations("/w/ws-1")} isAdmin />
        </MemoryRouter>,
      ),
    );
    const active = screen.getByTestId("sidebar-nav-all-docs");
    const inactive = screen.getByTestId("sidebar-nav-projects");
    // The prototype's active look is a fully-rounded teal-soft pill filling the row (NO left bar).
    expect(active.className).toContain("bg-accent-soft");
    expect(active.className).toContain("text-accent-ink");
    expect(active.className).toContain("font-semibold");
    expect(active.className).not.toContain("before:bg-accent"); // no left bar — solid pill
    expect(inactive.className).not.toContain("bg-accent-soft");
    expect(active).toHaveAttribute("aria-current", "page");
  });
});

describe("web-core S-004 — Members is admin-only (AS-014, C-006)", () => {
  function renderConnected() {
    return render(
      <QueryClientProvider client={client()}>
        <SidebarProvider>
          <MemoryRouter initialEntries={["/w/ws-1"]}>
            <WorkspaceSidebar />
          </MemoryRouter>
        </SidebarProvider>
      </QueryClientProvider>,
    );
  }

  it("AS-014: a workspace admin sees the Members entry", async () => {
    bootstrap = ADMIN_WS;
    renderConnected();
    expect(await screen.findByTestId("sidebar-members")).toBeInTheDocument();
  });

  it("C-006: a non-admin member does NOT see the Members entry", async () => {
    bootstrap = MEMBER_WS;
    renderConnected();
    // Wait for the bootstrap to resolve, then assert Members never appears (member-gated out).
    expect(await screen.findByTestId("sidebar-nav-dashboard")).toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-members")).not.toBeInTheDocument();
  });
});

describe("web-core S-004 — collapse to icon rail (AS-015)", () => {
  it("AS-015: the collapse trigger flips the sidebar to its icon-rail state and back", async () => {
    const user = userEvent.setup();
    // The shadcn Sidebar primitive owns collapse↔rail: the SidebarProvider tracks open/closed
    // and the Sidebar element exposes data-state expanded/collapsed (+ data-collapsible=icon).
    // Behaviour (the state flips on the trigger), not CSS-hidden visibility (happy-dom can't see
    // layout), is what we assert — per AS-015 the collapsed sidebar is the glyph-only rail.
    render(
      withProvider(
        <MemoryRouter initialEntries={["/w/ws-1"]}>
          <AppSidebar
            nav={navDestinations("/w/ws-1")}
            isAdmin
            switcherSlot={<div data-testid="the-switcher">switcher</div>}
          />
        </MemoryRouter>,
      ),
    );
    // The state-bearing sidebar shell element (the primitive's `group/peer` wrapper).
    const stateEl = document.querySelector('[data-slot="sidebar"][data-state]') as HTMLElement;
    expect(stateEl).toBeTruthy();

    // Expanded by default; the collapse trigger is present and the brand/new-doc/switcher render.
    expect(stateEl).toHaveAttribute("data-state", "expanded");
    expect(screen.getByTestId("sidebar-brand")).toBeInTheDocument();
    expect(screen.getByTestId("the-switcher")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-new-doc")).toBeInTheDocument();

    // Collapse → the icon rail (data-state=collapsed, data-collapsible=icon).
    await user.click(screen.getByTestId("sidebar-collapse"));
    expect(stateEl).toHaveAttribute("data-state", "collapsed");
    expect(stateEl).toHaveAttribute("data-collapsible", "icon");
    // The `+ New doc` control still exists (collapses to a `+` glyph, not removed).
    expect(screen.getByTestId("sidebar-new-doc")).toBeInTheDocument();

    // Toggle again restores the expanded sidebar.
    await user.click(screen.getByTestId("sidebar-collapse"));
    expect(stateEl).toHaveAttribute("data-state", "expanded");
  });
});

describe("web-core S-004 — mobile off-canvas drawer (AS-016)", () => {
  it("AS-016: at mobile width the sidebar becomes an off-canvas drawer opened from the header, with the switcher at the drawer top, tap targets ≥40px", async () => {
    const user = userEvent.setup();
    setWidth(360);
    render(
      <QueryClientProvider client={client()}>
        <MemoryRouter initialEntries={["/w/ws-1"]}>
          <AppShell sidebarSlot={<WorkspaceSidebar />} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // At mobile there is no persistent inline sidebar; the header carries the drawer toggle.
    expect(screen.queryByTestId("side-region")).not.toBeInTheDocument();
    const toggle = screen.getByTestId("drawer-toggle");
    expect(toggle.className).toContain("min-h-[40px]");
    expect(toggle.className).toContain("min-w-[40px]");

    // Closed until opened from the header.
    expect(screen.queryByTestId("side-drawer")).not.toBeInTheDocument();
    await user.click(toggle);

    const drawer = screen.getByTestId("side-drawer");
    expect(drawer).toBeInTheDocument();
    // The switcher sits at the top of the drawer (AS-016): the switcher's slot precedes the nav.
    const slot = within(drawer).getByTestId("sidebar-switcher-slot");
    const nav = within(drawer).getByTestId("sidebar-nav");
    expect(slot.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
