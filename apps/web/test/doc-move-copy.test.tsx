import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// workspace-project-ui S-001 — move/copy a doc between projects. The Eden client wrappers
// (moveDoc/copyDoc) are MOCKED; we assert the ⋯ kebab opens a menu (Share · Move · Copy — refactored
// by sharing-permissions-ui S-001 / AS-019 from a direct dialog open), choosing Move/Copy opens the
// MoveCopyDialog at the right mode, project pick → confirm calls the right wrapper with
// (workspaceId, slug, targetProjectId), that the destination list offers ONLY this workspace's
// projects (C-003), and that move vs copy carry their distinct intent. Pixel/responsive [→MANUAL].

const env = (body: unknown) => ({ data: { success: true, data: body }, error: null });

const moveDoc = mock(async () => env({ docId: "d1", slug: "auth-spec", projectId: "p-pay" }));
const copyDoc = mock(async () => env({ docId: "d2", slug: "auth-spec-copy", projectId: "p-pay" }));
mock.module("../src/features/docs/client", () => ({
  moveDoc,
  copyDoc,
  fetchProjects: mock(async () => env({ projects: [] })),
  fetchProjectDocs: mock(async () => env({ docs: [] })),
  createProject: mock(async () => env({})),
  searchDocs: mock(async () => env({ results: [] })),
  publishDoc: mock(async () => env({ docId: "d1", slug: "s1", url: "/d/s1" })),
}));

// Stub the toast so a missing Toaster host doesn't error under happy-dom.
mock.module("sonner", () => ({ toast: { success: mock(() => {}), error: mock(() => {}) } }));

const { DocCard } = await import("../src/features/docs/doc-card");
const { DocList } = await import("../src/features/docs/doc-list");
import type { DocRow, ProjectRow } from "../src/features/docs/types";

const WORKSPACE = "ws-acme";
const PROJECTS: ProjectRow[] = [
  { id: "p-bill", name: "Billing", isDefault: true, archived: false },
  { id: "p-pay", name: "Payments", isDefault: false, archived: false },
];
const DOC: DocRow = {
  id: "d1",
  slug: "auth-spec",
  title: "Auth Spec",
  kind: "markdown",
  version: 1,
  commentCount: 0,
  authorName: "Me",
  status: "draft",
  projectId: "p-bill",
  projectName: "Billing",
};

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DocCard doc={DOC} workspaceId={WORKSPACE} projects={PROJECTS} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  moveDoc.mockClear();
  copyDoc.mockClear();
});

describe("workspace-project-ui S-001 — move / copy a doc between projects", () => {
  it("AS-001: Move a doc to another project", async () => {
    renderCard();
    // The ⋯ kebab opens a menu; choosing Move opens the MoveCopy dialog at the Move mode.
    await userEvent.click(screen.getByTestId("doc-more-auth-spec"));
    await userEvent.click(await screen.findByTestId("doc-more-move-auth-spec"));

    // Move|Copy toggle defaults to Move; the helper line reflects move intent.
    const dialog = await screen.findByTestId("move-copy-dialog");
    expect(dialog).toHaveTextContent(/leaves its current project/i);

    // Pick "Payments" as the destination, then confirm Move.
    await userEvent.click(await screen.findByTestId("dest-project-p-pay"));
    await userEvent.click(screen.getByTestId("move-copy-confirm"));

    await waitFor(() =>
      expect(moveDoc).toHaveBeenCalledWith(WORKSPACE, "auth-spec", "p-pay"),
    );
    expect(copyDoc).not.toHaveBeenCalled();
  });

  it("AS-002: Copy a doc to another project", async () => {
    renderCard();
    // Choose Copy from the ⋯ menu — the dialog opens at the Copy mode.
    await userEvent.click(screen.getByTestId("doc-more-auth-spec"));
    await userEvent.click(await screen.findByTestId("doc-more-copy-auth-spec"));
    await screen.findByTestId("move-copy-dialog");

    // The dialog opens in Copy mode; the helper line reflects copy intent.
    expect(screen.getByTestId("move-copy-dialog")).toHaveTextContent(
      /duplicate is created; the original stays/i,
    );

    await userEvent.click(await screen.findByTestId("dest-project-p-pay"));
    await userEvent.click(screen.getByTestId("move-copy-confirm"));

    await waitFor(() =>
      expect(copyDoc).toHaveBeenCalledWith(WORKSPACE, "auth-spec", "p-pay"),
    );
    // Copy must NOT relocate the original.
    expect(moveDoc).not.toHaveBeenCalled();
  });

  it("C-003: the destination list offers only this workspace's projects", async () => {
    renderCard();
    await userEvent.click(screen.getByTestId("doc-more-auth-spec"));
    await userEvent.click(await screen.findByTestId("doc-more-move-auth-spec"));
    await screen.findByTestId("move-copy-dialog");

    // Exactly the two workspace projects are offered — nothing more.
    expect(screen.getByTestId("dest-project-p-bill")).toBeInTheDocument();
    expect(screen.getByTestId("dest-project-p-pay")).toBeInTheDocument();
    const options = screen.getAllByTestId(/^dest-project-/);
    expect(options).toHaveLength(PROJECTS.length);
  });

  it("AS-001: the DocList row also exposes the move/copy kebab", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <DocList docs={[DOC]} workspaceId={WORKSPACE} projects={PROJECTS} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByTestId("doc-more-auth-spec"));
    await userEvent.click(await screen.findByTestId("doc-more-move-auth-spec"));
    await screen.findByTestId("move-copy-dialog");
    await userEvent.click(await screen.findByTestId("dest-project-p-pay"));
    await userEvent.click(screen.getByTestId("move-copy-confirm"));
    await waitFor(() =>
      expect(moveDoc).toHaveBeenCalledWith(WORKSPACE, "auth-spec", "p-pay"),
    );
  });
});
