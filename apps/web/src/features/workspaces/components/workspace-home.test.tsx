import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// workspace-project S-003 — the workspace dashboard (WorkspaceHome). The docs + workspaces
// client wrappers are MOCKED (mock.module is process-global, so we declare the COMPLETE
// surface of each). Asserts: the stat row reflects the real docs/projects/members counts,
// recent docs render, and a workspace with zero docs shows the EmptyState (not a doc list).
// Pixel/responsive [→MANUAL]; real round-trip [→E2E].

const env = (body: unknown) => ({ data: { success: true, data: body }, error: null });

// ---- features/workspaces/client (bootstrap + members) ----
let bootstrap: unknown;
let members: unknown;
const fetchBootstrap = mock(async () => bootstrap);
const fetchMembers = mock(async () => members);
mock.module("@/features/workspaces/services/client", () => ({
  fetchBootstrap,
  fetchMembers,
  setActiveWorkspace: mock(async () => env({})),
  createWorkspace: mock(async () => env({})),
  renameWorkspace: mock(async () => env({})),
  inviteMember: mock(async () => env({})),
  removeMember: mock(async () => env({})),
  changeMemberRole: mock(async () => env({})),
  acceptInvitation: mock(async () => env({})),
  rejectInvitation: mock(async () => env({})),
}));

// ---- features/docs/client (projects + docs + search + publish) ----
// S-008: WorkspaceHome reads the SINGLE workspace-docs endpoint (fetchWorkspaceDocs) — one page of
// the doc union + the active-project list (id + name) + the workspace `pagination.total`. We mock that one thunk;
// fetchProjects/fetchProjectDocs stay declared (process-global mock surface) but are no longer
// called by useWorkspaceDocs.
let workspaceDocs: unknown;
const fetchProjects = mock(async () => env({ projects: [] }));
const fetchProjectDocs = mock(async () => env({ docs: [] }));
const fetchWorkspaceDocs = mock(async () => workspaceDocs);
const createProject = mock(async () => env({ id: "p-new", name: "new" }));
const searchDocs = mock(async () => env({ results: [] }));
const publishDoc = mock(async () => env({ docId: "d1", slug: "s1", url: "/d/s1" }));
mock.module("@/features/docs/services/client", () => ({
  fetchProjects,
  fetchProjectDocs,
  fetchWorkspaceDocs,
  createProject,
  searchDocs,
  publishDoc,
  moveDoc: mock(async () => env({ docId: "d1", slug: "s1", projectId: "p1" })),
  copyDoc: mock(async () => env({ docId: "d2", slug: "s2", projectId: "p1" })),
}));

/** Build the workspace-docs envelope: docs page + the active-project list (id + name; no
 * per-project docCount, AS-024) + a pagination total. */
function wsDocs(
  docs: Record<string, unknown>[],
  projects: { id: string; name: string; isDefault: boolean; archived: boolean }[],
  total = docs.length,
) {
  return env({
    docs,
    projects,
    pagination: {
      page: 1,
      limit: 18,
      total,
      totalPages: Math.ceil(total / 18),
      hasNext: total > 18,
      hasPrevious: false,
    },
  });
}

const { WorkspaceHome } = await import("@/features/workspaces/components/workspace-home");
const { WorkspaceRouteGuard } = await import("@/features/workspaces/components/active-workspace");

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function App({ role = "admin" as "admin" | "member" }) {
  bootstrap = env({
    userId: "me",
    activeWorkspaceId: "ws-acme",
    workspaces: [{ id: "ws-acme", name: "Acme Platform", slug: "acme", role, adminName: "Me" }],
  });
  return (
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={["/w/ws-acme/"]}>
        <Routes>
          <Route path="/w/:workspaceId" element={<WorkspaceRouteGuard />}>
            <Route index element={<WorkspaceHome />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  fetchProjects.mockClear();
  fetchProjectDocs.mockClear();
  fetchWorkspaceDocs.mockClear();
  fetchMembers.mockClear();
  members = env({
    members: [
      { userId: "u-me", email: "me@acme.com", name: "Me", role: "admin" },
      { userId: "u-bob", email: "bob@acme.com", name: "Bob", role: "member" },
    ],
    invitations: [],
  });
});

describe("workspace-project S-003 — workspace dashboard", () => {
  it("renders the stat counts and recent docs from the one workspace-docs read", async () => {
    workspaceDocs = wsDocs(
      [
        { id: "d1", slug: "web-core-spec", title: "Web-core behavior contract", kind: "markdown", projectId: "p1", projectName: "web-core" },
        { id: "d2", slug: "auth-flows", title: "Auth & invite flows", kind: "markdown", projectId: "p1", projectName: "web-core" },
        { id: "d3", slug: "rfc", title: "Render + publish pipeline RFC", kind: "html", projectId: "p2", projectName: "render-publish" },
      ],
      [
        { id: "p1", name: "web-core", isDefault: true, archived: false },
        { id: "p2", name: "render-publish", isDefault: false, archived: false },
      ],
      3,
    );

    render(<App />);

    // The Fraunces workspace name in the page head.
    expect(await screen.findByText("Acme Platform")).toBeInTheDocument();

    // Stat row: DOCS = 3 (union across projects), PROJECTS = 2, MEMBERS = 2.
    await waitFor(() =>
      expect(screen.getByTestId("stat-docs")).toHaveTextContent("3"),
    );
    expect(screen.getByTestId("stat-projects")).toHaveTextContent("2");
    expect(screen.getByTestId("stat-members")).toHaveTextContent("2");

    // Recent docs list renders the doc titles.
    expect(screen.getByTestId("doc-row-web-core-spec")).toHaveTextContent(
      "Web-core behavior contract",
    );
    expect(screen.getByTestId("doc-row-rfc")).toHaveTextContent("Render + publish pipeline RFC");
  });

  it("AS-020/C-006: the overview tile is labelled 'Annotations' and sums per-doc annotationCount (12)", async () => {
    workspaceDocs = wsDocs(
      [
        { id: "d1", slug: "a", title: "A", kind: "markdown", annotationCount: 5, projectId: "p1", projectName: "web-core" },
        { id: "d2", slug: "b", title: "B", kind: "markdown", annotationCount: 4, projectId: "p1", projectName: "web-core" },
        { id: "d3", slug: "c", title: "C", kind: "markdown", annotationCount: 3, projectId: "p1", projectName: "web-core" },
      ],
      [{ id: "p1", name: "web-core", isDefault: true, archived: false }],
      3,
    );

    render(<App />);

    // The tile is the "Annotations" stat (NOT "Comments"), and it reads the 5+4+3 = 12 sum.
    const tile = await waitFor(() => screen.getByTestId("stat-annotations"));
    expect(tile).toHaveTextContent("Annotations");
    expect(tile).toHaveTextContent("12");
    // The old "Comments" tile is gone.
    expect(screen.queryByTestId("stat-comments")).not.toBeInTheDocument();
  });

  it("a workspace with zero docs shows the EmptyState (not a doc list)", async () => {
    workspaceDocs = wsDocs(
      [],
      [{ id: "p1", name: "default", isDefault: true, archived: false }],
      0,
    );

    render(<App />);

    await waitFor(() => expect(screen.getByTestId("stat-docs")).toHaveTextContent("0"));
    expect(await screen.findByText("No docs yet")).toBeInTheDocument();
    expect(screen.queryByTestId("doc-list")).not.toBeInTheDocument();
  });
});
