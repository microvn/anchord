import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useParams } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// workspaces-ui S-001 — Switch the active workspace.
//
// The typed client wrapper (features/workspaces/client) is MOCKED — no real backend. We drive
// the bootstrap + switch endpoints and assert the SWITCHER LOGIC: admin-qualified labels, the
// active mark, that selecting a workspace NAVIGATES into `/w/:id/` (re-scoping the app), and
// that a workspace id I don't belong to redirects me away (AS-003). Pixel/responsive is
// [→MANUAL]; the true browser↔backend round-trip is [→E2E].

const env = (body: unknown) => ({ data: { success: true, data: body }, error: null });

let bootstrap: unknown = env({ userId: "me", workspaces: [], activeWorkspaceId: null });
const fetchBootstrap = mock(async () => bootstrap);
const setActiveWorkspace = mock(async (_id: string) => env({ activeWorkspaceId: _id }));
const fetchMembers = mock(async () => env({ members: [], invitations: [] }));

mock.module("@/features/workspaces/client", () => ({
  fetchBootstrap,
  setActiveWorkspace,
  fetchMembers,
  createWorkspace: mock(async () => env({})),
  renameWorkspace: mock(async () => env({})),
  inviteMember: mock(async () => env({})),
  removeMember: mock(async () => env({})),
  changeMemberRole: mock(async () => env({})),
  acceptInvitation: mock(async () => env({})),
  rejectInvitation: mock(async () => env({})),
}));

const { WorkspaceSwitcher } = await import("@/features/workspaces/workspace-switcher");
const { WorkspaceRouteGuard, useActiveWorkspace } = await import(
  "@/features/workspaces/active-workspace"
);

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

// A tiny workspace home that prints the active workspace id from the route param, so a test
// can assert switching actually re-scoped the app to a different `/w/:id/`.
function WsHome() {
  const { workspaceId } = useParams();
  const active = useActiveWorkspace();
  return (
    <div>
      <div data-testid="active-ws-id">{workspaceId}</div>
      <div data-testid="active-ws-name">{active.workspace.name}</div>
      <WorkspaceSwitcher />
    </div>
  );
}

function App({ initial }: { initial: string }) {
  return (
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/w/:workspaceId" element={<WorkspaceRouteGuard />}>
            <Route index element={<WsHome />} />
          </Route>
          <Route path="*" element={<div data-testid="elsewhere">elsewhere</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const TWO_WS = env({
  userId: "me",
  activeWorkspaceId: "ws-mine",
  workspaces: [
    { id: "ws-mine", name: "default", slug: "default", role: "admin", adminName: "Me" },
    { id: "ws-lan", name: "default", slug: "default-2", role: "member", adminName: "Lan" },
  ],
});

beforeEach(() => {
  fetchBootstrap.mockClear();
  setActiveWorkspace.mockClear();
  bootstrap = TWO_WS;
});

describe("workspaces-ui S-001 — workspace switcher", () => {
  it("AS-001: the switcher lists my workspaces with the active one marked", async () => {
    render(<App initial="/w/ws-mine" />);
    // Open the switcher menu.
    await waitFor(() => expect(screen.getByTestId("ws-switcher-trigger")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("ws-switcher-trigger"));

    // Both "default"s are listed in the menu, disambiguated by their admin (mine vs Lan's).
    const activeItem = screen.getByTestId("ws-item-ws-mine");
    const otherItem = screen.getByTestId("ws-item-ws-lan");
    expect(activeItem).toHaveTextContent("My default");
    expect(otherItem).toHaveTextContent("Lan's default");

    // The active workspace (ws-mine, the route) is marked; the other is not.
    expect(activeItem).toHaveAttribute("aria-current", "true");
    expect(otherItem).not.toHaveAttribute("aria-current", "true");
  });

  it("AS-002: selecting a workspace switches the active scope (navigates to its /w/:id/ and shows its data)", async () => {
    render(<App initial="/w/ws-mine" />);
    await waitFor(() => expect(screen.getByTestId("active-ws-id")).toHaveTextContent("ws-mine"));

    await userEvent.click(screen.getByTestId("ws-switcher-trigger"));
    await userEvent.click(screen.getByTestId("ws-item-ws-lan"));

    // The app navigated into ws-lan's path — the active scope is now ws-lan, not ws-mine.
    await waitFor(() => expect(screen.getByTestId("active-ws-id")).toHaveTextContent("ws-lan"));
    // And it persisted the active-workspace choice server-side (C-005 landing default).
    expect(setActiveWorkspace).toHaveBeenCalledWith("ws-lan");
  });

  it("AS-003: a workspace id I do not belong to does not load — I'm redirected to one I do", async () => {
    render(<App initial="/w/ws-stranger" />);
    // ws-stranger is not in my list → redirect into my active/first workspace, never blank.
    await waitFor(() => expect(screen.getByTestId("active-ws-id")).toHaveTextContent("ws-mine"));
    expect(screen.queryByTestId("active-ws-id")).not.toHaveTextContent("ws-stranger");
  });

  it("C-001: the switcher shows ONLY workspaces I belong to", async () => {
    render(<App initial="/w/ws-mine" />);
    await userEvent.click(await screen.findByTestId("ws-switcher-trigger"));
    // Exactly the two I belong to — no stray third item.
    expect(screen.getAllByTestId(/^ws-item-/)).toHaveLength(2);
  });

  it("C-003: switcher controls meet the ≥40px tap-target rule (responsive/pixel visual is [→MANUAL])", async () => {
    // The LOGIC backing C-003 we unit-test: the ≥40px tap-target rule governs the MOBILE
    // drawer + the dropdown menu controls (touch surfaces). The DESKTOP inline trigger is the
    // hand-tuned 38px row from the Anchord-Design prototype (`.switcher { height: 38px }`) — its
    // own pixel match is [→MANUAL] against DESIGN.md. So we assert the touch controls (menu
    // items + new-workspace trigger) carry min-h-[40px], and the desktop trigger is h-[38px].
    render(<App initial="/w/ws-mine" />);
    const trigger = await screen.findByTestId("ws-switcher-trigger");
    expect(trigger.className).toContain("h-[38px]");
    await userEvent.click(trigger);
    for (const item of screen.getAllByTestId(/^ws-item-/)) {
      expect(item.className).toContain("min-h-[40px]");
    }
    expect(screen.getByTestId("ws-new-trigger").className).toContain("min-h-[40px]");
  });
});
