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
  revokeInvitation: mock(async () => env({})),
  changeMemberRole: mock(async () => env({})),
  acceptInvitation: mock(async () => env({})),
  rejectInvitation: mock(async () => env({})),
}));

// S-008: DocsScreen reads the SINGLE workspace-docs endpoint (fetchWorkspaceDocs), paging
// SERVER-SIDE — one read per grid page. `workspaceDocs` is the default page-1 envelope; tests that
// exercise paging install a page-aware mock implementation. fetchProjects/fetchProjectDocs are still
// declared (process-global mock surface) but useWorkspaceDocs no longer calls them — AS-027 asserts
// fetchProjectDocs is NEVER called.
let workspaceDocs: unknown;
const fetchProjects = mock(async () => env({ projects: [] }));
const defaultWorkspaceDocs = async (_w: string, _page = 1, _limit = 18) => workspaceDocs;
const fetchProjectDocs = mock(async () => env({ docs: [] }));
const fetchWorkspaceDocs = mock(defaultWorkspaceDocs);
mock.module("@/features/docs/services/client", () => ({
  fetchProjects,
  fetchProjectDocs,
  fetchWorkspaceDocs,
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
  deleteDoc: mock(async () => env({ docId: "d1", slug: "spec", deleted: true })),
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

// A browse doc row carries status/access/format/timestamps so the faceted filter (S-002) can
// partition it. Tests override only the axes they care about.
const docRow = (d: Record<string, unknown>) => ({
  kind: "markdown",
  version: 1,
  annotationCount: 0,
  authorName: "Me",
  status: "live",
  generalAccess: "anyone_in_workspace",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  projectId: "p1",
  projectName: "web-core",
  ...d,
});

/** Build the workspace-docs envelope: a page of docs + the active-project list (id + name; no
 * per-project docCount, AS-024) + a pagination total. */
function wsDocs(
  docs: Record<string, unknown>[],
  opts: { total?: number; page?: number; limit?: number; projects?: Record<string, unknown>[] } = {},
) {
  const total = opts.total ?? docs.length;
  const limit = opts.limit ?? 18;
  const page = opts.page ?? 1;
  return env({
    docs,
    projects: opts.projects ?? [{ id: "p1", name: "web-core", isDefault: true, archived: false }],
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

beforeEach(() => {
  fetchWorkspaceDocs.mockImplementation(defaultWorkspaceDocs);
  fetchProjectDocs.mockClear();
  fetchWorkspaceDocs.mockClear();
  workspaceDocs = wsDocs([
    docRow({ id: "d1", slug: "spec", title: "Web-core spec", kind: "markdown" }),
    docRow({ id: "d2", slug: "rfc", title: "Publish RFC", kind: "html" }),
  ]);
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
});

// ── workspace-project-browse S-002 — faceted filter (integration on All-docs) ───────────────
// The pure engine is unit-tested in lib/doc-filter.test.ts (AS-005..010 logic + counts). These
// assert the DocFilterBar + popover wired into DocsScreen: the popover opens with the four groups
// all selected and NO search box (AS-005); deselecting a facet narrows the grid + updates "showing
// X of N" (AS-006); Reset re-selects everything and the header returns to the full count (AS-010);
// the same filter component drives the screen (C-005).
describe("workspace-project-browse S-002 — faceted filter on All-docs", () => {
  beforeEach(() => {
    // A mix: a live markdown (spec), a live html (rfc), a draft restricted markdown (draft-md).
    workspaceDocs = wsDocs([
      docRow({ id: "d1", slug: "spec", title: "Web-core spec", kind: "markdown" }),
      docRow({ id: "d2", slug: "rfc", title: "Publish RFC", kind: "html" }),
      docRow({ id: "d3", slug: "draft-md", title: "Draft MD", kind: "markdown", status: "draft", generalAccess: "restricted" }),
    ]);
  });

  it("AS-005: the Filter popover lists the four facet groups (all selected) with NO search box; bar has Sort + grid/list", async () => {
    render(<App />);
    await screen.findByTestId("doc-card-spec");
    // No search box on the bar; a Sort control + grid/list toggle ARE present.
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.getByTestId("doc-sort")).toBeInTheDocument();
    expect(screen.getByTestId("view-grid")).toBeInTheDocument();

    // Open the popover → four groups, each value selected (aria-pressed / aria-checked true).
    await userEvent.click(screen.getByTestId("doc-filter-button"));
    expect(await screen.findByTestId("doc-filter-popover")).toBeInTheDocument();
    expect(screen.getByTestId("facet-status-live")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("facet-format-markdown")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("facet-access-restricted")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("facet-updated-any")).toHaveAttribute("aria-checked", "true");
    // Format counts are dynamic totals: 2 markdown, 1 html.
    expect(screen.getByTestId("facet-format-markdown-count")).toHaveTextContent("2");
    expect(screen.getByTestId("facet-format-html-count")).toHaveTextContent("1");
    // All three docs show.
    expect(screen.getByTestId("doc-card-spec")).toBeInTheDocument();
    expect(screen.getByTestId("doc-card-rfc")).toBeInTheDocument();
    expect(screen.getByTestId("doc-card-draft-md")).toBeInTheDocument();
  });

  it("AS-006: deselecting the Markdown format value narrows the grid and updates the count", async () => {
    render(<App />);
    await screen.findByTestId("doc-card-spec");
    await userEvent.click(screen.getByTestId("doc-filter-button"));
    await userEvent.click(await screen.findByTestId("facet-format-markdown"));
    // Markdown docs leave; the html doc stays.
    await waitFor(() => expect(screen.queryByTestId("doc-card-spec")).not.toBeInTheDocument());
    expect(screen.queryByTestId("doc-card-draft-md")).not.toBeInTheDocument();
    expect(screen.getByTestId("doc-card-rfc")).toBeInTheDocument();
    // "showing 1 of 3"
    expect(screen.getByTestId("doc-filter-showing")).toHaveTextContent("showing 1 of 3");
  });

  it("AS-010/C-005: Reset re-selects everything and the header returns to the full count", async () => {
    render(<App />);
    await screen.findByTestId("doc-card-spec");
    await userEvent.click(screen.getByTestId("doc-filter-button"));
    await userEvent.click(await screen.findByTestId("facet-format-markdown"));
    expect(screen.getByTestId("doc-filter-showing")).toHaveTextContent("showing 1 of 3");
    // The Filter control reads active while narrowed.
    expect(screen.getByTestId("doc-filter-badge")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("doc-filter-reset"));
    await waitFor(() => expect(screen.getByTestId("doc-card-spec")).toBeInTheDocument());
    expect(screen.getByTestId("doc-filter-showing")).toHaveTextContent("3 docs");
    expect(screen.queryByTestId("doc-filter-badge")).not.toBeInTheDocument();
  });

  it("a filter that matches nothing shows NoResultsState (distinct from empty)", async () => {
    render(<App />);
    await screen.findByTestId("doc-card-spec");
    await userEvent.click(screen.getByTestId("doc-filter-button"));
    // Deselect BOTH statuses → nothing matches → NoResultsState (not the empty-data CTA).
    await userEvent.click(await screen.findByTestId("facet-status-live"));
    await userEvent.click(screen.getByTestId("facet-status-draft"));
    expect(await screen.findByRole("button", { name: /clear/i })).toBeInTheDocument();
    expect(screen.queryByTestId("doc-card-spec")).not.toBeInTheDocument();
  });
});

// ── workspace-project-browse S-003 — sort (integration on All-docs) ─────────────────────────
// The comparator is unit-tested in lib/doc-filter.test.ts (AS-012/013/014). This asserts the Sort
// control on the bar reorders the rendered grid (AS-012 default Updated-desc, AS-013 Title A→Z).
const slugOrder = () =>
  Array.from(document.querySelectorAll('[data-testid^="doc-card-"]')).map((el) =>
    el.getAttribute("data-testid")!.replace("doc-card-", ""),
  );

describe("workspace-project-browse S-003 — sort on All-docs", () => {
  beforeEach(() => {
    // Updated order (desc) is webhook, auth, calendar — deliberately NOT alphabetical, so the
    // Title sort visibly reorders.
    workspaceDocs = wsDocs([
      docRow({ id: "d1", slug: "webhook", title: "Webhook", updatedAt: "2026-06-18T00:00:00.000Z" }),
      docRow({ id: "d2", slug: "auth", title: "Auth", updatedAt: "2026-06-10T00:00:00.000Z" }),
      docRow({ id: "d3", slug: "calendar", title: "Calendar", updatedAt: "2026-06-01T00:00:00.000Z" }),
    ]);
  });

  it("AS-012: the default order is most-recently-updated first", async () => {
    render(<App />);
    await screen.findByTestId("doc-card-webhook");
    // Updated desc: webhook (06-18), auth (06-10), calendar (06-01).
    expect(slugOrder()).toEqual(["webhook", "auth", "calendar"]);
  });

  it("AS-013/C-007: choosing Sort = Title reorders the grid A→Z", async () => {
    render(<App />);
    await screen.findByTestId("doc-card-webhook");
    expect(slugOrder()).toEqual(["webhook", "auth", "calendar"]); // updated-desc default
    await userEvent.click(screen.getByTestId("doc-sort"));
    await userEvent.click(await screen.findByRole("option", { name: "Title" }));
    // Title A→Z: Auth, Calendar, Webhook — different from the default updated order.
    await waitFor(() => expect(slugOrder()).toEqual(["auth", "calendar", "webhook"]));
  });
});

// ── S-008 — single workspace-docs read, server-side paging ────────────────────
// The All-docs browse reads the workspace-wide UNION from the ONE backend endpoint
// (fetchWorkspaceDocs), paging SERVER-SIDE: the screen's page drives the read (limit =
// DOCS_PAGE_SIZE = 18), so one server page fills one grid page exactly. The total + per-project
// counts come from the same read. AS-027 asserts the read happens ONCE on load (no per-project
// fan-out) and once more per page change.

// One server page of `total` docs at size `limit`, each carrying its project annotation so the
// faceted filter's default-all selection keeps every doc.
function pageOfDocs(page: number, limit: number, total: number) {
  const start = (page - 1) * limit;
  const docs = Array.from({ length: Math.max(0, Math.min(limit, total - start)) }, (_, i) => {
    const n = start + i + 1;
    return {
      id: `d${n}`,
      slug: `doc-${n}`,
      title: `Doc ${n}`,
      kind: "markdown",
      status: "live",
      generalAccess: "anyone_in_workspace",
      projectId: "p1",
      projectName: "web-core",
    };
  });
  return env({
    docs,
    projects: [{ id: "p1", name: "web-core", isDefault: true, archived: false }],
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

describe("workspace-project S-008 — single workspace-docs read, server-side paging", () => {
  it("AS-025: a 45-doc workspace shows the first 18 (full grid) and a 3-page numbered control", async () => {
    fetchWorkspaceDocs.mockImplementation(
      async (_w: string, page = 1, limit = 18) => pageOfDocs(page, limit, 45),
    );

    render(<App />);
    // Page 1 shows docs 1..18 (a full grid, no empty cell), not doc 19.
    expect(await screen.findByTestId("doc-card-doc-1")).toBeInTheDocument();
    expect(screen.getByTestId("doc-card-doc-18")).toBeInTheDocument();
    expect(screen.queryByTestId("doc-card-doc-19")).not.toBeInTheDocument();
    // A numbered control reflecting 3 pages (45 / 18 = 18/18/9), from pagination.totalPages.
    expect(screen.getByTestId("pagination")).toBeInTheDocument();
    expect(screen.getByTestId("pagination-page-3")).toBeInTheDocument();
    expect(screen.queryByTestId("pagination-page-4")).not.toBeInTheDocument();
  });

  it("AS-025: navigating to the last page issues one more read for that page (docs 37–45), Next disabled", async () => {
    fetchWorkspaceDocs.mockImplementation(
      async (_w: string, page = 1, limit = 18) => pageOfDocs(page, limit, 45),
    );
    const user = userEvent.setup();

    render(<App />);
    await screen.findByTestId("doc-card-doc-1");
    fetchWorkspaceDocs.mockClear();
    await user.click(screen.getByTestId("pagination-page-3"));

    // Page 3 (server) shows 37..45; Next is disabled. One more read was issued for page 3.
    expect(await screen.findByTestId("doc-card-doc-37")).toBeInTheDocument();
    expect(screen.getByTestId("doc-card-doc-45")).toBeInTheDocument();
    expect(screen.queryByTestId("doc-card-doc-36")).not.toBeInTheDocument();
    expect(screen.getByTestId("pagination-next")).toBeDisabled();
    // The page change drove exactly one more workspace-docs read, requesting page 3.
    expect(fetchWorkspaceDocs).toHaveBeenCalledTimes(1);
    expect(fetchWorkspaceDocs.mock.calls[0]?.[1]).toBe(3);
  });

  it("AS-023: a 7-doc workspace fits one page and shows no pagination control", async () => {
    fetchWorkspaceDocs.mockImplementation(
      async (_w: string, page = 1, limit = 18) => pageOfDocs(page, limit, 7),
    );

    render(<App />);
    expect(await screen.findByTestId("doc-card-doc-1")).toBeInTheDocument();
    expect(screen.getByTestId("doc-card-doc-7")).toBeInTheDocument();
    expect(screen.queryByTestId("pagination")).not.toBeInTheDocument();
  });

  it("AS-026: the page count uses pagination.total (accessible only), never the raw doc count", async () => {
    // 22 accessible docs (the backend already dropped the inaccessible ones) → total: 22.
    fetchWorkspaceDocs.mockImplementation(
      async (_w: string, page = 1, limit = 18) => pageOfDocs(page, limit, 22),
    );

    render(<App />);
    await screen.findByTestId("doc-card-doc-1");
    // 22 accessible at page-size 18 → exactly 2 pages (18 + 4), never 3.
    expect(screen.getByTestId("pagination-page-2")).toBeInTheDocument();
    expect(screen.queryByTestId("pagination-page-3")).not.toBeInTheDocument();
  });

  it("AS-027: loads grid + counts from the ONE fetchWorkspaceDocs read; never fetchProjectDocs per project", async () => {
    fetchWorkspaceDocs.mockImplementation(
      async (_w: string, page = 1, limit = 18) => pageOfDocs(page, limit, 7),
    );

    render(<App />);
    // The grid renders from the single read.
    expect(await screen.findByTestId("doc-card-doc-1")).toBeInTheDocument();
    // EXACTLY one workspace-docs read on load (page 1) — not 1 + N per-project reads.
    expect(fetchWorkspaceDocs).toHaveBeenCalledTimes(1);
    expect(fetchWorkspaceDocs.mock.calls[0]?.[1]).toBe(1);
    // The retired fan-out: fetchProjectDocs is NEVER called by the All-docs view.
    expect(fetchProjectDocs).not.toHaveBeenCalled();
  });
});
