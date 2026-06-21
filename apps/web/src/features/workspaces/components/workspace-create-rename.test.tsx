import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useParams } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// workspaces-ui S-002 — Create and rename a workspace. Client wrapper MOCKED.
// AS-004 create→switch as admin; AS-005 rename updates switcher + top bar; AS-006 non-admin
// sees no rename control. Pixel/responsive [→MANUAL]; real round-trip [→E2E].

const env = (body: unknown) => ({ data: { success: true, data: body }, error: null });

let bootstrap: unknown;
const fetchBootstrap = mock(async () => bootstrap);
const setActiveWorkspace = mock(async (id: string) => env({ activeWorkspaceId: id }));
const createWorkspace = mock(async (_name: string) => env({ id: "ws-new", name: _name }));
const renameWorkspace = mock(async (_id: string, name: string) => env({ id: _id, name }));

mock.module("@/features/workspaces/services/client", () => ({
  fetchBootstrap,
  setActiveWorkspace,
  createWorkspace,
  renameWorkspace,
  fetchMembers: mock(async () => env({ members: [], invitations: [] })),
  inviteMember: mock(async () => env({})),
  removeMember: mock(async () => env({})),
  revokeInvitation: mock(async () => env({})),
  changeMemberRole: mock(async () => env({})),
  acceptInvitation: mock(async () => env({})),
  rejectInvitation: mock(async () => env({})),
}));

const { WorkspaceSwitcher } = await import("@/features/workspaces/components/workspace-switcher");
const { RenameField } = await import("@/features/workspaces/components/rename-field");
const { WorkspaceRouteGuard, useActiveWorkspace } = await import(
  "@/features/workspaces/components/active-workspace"
);

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function WsHome() {
  const { workspaceId } = useParams();
  const active = useActiveWorkspace();
  return (
    <div>
      <div data-testid="active-ws-id">{workspaceId}</div>
      {/* top bar name surface — proves a rename shows "everywhere" (AS-005) */}
      <div data-testid="topbar-ws-name">{active.workspace.name}</div>
      <WorkspaceSwitcher />
      <RenameField />
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
          <Route path="*" element={<div>elsewhere</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const adminBoot = env({
  userId: "me",
  activeWorkspaceId: "ws-acme",
  workspaces: [{ id: "ws-acme", name: "Acme", slug: "acme", role: "admin", adminName: "Me" }],
});
const memberBoot = env({
  userId: "me",
  activeWorkspaceId: "ws-acme",
  workspaces: [{ id: "ws-acme", name: "Acme", slug: "acme", role: "member", adminName: "Lan" }],
});

beforeEach(() => {
  // mockClear wipes call records but NOT a prior test's mockImplementation; reset the
  // bootstrap impl so each test's own `bootstrap` (admin vs member) is what's served.
  fetchBootstrap.mockReset();
  fetchBootstrap.mockImplementation(async () => bootstrap);
  createWorkspace.mockClear();
  renameWorkspace.mockClear();
  setActiveWorkspace.mockClear();
});

describe("workspaces-ui S-002 — create and rename", () => {
  it("AS-004: creating a workspace switches into it as admin", async () => {
    bootstrap = adminBoot;
    // After create, the bootstrap refetch should reflect the new admin workspace.
    fetchBootstrap.mockImplementation(async () => env({
      userId: "me",
      activeWorkspaceId: "ws-acme",
      workspaces: [
        { id: "ws-acme", name: "Acme", slug: "acme", role: "admin", adminName: "Me" },
        { id: "ws-new", name: "Acme", slug: "acme-2", role: "admin", adminName: "Me" },
      ],
    }));

    render(<App initial="/w/ws-acme" />);
    await userEvent.click(await screen.findByTestId("ws-switcher-trigger"));
    await userEvent.click(screen.getByTestId("ws-new-trigger"));

    await userEvent.type(screen.getByTestId("create-workspace-name"), "Acme");
    await userEvent.click(screen.getByTestId("create-workspace-submit"));

    expect(createWorkspace).toHaveBeenCalledWith("Acme");
    // The app switched into the new workspace (its /w/:id/ is now active).
    await waitFor(() => expect(screen.getByTestId("active-ws-id")).toHaveTextContent("ws-new"));
    // And it became active server-side (creator=admin per backend AS-004).
    expect(setActiveWorkspace).toHaveBeenCalledWith("ws-new");
  });

  it("AS-005: renaming a workspace I own updates it in the switcher and the top bar", async () => {
    bootstrap = adminBoot;
    render(<App initial="/w/ws-acme" />);
    await waitFor(() => expect(screen.getByTestId("topbar-ws-name")).toHaveTextContent("Acme"));

    // After rename the bootstrap reflects the new name.
    fetchBootstrap.mockImplementation(async () => env({
      userId: "me",
      activeWorkspaceId: "ws-acme",
      workspaces: [{ id: "ws-acme", name: "Acme Docs", slug: "acme", role: "admin", adminName: "Me" }],
    }));

    await userEvent.click(screen.getByTestId("rename-edit"));
    const input = screen.getByTestId("rename-input");
    await userEvent.clear(input);
    await userEvent.type(input, "Acme Docs");
    await userEvent.click(screen.getByTestId("rename-save"));

    expect(renameWorkspace).toHaveBeenCalledWith("ws-acme", "Acme Docs");
    // The new name shows in the top bar (and switcher) — i.e. everywhere the active ws is read.
    await waitFor(() => expect(screen.getByTestId("topbar-ws-name")).toHaveTextContent("Acme Docs"));
  });

  it("AS-006: a non-admin sees no rename control", async () => {
    bootstrap = memberBoot;
    render(<App initial="/w/ws-acme" />);
    await waitFor(() => expect(screen.getByTestId("topbar-ws-name")).toHaveTextContent("Acme"));
    // The rename affordance is admin-only (C-002) — absent for a member.
    expect(screen.queryByTestId("rename-edit")).not.toBeInTheDocument();
  });
});
