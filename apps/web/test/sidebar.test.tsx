import { describe, it, expect, mock, beforeEach } from "bun:test";
import { useState } from "react";
import { render, screen, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// web-core S-004 — the left workspace-nav sidebar (AS-012..016 + C-006).
//
// The LOGIC is unit-tested with the bootstrap/client MOCKED: structure + order (AS-012),
// active-by-route (AS-013), admin-gating of Members (AS-014 / C-006), collapse-to-rail state
// (AS-015), and the mobile off-canvas drawer toggle (AS-016). Pure pixel/responsive-visual
// (recessed-surface contrast, rail width in px, drawer animation) is [→MANUAL] against DESIGN.md.

const env = (body: unknown) => ({ data: { success: true, data: body }, error: null });

let bootstrap: unknown = env({ userId: "me", workspaces: [], activeWorkspaceId: null });
const fetchBootstrap = mock(async () => bootstrap);

mock.module("../src/features/workspaces/client", () => ({
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
mock.module("../src/lib/auth-client", () => ({
  signIn: { email: mock(async () => ({ data: null, error: null })), social: mock(async () => ({})) },
  signUp: { email: mock(async () => ({ data: { user: {} }, error: null })) },
  signOut: mock(async () => ({ data: { success: true }, error: null })),
  sendVerificationEmail: mock(async () => ({ data: {}, error: null })),
  verifyEmail: mock(async () => ({ data: {}, error: null })),
  getSession: mock(async () => ({ data: { user: { email: "a@b.co" } }, error: null })),
  useSession: () => ({ data: { user: { email: "a@b.co" } }, isPending: false }),
  authClient: {},
}));

const { AppSidebar, navDestinations } = await import("../src/app/app-sidebar");
const { WorkspaceSidebar } = await import("../src/app/workspace-sidebar");
const { AppShell } = await import("../src/app/app-shell");

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function setWidth(width: number) {
  act(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
    window.dispatchEvent(new Event("resize"));
  });
}
const ORIGINAL_WIDTH = window.innerWidth;

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
  setWidth(ORIGINAL_WIDTH);
});

// A bare presentational sidebar with all four nav destinations + an admin Members footer.
function renderSidebar(props: Partial<Parameters<typeof AppSidebar>[0]> = {}) {
  return render(
    <MemoryRouter initialEntries={["/w/ws-1"]}>
      <AppSidebar nav={navDestinations("/w/ws-1")} isAdmin {...props} />
    </MemoryRouter>,
  );
}

describe("web-core S-004 — sidebar frame + order (AS-012)", () => {
  it("AS-012: the sidebar shows brand · +New doc · switcher slot · nav (Dashboard·All docs·Projects·Activity) · Members footer, in that order", () => {
    renderSidebar({ switcherSlot: <div data-testid="the-switcher">switcher</div> });
    const sidebar = screen.getByTestId("app-sidebar");

    // The five regions exist.
    expect(within(sidebar).getByTestId("sidebar-brand")).toHaveTextContent("anchord");
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
  it("AS-013: the current section's nav item is marked active (accent-soft bg + teal left bar + accent-ink), others are not", () => {
    render(
      <MemoryRouter initialEntries={["/w/ws-1/docs"]}>
        <AppSidebar nav={navDestinations("/w/ws-1")} isAdmin />
      </MemoryRouter>,
    );
    const active = screen.getByTestId("sidebar-nav-all-docs");
    const inactive = screen.getByTestId("sidebar-nav-projects");
    expect(active.className).toContain("bg-accent-soft");
    expect(active.className).toContain("text-accent-ink");
    expect(active.className).toContain("before:bg-accent"); // the 2px teal left bar
    expect(inactive.className).not.toContain("bg-accent-soft");
    expect(active).toHaveAttribute("aria-current", "page");
  });
});

describe("web-core S-004 — Members is admin-only (AS-014, C-006)", () => {
  function renderConnected() {
    return render(
      <QueryClientProvider client={client()}>
        <MemoryRouter initialEntries={["/w/ws-1"]}>
          <WorkspaceSidebar />
        </MemoryRouter>
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
  it("AS-015: toggling the collapse chevron reduces the sidebar to an icon rail (glyphs only), and toggling again restores it", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [collapsed, setCollapsed] = useState(false);
      return (
        <MemoryRouter initialEntries={["/w/ws-1"]}>
          <AppSidebar
            nav={navDestinations("/w/ws-1")}
            isAdmin
            switcherSlot={<div data-testid="the-switcher">switcher</div>}
            collapsed={collapsed}
            onToggleCollapse={() => setCollapsed((v) => !v)}
          />
        </MemoryRouter>
      );
    }
    render(<Harness />);
    const sidebar = screen.getByTestId("app-sidebar");

    // Open: full labels + the real switcher slot are shown; not yet a rail.
    expect(sidebar).toHaveAttribute("data-collapsed", "false");
    expect(within(sidebar).getByTestId("sidebar-brand")).toBeInTheDocument();
    expect(within(sidebar).getByTestId("the-switcher")).toBeInTheDocument();
    expect(within(sidebar).getByText("New doc")).toBeInTheDocument();

    // Collapse → icon rail: brand label gone, switcher replaced by the workspace glyph,
    // `+ New doc`'s label gone (the `+` button remains).
    await user.click(within(sidebar).getByTestId("sidebar-collapse"));
    expect(sidebar).toHaveAttribute("data-collapsed", "true");
    expect(within(sidebar).queryByTestId("sidebar-brand")).not.toBeInTheDocument();
    expect(within(sidebar).queryByTestId("the-switcher")).not.toBeInTheDocument();
    expect(within(sidebar).getByTestId("sidebar-switcher-glyph")).toBeInTheDocument();
    expect(within(sidebar).queryByText("New doc")).not.toBeInTheDocument();
    expect(within(sidebar).getByTestId("sidebar-new-doc")).toBeInTheDocument(); // the `+` stays

    // Toggle again restores the full sidebar.
    await user.click(within(sidebar).getByTestId("sidebar-collapse"));
    expect(sidebar).toHaveAttribute("data-collapsed", "false");
    expect(within(sidebar).getByTestId("the-switcher")).toBeInTheDocument();
    expect(within(sidebar).getByText("New doc")).toBeInTheDocument();
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
