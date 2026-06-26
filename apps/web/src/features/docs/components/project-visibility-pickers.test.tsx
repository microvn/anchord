import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import type { DocRow, ProjectRow } from "@/features/docs/types";

// project-visibility-fe S-002 — picker visibility badges + the server-derived new-doc access hint +
// the doc-card absent-name regression guard. Client + sonner MOCKED (happy-dom; no live backend).
// Covers: a Private/Public badge on every new-doc AND move/copy picker option (AS-007), the new-doc
// hint that DISPLAYS the option's server `newDocAccess` incl. the default-project carve-out — never
// re-derived (AS-008 / C-001), and the doc card omitting an absent project name (AS-009, a regression
// assertion on the EXISTING truthy guard, no new suppression code). Pixel/responsive [→MANUAL].

const env = (body: unknown) => ({ data: { success: true, data: body }, error: null });

mock.module("sonner", () => ({
  toast: Object.assign(mock(() => {}), { success: mock(() => {}), error: mock(() => {}) }),
}));

// The new-doc picker reads the workspace's projects through useProjects → fetchProjects; tests swap
// this list per-case. The full client surface is mocked so this process-global mock.module does not
// under-shadow sibling test files (bun mock.module is process-wide).
let projectsList: ProjectRow[] = [];
const publishDoc = mock(async () => env({ docId: "d1", slug: "new-doc", url: "/d/new-doc" }));
const fetchProjects = mock(async () => env({ projects: projectsList }));
mock.module("@/features/docs/services/client", () => ({
  fetchProjects,
  fetchProjectDocs: mock(async () => env({ docs: [] })),
  fetchWorkspaceDocs: mock(async () => env({ docs: [], projects: [] })),
  createProject: mock(async () => env({})),
  renameProject: mock(async () => env({})),
  setProjectVisibility: mock(async () => env({})),
  archiveProject: mock(async () => env({})),
  unarchiveProject: mock(async () => env({})),
  deleteProject: mock(async () => env({})),
  searchDocs: mock(async () => env({ results: [] })),
  publishDoc,
  moveDoc: mock(async () => env({ docId: "d1", slug: "spec", projectId: "p1" })),
  copyDoc: mock(async () => env({ docId: "d2", slug: "spec-copy", projectId: "p1" })),
  deleteDoc: mock(async () => env({ docId: "d1", slug: "spec", deleted: true })),
}));

const { NewDocDialog } = await import("@/features/docs/components/new-doc-dialog");
const { MoveCopyDialog } = await import("@/features/docs/components/move-copy-dialog");
const { DocCard } = await import("@/features/docs/components/doc-card");

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function NewDocHost() {
  return (
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={["/w/ws-acme/docs"]}>
        <NewDocDialog open onOpenChange={() => {}} workspaceId="ws-acme" />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function MoveHost({ projects, doc }: { projects: ProjectRow[]; doc: DocRow }) {
  return (
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={["/w/ws-acme/docs"]}>
        <MoveCopyDialog open onOpenChange={() => {}} doc={doc} workspaceId="ws-acme" projects={projects} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const proj = (over: Partial<ProjectRow> & Pick<ProjectRow, "id" | "name">): ProjectRow => ({
  isDefault: false,
  archived: false,
  ...over,
});

const docRow: DocRow = {
  id: "d1",
  slug: "spec",
  title: "Spec",
  kind: "markdown",
  version: 1,
  annotationCount: 0,
  authorName: null,
  status: "live",
  generalAccess: "anyone_in_workspace",
  projectId: "px",
};

beforeEach(() => {
  publishDoc.mockClear();
  fetchProjects.mockClear();
  projectsList = [];
});

describe("project-visibility-fe S-002 — picker badges + access hint + absent-name guard", () => {
  it("AS-007: each new-doc project picker option shows a Private/Public visibility badge", async () => {
    projectsList = [
      proj({ id: "p-def", name: "Scratch", isDefault: true, visibility: "private", newDocAccess: "anyone_in_workspace" }),
      proj({ id: "p-pub", name: "Team", visibility: "public", newDocAccess: "anyone_in_workspace" }),
    ];
    render(<NewDocHost />);
    await waitFor(() => expect(screen.getByTestId("new-doc-project")).toHaveTextContent("Scratch"));

    await userEvent.click(screen.getByTestId("new-doc-project"));
    const priv = await screen.findByTestId("project-option-p-def");
    const pub = await screen.findByTestId("project-option-p-pub");
    expect(within(priv).getByText("Private")).toBeInTheDocument();
    expect(within(pub).getByText("Public")).toBeInTheDocument();
  });

  it("AS-007: each move/copy destination option shows a Private/Public visibility badge", () => {
    const projects = [
      proj({ id: "p1", name: "Alpha", visibility: "private" }),
      proj({ id: "p2", name: "Beta", visibility: "public" }),
    ];
    render(<MoveHost projects={projects} doc={docRow} />);

    expect(within(screen.getByTestId("dest-project-p1")).getByText("Private")).toBeInTheDocument();
    expect(within(screen.getByTestId("dest-project-p2")).getByText("Public")).toBeInTheDocument();
  });

  it("AS-008 / C-001: the new-doc hint DISPLAYS the server newDocAccess — default carve-out → workspace, non-default private → private", async () => {
    projectsList = [
      // Default project is a PRIVATE shell, yet the server's carve-out gives its new docs
      // anyone_in_workspace — the hint must DISPLAY that, proving it reads the server value and does
      // not re-derive "private" from `visibility`.
      proj({ id: "p-def", name: "Your docs", isDefault: true, visibility: "private", newDocAccess: "anyone_in_workspace" }),
      proj({ id: "p-priv", name: "Secret", visibility: "private", newDocAccess: "restricted" }),
    ];
    render(<NewDocHost />);

    // Default project preselected (private shell) → carve-out → "visible to your workspace", NOT private.
    await waitFor(() =>
      expect(screen.getByTestId("new-doc-access-hint")).toHaveTextContent(/visible to your workspace/i),
    );
    expect(screen.getByTestId("new-doc-access-hint")).not.toHaveTextContent(/will be private/i);

    // Switch to the non-default private project → server newDocAccess "restricted" → "will be private".
    await userEvent.click(screen.getByTestId("new-doc-project"));
    await userEvent.click(await screen.findByRole("option", { name: /Secret/ }));
    await waitFor(() =>
      expect(screen.getByTestId("new-doc-access-hint")).toHaveTextContent(/will be private/i),
    );
  });

  it("AS-009: the doc card omits an absent project name and still lists the doc (regression guard)", () => {
    // A non-owner's view of a doc in a private project: the server suppressed projectName to absent
    // (project-visibility:AS-026). The existing truthy guard must hide it — no empty chip, no leak.
    const doc = { ...docRow, slug: "plan", title: "Plan", projectName: null } as unknown as DocRow;
    const { container } = render(
      <MemoryRouter>
        <DocCard doc={doc} workspaceId="ws-acme" />
      </MemoryRouter>,
    );

    // The doc still lists normally — its card + title render.
    expect(screen.getByTestId("doc-card-plan")).toBeInTheDocument();
    expect(screen.getByText("Plan")).toBeInTheDocument();
    // No project/author chip leaked: the meta row's `.truncate` spans (project + author) are absent,
    // so there is no empty chip and no placeholder "null".
    expect(container.querySelectorAll(".truncate")).toHaveLength(0);
    expect(screen.queryByText("null")).not.toBeInTheDocument();
  });
});
