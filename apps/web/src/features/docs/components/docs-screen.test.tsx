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
const fetchProjectDocs = mock(async (_w: string, id: string) => docsByProject[id]);
mock.module("@/features/docs/services/client", () => ({
  fetchProjects,
  fetchProjectDocs,
  createProject: mock(async () => env({})),
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
