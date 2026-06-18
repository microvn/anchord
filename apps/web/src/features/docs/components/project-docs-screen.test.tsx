import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// workspace-project-browse S-001 — the per-project doc browse (ProjectDocsScreen). Client
// wrappers MOCKED. Asserts: opening a project lists ONLY that project's docs with the project
// name as the view title (AS-001), a back-to-Projects control returns to the Projects screen
// (AS-002), the list paginates like All-docs (AS-003), and an empty project shows a named empty
// state with the back control (AS-004). Pixel/responsive [→MANUAL].

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
  renameProject: mock(async () => env({})),
  archiveProject: mock(async () => env({})),
  unarchiveProject: mock(async () => env({})),
  deleteProject: mock(async () => env({})),
  searchDocs: mock(async () => env({ results: [] })),
  publishDoc: mock(async () => env({ docId: "d1", slug: "s1", url: "/d/s1" })),
  moveDoc: mock(async () => env({ docId: "d1", slug: "spec", projectId: "p1" })),
  copyDoc: mock(async () => env({ docId: "d2", slug: "spec-copy", projectId: "p1" })),
}));

const { ProjectDocsScreen } = await import("@/features/docs/components/project-docs-screen");
const { WorkspaceRouteGuard } = await import("@/features/workspaces/components/active-workspace");

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function App({ initial = "/w/ws-acme/projects/p1" }: { initial?: string } = {}) {
  bootstrap = env({
    userId: "me",
    activeWorkspaceId: "ws-acme",
    workspaces: [{ id: "ws-acme", name: "Acme", slug: "acme", role: "admin", adminName: "Me" }],
  });
  return (
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/w/:workspaceId" element={<WorkspaceRouteGuard />}>
            <Route path="projects" element={<div data-testid="projects-screen-marker">Projects</div>} />
            <Route path="projects/:projectId" element={<ProjectDocsScreen />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

// Constant timestamps so the default Updated-desc sort (S-003) is a no-op tie → the docs keep
// insertion order, letting the pagination test assert doc-1..18 deterministically.
const mkDocs = (slugs: string[]) =>
  slugs.map((s) => ({
    id: `d-${s}`,
    slug: s,
    title: `Doc ${s}`,
    kind: "markdown",
    version: 1,
    annotationCount: 0,
    authorName: "Me",
    status: "live",
    generalAccess: "anyone_in_workspace",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  }));

beforeEach(() => {
  fetchProjectDocs.mockImplementation(defaultProjectDocs);
  projects = env({
    projects: [
      { id: "p1", name: "Billing", isDefault: false, archived: false },
      { id: "p2", name: "Payments", isDefault: false, archived: false },
    ],
  });
  docsByProject.p1 = env({ docs: mkDocs(["billing-a", "billing-b", "billing-c"]) });
  docsByProject.p2 = env({ docs: mkDocs(["pay-1", "pay-2", "pay-3", "pay-4", "pay-5"]) });
});

describe("workspace-project-browse S-001 — per-project doc browse", () => {
  it("AS-001: opening a project lists ONLY that project's docs, with the project name as the view title", async () => {
    render(<App initial="/w/ws-acme/projects/p1" />);
    // Billing's 3 docs render; Payments' docs do not.
    expect(await screen.findByTestId("doc-card-billing-a")).toBeInTheDocument();
    expect(screen.getByTestId("doc-card-billing-b")).toBeInTheDocument();
    expect(screen.getByTestId("doc-card-billing-c")).toBeInTheDocument();
    expect(screen.queryByTestId("doc-card-pay-1")).not.toBeInTheDocument();
    // The project name is the view title.
    expect(screen.getByTestId("project-docs-title")).toHaveTextContent("Billing");
  });

  it("AS-001: a different project shows that other project's docs", async () => {
    render(<App initial="/w/ws-acme/projects/p2" />);
    expect(await screen.findByTestId("doc-card-pay-1")).toBeInTheDocument();
    expect(screen.getByTestId("doc-card-pay-5")).toBeInTheDocument();
    expect(screen.queryByTestId("doc-card-billing-a")).not.toBeInTheDocument();
    expect(screen.getByTestId("project-docs-title")).toHaveTextContent("Payments");
  });

  it("AS-002/C-001: a back-to-Projects control returns to the Projects screen", async () => {
    render(<App initial="/w/ws-acme/projects/p1" />);
    await screen.findByTestId("doc-card-billing-a");
    await userEvent.click(screen.getByTestId("back-to-projects"));
    expect(await screen.findByTestId("projects-screen-marker")).toBeInTheDocument();
  });

  it("AS-003/C-002: a project's doc list paginates like the All-docs grid (25 docs → 2 pages of 18)", async () => {
    const slugs = Array.from({ length: 25 }, (_, i) => `doc-${i + 1}`);
    docsByProject.p1 = env({ docs: mkDocs(slugs) });
    render(<App initial="/w/ws-acme/projects/p1" />);
    // Page 1 shows the first 18 (page size 18), not doc 19.
    expect(await screen.findByTestId("doc-card-doc-1")).toBeInTheDocument();
    expect(screen.getByTestId("doc-card-doc-18")).toBeInTheDocument();
    expect(screen.queryByTestId("doc-card-doc-19")).not.toBeInTheDocument();
    // Numbered control reflects 2 pages (25 / 18 = 18 + 7).
    expect(screen.getByTestId("pagination")).toBeInTheDocument();
    expect(screen.getByTestId("pagination-page-2")).toBeInTheDocument();
    expect(screen.queryByTestId("pagination-page-3")).not.toBeInTheDocument();
    // Navigating to page 2 shows the remaining 7.
    await userEvent.click(screen.getByTestId("pagination-page-2"));
    expect(await screen.findByTestId("doc-card-doc-19")).toBeInTheDocument();
    expect(screen.getByTestId("doc-card-doc-25")).toBeInTheDocument();
  });

  it("AS-004: a project with no accessible docs shows a named empty state with the back control", async () => {
    docsByProject.p1 = env({ docs: [] });
    render(<App initial="/w/ws-acme/projects/p1" />);
    expect(await screen.findByTestId("project-docs-empty")).toBeInTheDocument();
    // Still names the project and offers the back control.
    expect(screen.getByTestId("project-docs-title")).toHaveTextContent("Billing");
    expect(screen.getByTestId("back-to-projects")).toBeInTheDocument();
    expect(screen.queryByTestId("doc-grid")).not.toBeInTheDocument();
  });

  it("AS-015/C-007: the chosen sort applies to a per-project view too (Title A→Z)", async () => {
    // Insertion order webhook, auth, calendar (NOT alphabetical) → Title sort must reorder.
    docsByProject.p1 = env({
      docs: [
        { ...mkDocs(["webhook"])[0], title: "Webhook" },
        { ...mkDocs(["auth"])[0], title: "Auth" },
        { ...mkDocs(["calendar"])[0], title: "Calendar" },
      ],
    });
    const slugOrder = () =>
      Array.from(document.querySelectorAll('[data-testid^="doc-card-"]')).map((el) =>
        el.getAttribute("data-testid")!.replace("doc-card-", ""),
      );
    render(<App initial="/w/ws-acme/projects/p1" />);
    await screen.findByTestId("doc-card-webhook");
    await userEvent.selectOptions(screen.getByTestId("doc-sort"), "title");
    await waitFor(() => expect(slugOrder()).toEqual(["auth", "calendar", "webhook"]));
  });

  it("AS-011/C-005: the same faceted filter narrows a per-project view (deselect HTML)", async () => {
    docsByProject.p1 = env({
      docs: [
        { ...mkDocs(["billing-md"])[0], kind: "markdown" },
        { ...mkDocs(["billing-html"])[0], kind: "html" },
      ],
    });
    render(<App initial="/w/ws-acme/projects/p1" />);
    expect(await screen.findByTestId("doc-card-billing-md")).toBeInTheDocument();
    expect(screen.getByTestId("doc-card-billing-html")).toBeInTheDocument();

    // Open the SAME filter bar and deselect HTML → the html doc leaves Billing's grid.
    await userEvent.click(screen.getByTestId("doc-filter-button"));
    await userEvent.click(await screen.findByTestId("facet-format-html"));
    await waitFor(() => expect(screen.queryByTestId("doc-card-billing-html")).not.toBeInTheDocument());
    expect(screen.getByTestId("doc-card-billing-md")).toBeInTheDocument();
    expect(screen.getByTestId("doc-filter-showing")).toHaveTextContent("showing 1 of 2");
  });
});
