import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// workspace-project S-003 — the All-docs browser (DocsScreen / DocGrid). Client wrappers
// MOCKED. Asserts: DocCards render the access-filtered docs, the grid/list view toggle swaps
// the layout, and a filter that matches nothing renders the NoResultsState (distinct from the
// empty data state — C-007). Pixel/responsive [→MANUAL].

const env = (body: unknown) => ({ data: { success: true, data: body }, error: null });

let bootstrap: unknown;
mock.module("@/features/workspaces/services/client", () => ({
  fetchBootstrap: mock(async () => bootstrap),
  fetchMembers: mock(async () => env({ members: [], invitations: [] })),
  setActiveWorkspace: mock(async () => env({})),
  createWorkspace: mock(async () => env({})),
  renameWorkspace: mock(async () => env({})),
  inviteMember: mock(async () => env({})),
  removeMember: mock(async () => env({})),
  changeMemberRole: mock(async () => env({})),
  acceptInvitation: mock(async () => env({})),
  rejectInvitation: mock(async () => env({})),
}));

let projects: unknown;
const docsByProject: Record<string, unknown> = {};
const fetchProjects = mock(async () => projects);
const defaultProjectDocs = async (_w: string, id: string) => docsByProject[id];
const fetchProjectDocs = mock(defaultProjectDocs);
mock.module("@/features/docs/services/client", () => ({
  fetchProjects,
  fetchProjectDocs,
  createProject: mock(async () => env({})),
  // The project-mutation thunks are included so this process-global mock.module does not
  // UNDER-shadow the real client for sibling test files that use them (bun mock.module is
  // process-wide — an incomplete mock here erases `renameProject`/etc. from project-manage.test).
  renameProject: mock(async () => env({})),
  archiveProject: mock(async () => env({})),
  unarchiveProject: mock(async () => env({})),
  deleteProject: mock(async () => env({})),
  searchDocs: mock(async () => env({ results: [] })),
  publishDoc: mock(async () => env({ docId: "d1", slug: "s1", url: "/d/s1" })),
  moveDoc: mock(async () => env({ docId: "d1", slug: "spec", projectId: "p1" })),
  copyDoc: mock(async () => env({ docId: "d2", slug: "spec-copy", projectId: "p1" })),
}));

const { DocsScreen } = await import("@/features/docs/components/docs-screen");
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
      <MemoryRouter initialEntries={["/w/ws-acme/docs"]}>
        <Routes>
          <Route path="/w/:workspaceId" element={<WorkspaceRouteGuard />}>
            <Route path="docs" element={<DocsScreen />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  fetchProjectDocs.mockImplementation(defaultProjectDocs);
  projects = env({ projects: [{ id: "p1", name: "web-core", isDefault: true, archived: false }] });
  docsByProject.p1 = env({
    docs: [
      { id: "d1", slug: "spec", title: "Web-core spec", kind: "markdown" },
      { id: "d2", slug: "rfc", title: "Publish RFC", kind: "html" },
    ],
  });
});

describe("workspace-project S-003 — All-docs browser", () => {
  it("renders a DocCard grid and toggles to the list view", async () => {
    render(<App />);
    // Grid is the default view; both docs render as cards.
    expect(await screen.findByTestId("doc-card-spec")).toHaveTextContent("Web-core spec");
    expect(screen.getByTestId("doc-card-rfc")).toBeInTheDocument();
    expect(screen.getByTestId("doc-grid")).toBeInTheDocument();
    expect(screen.queryByTestId("doc-list")).not.toBeInTheDocument();

    // Toggle to list view → the grid is replaced by the list rows.
    await userEvent.click(screen.getByTestId("view-list"));
    await waitFor(() => expect(screen.getByTestId("doc-list")).toBeInTheDocument());
    expect(screen.queryByTestId("doc-grid")).not.toBeInTheDocument();
    expect(screen.getByTestId("doc-row-spec")).toBeInTheDocument();
  });

  it("a filter that matches nothing shows NoResultsState (distinct from empty)", async () => {
    render(<App />);
    await screen.findByTestId("doc-card-spec");

    // The "Has detached" filter resolves to 0 (no endpoint exposes detached counts) →
    // NoResultsState with a Clear search action, NOT the empty-data create CTA.
    await userEvent.click(screen.getByTestId("filter-detached"));
    expect(await screen.findByRole("button", { name: /clear search/i })).toBeInTheDocument();
    expect(screen.queryByTestId("doc-card-spec")).not.toBeInTheDocument();

    // Clear returns to All → the docs reappear.
    await userEvent.click(screen.getByRole("button", { name: /clear search/i }));
    await waitFor(() => expect(screen.getByTestId("doc-card-spec")).toBeInTheDocument());
  });
});

