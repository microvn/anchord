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
  ...d,
});

beforeEach(() => {
  fetchProjectDocs.mockImplementation(defaultProjectDocs);
  projects = env({ projects: [{ id: "p1", name: "web-core", isDefault: true, archived: false }] });
  docsByProject.p1 = env({
    docs: [
      docRow({ id: "d1", slug: "spec", title: "Web-core spec", kind: "markdown" }),
      docRow({ id: "d2", slug: "rfc", title: "Publish RFC", kind: "html" }),
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
    docsByProject.p1 = env({
      docs: [
        docRow({ id: "d1", slug: "spec", title: "Web-core spec", kind: "markdown" }),
        docRow({ id: "d2", slug: "rfc", title: "Publish RFC", kind: "html" }),
        docRow({ id: "d3", slug: "draft-md", title: "Draft MD", kind: "markdown", status: "draft", generalAccess: "restricted" }),
      ],
    });
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
    docsByProject.p1 = env({
      docs: [
        docRow({ id: "d1", slug: "webhook", title: "Webhook", updatedAt: "2026-06-18T00:00:00.000Z" }),
        docRow({ id: "d2", slug: "auth", title: "Auth", updatedAt: "2026-06-10T00:00:00.000Z" }),
        docRow({ id: "d3", slug: "calendar", title: "Calendar", updatedAt: "2026-06-01T00:00:00.000Z" }),
      ],
    });
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
    // status/generalAccess so the faceted filter's default-all selection keeps every doc; no
    // timestamps → the default Updated-desc sort is an all-tie (stable), preserving doc-1..N order.
    return {
      id: `d${n}`,
      slug: `doc-${n}`,
      title: `Doc ${n}`,
      kind: "markdown",
      status: "live",
      generalAccess: "anyone_in_workspace",
    };
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
