import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// project-visibility-fe S-005 — the New Project dialog's create-time Public/Private control.
// Client + sonner MOCKED (no live backend; happy-dom). Covers: creating at the DEFAULT control →
// the create thunk is called PUBLIC (AS-018, prior behaviour preserved), and setting the control to
// Private → the thunk carries visibility:"private" (AS-019). C-001: the control COLLECTS the user's
// pick and sends it verbatim — the FE never derives access. Pixel/responsive [→MANUAL].

const env = (body: unknown) => ({ data: { success: true, data: body }, error: null });

const toast = Object.assign(mock(() => {}), { success: mock(() => {}), error: mock(() => {}) });
mock.module("sonner", () => ({ toast }));

let bootstrap: unknown;
mock.module("@/features/workspaces/services/client", () => ({
  fetchBootstrap: mock(async () => bootstrap),
  fetchMembers: mock(async () => env({ members: [], invitations: [] })),
  setActiveWorkspace: mock(async () => env({})),
  createWorkspace: mock(async () => env({})),
  renameWorkspace: mock(async () => env({})),
  inviteMember: mock(async () => env({})),
  removeMember: mock(async () => env({})),
  revokeInvitation: mock(async () => env({})),
  changeMemberRole: mock(async () => env({})),
  acceptInvitation: mock(async () => env({})),
  rejectInvitation: mock(async () => env({})),
}));

const createProject = mock(async () => env({ id: "p_new", name: "Vault" }));
const fetchProjects = mock(async () => env({ projects: [] }));
mock.module("@/features/docs/services/client", () => ({
  fetchProjects,
  fetchProjectDocs: mock(async () => env({ docs: [] })),
  fetchWorkspaceDocs: mock(async () => env({ docs: [], projects: [] })),
  createProject,
  renameProject: mock(async () => env({})),
  setProjectVisibility: mock(async () => env({})),
  archiveProject: mock(async () => env({})),
  unarchiveProject: mock(async () => env({})),
  deleteProject: mock(async () => env({})),
  searchDocs: mock(async () => env({ results: [] })),
  publishDoc: mock(async () => env({ docId: "d1", slug: "s1", url: "/d/s1" })),
  moveDoc: mock(async () => env({ docId: "d1", slug: "spec", projectId: "p1" })),
  copyDoc: mock(async () => env({ docId: "d2", slug: "spec-copy", projectId: "p1" })),
  deleteDoc: mock(async () => env({ docId: "d1", slug: "spec", deleted: true })),
}));

const { ProjectsScreen } = await import("@/features/docs/components/projects-screen");
const { WorkspaceRouteGuard } = await import("@/features/workspaces/components/active-workspace");

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function App() {
  bootstrap = env({
    userId: "me",
    activeWorkspaceId: "ws-acme",
    workspaces: [{ id: "ws-acme", name: "Acme", slug: "acme", role: "admin", adminName: "Me" }],
  });
  return (
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={["/w/ws-acme/projects"]}>
        <Routes>
          <Route path="/w/:workspaceId" element={<WorkspaceRouteGuard />}>
            <Route path="projects" element={<ProjectsScreen />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  render(<App />);
  await waitFor(() => expect(screen.getByTestId("new-project-button")).toBeInTheDocument());
  await user.click(screen.getByTestId("new-project-button"));
  await waitFor(() => expect(screen.getByTestId("project-name")).toBeInTheDocument());
}

beforeEach(() => {
  createProject.mockClear();
  fetchProjects.mockClear();
  toast.success.mockClear();
  toast.error.mockClear();
});

describe("project-visibility-fe S-005", () => {
  it("AS-018: creating at the default control sends the create thunk PUBLIC (prior behaviour preserved)", async () => {
    const user = userEvent.setup();
    await openDialog(user);

    // The default control is Public — visible as the checked radio.
    expect(screen.getByTestId("new-project-visibility-public")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByTestId("new-project-visibility-private")).toHaveAttribute(
      "aria-checked",
      "false",
    );

    await user.type(screen.getByTestId("project-name"), "Vantage");
    await user.click(screen.getByTestId("create-project-button"));

    // C-001: the thunk carries exactly the default pick — public, no override beyond it.
    await waitFor(() => expect(createProject).toHaveBeenCalled());
    expect(createProject).toHaveBeenCalledWith("ws-acme", "Vantage", "public");
  });

  it("AS-019: setting the control to Private sends visibility:\"private\" on create", async () => {
    const user = userEvent.setup();
    await openDialog(user);

    await user.type(screen.getByTestId("project-name"), "Vault");
    await user.click(screen.getByTestId("new-project-visibility-private"));
    // The pick is reflected before submit (collected, not derived).
    expect(screen.getByTestId("new-project-visibility-private")).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await user.click(screen.getByTestId("create-project-button"));

    await waitFor(() => expect(createProject).toHaveBeenCalled());
    // C-001: exactly the user's choice is sent — private, never re-derived.
    expect(createProject).toHaveBeenCalledWith("ws-acme", "Vault", "private");
  });
});