// ── S-008 pagination ────────────────────────────────────────────────────────
// The All-docs browse is the workspace-wide UNION of access-filtered docs (no per-project
// route exists in anchord). The backend paginates each project-docs read; the union is fetched
// COMPLETE (paging hasNext) so counts stay correct, then sliced into pages of 20 client-side.
// AS-021/022/023/026 assert the numbered control over that accessible union.

// 45 docs in one project, returned as paginated pages of 20 (total=45, hasNext until page 3).
function pageOfDocs(page: number, limit: number, total: number) {
  const start = (page - 1) * limit;
  const docs = Array.from({ length: Math.max(0, Math.min(limit, total - start)) }, (_, i) => {
    const n = start + i + 1;
    return { id: `d${n}`, slug: `doc-${n}`, title: `Doc ${n}`, kind: "markdown" };
  });
  return env({
    docs,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrevious: page > 1,
    },
  });
}

describe("workspace-project-ui S-008 — All-docs pagination", () => {
  it("AS-021: a doc list of 45 shows the first 18 docs (full grid) and a 3-page numbered control", async () => {
    projects = env({ projects: [{ id: "p1", name: "web-core", isDefault: true, archived: false }] });
    // The backend hands the complete 45-doc set; the doc grid slices at DOCS_PAGE_SIZE=18 client-side.
    fetchProjectDocs.mockImplementation(
      async (_w: string, _id: string, page = 1, limit = 20) => pageOfDocs(page, limit, 45),
    );

    render(<App />);
    // Page 1 shows docs 1..18 (a full grid, no empty cell), not doc 19.
    expect(await screen.findByTestId("doc-card-doc-1")).toBeInTheDocument();
    expect(screen.getByTestId("doc-card-doc-18")).toBeInTheDocument();
    expect(screen.queryByTestId("doc-card-doc-19")).not.toBeInTheDocument();
    // A numbered control reflecting 3 pages (45 / 18 = 18/18/9).
    expect(screen.getByTestId("pagination")).toBeInTheDocument();
    expect(screen.getByTestId("pagination-page-3")).toBeInTheDocument();
    expect(screen.queryByTestId("pagination-page-4")).not.toBeInTheDocument();
  });

  it("AS-022: navigating to the last page shows docs 37–45 and disables Next", async () => {
    projects = env({ projects: [{ id: "p1", name: "web-core", isDefault: true, archived: false }] });
    fetchProjectDocs.mockImplementation(
      async (_w: string, _id: string, page = 1, limit = 20) => pageOfDocs(page, limit, 45),
    );
    const user = userEvent.setup();

    render(<App />);
    await screen.findByTestId("doc-card-doc-1");
    await user.click(screen.getByTestId("pagination-page-3"));

    // Last page (3) shows 37..45 (page size 18); Next is disabled.
    expect(await screen.findByTestId("doc-card-doc-37")).toBeInTheDocument();
    expect(screen.getByTestId("doc-card-doc-45")).toBeInTheDocument();
    expect(screen.queryByTestId("doc-card-doc-36")).not.toBeInTheDocument();
    expect(screen.getByTestId("pagination-next")).toBeDisabled();
  });

  it("AS-023: a 7-doc list fits one page and shows no pagination control", async () => {
    projects = env({ projects: [{ id: "p1", name: "web-core", isDefault: true, archived: false }] });
    fetchProjectDocs.mockImplementation(
      async (_w: string, _id: string, page = 1, limit = 20) => pageOfDocs(page, limit, 7),
    );

    render(<App />);
    expect(await screen.findByTestId("doc-card-doc-1")).toBeInTheDocument();
    expect(screen.getByTestId("doc-card-doc-7")).toBeInTheDocument();
    expect(screen.queryByTestId("pagination")).not.toBeInTheDocument();
  });

  it("AS-026: the page count uses pagination.total (accessible only), never the raw doc count", async () => {
    projects = env({ projects: [{ id: "p1", name: "web-core", isDefault: true, archived: false }] });
    // 22 accessible docs (the backend already dropped the 18 inaccessible ones) → total: 22.
    fetchProjectDocs.mockImplementation(
      async (_w: string, _id: string, page = 1, limit = 20) => pageOfDocs(page, limit, 22),
    );

    render(<App />);
    await screen.findByTestId("doc-card-doc-1");
    // 22 accessible at page-size 18 → exactly 2 pages (18 + 4), never 3 (and never 40-based).
    expect(screen.getByTestId("pagination-page-2")).toBeInTheDocument();
    expect(screen.queryByTestId("pagination-page-3")).not.toBeInTheDocument();
  });
});
