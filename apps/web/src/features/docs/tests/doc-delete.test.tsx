import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// doc-delete-trash S-001 — delete a doc into Trash from the ⋯ menu. The Eden client `deleteDoc`
// wrapper is MOCKED; we assert that:
//   AS-001 — a permitted caller (canDelete) sees the Delete item, confirming the dialog calls
//            deleteDoc(workspaceId, slug) and toasts success; the warning names the annotations.
//   AS-004 — a commenter (canDelete=false) is NOT offered the Delete item in the ⋯ menu.
// Pixel/responsive [→MANUAL].

const env = (body: unknown) => ({ data: { success: true, data: body }, error: null });

const deleteDoc = mock(async () => env({ docId: "d1", slug: "auth-spec", deleted: true }));
mock.module("@/features/docs/services/client", () => ({
  deleteDoc,
  moveDoc: mock(async () => env({})),
  copyDoc: mock(async () => env({})),
  fetchProjects: mock(async () => env({ projects: [] })),
  fetchProjectDocs: mock(async () => env({ docs: [] })),
  fetchWorkspaceDocs: mock(async () => env({ docs: [], projects: [] })),
  createProject: mock(async () => env({})),
  searchDocs: mock(async () => env({ results: [] })),
  publishDoc: mock(async () => env({ docId: "d1", slug: "s1", url: "/d/s1" })),
}));

const toastSuccess = mock(() => {});
const toastError = mock(() => {});
mock.module("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));

const { DocCard } = await import("@/features/docs/components/doc-card");
import type { DocRow, ProjectRow } from "@/features/docs/types";

const WORKSPACE = "ws-acme";
const PROJECTS: ProjectRow[] = [
  { id: "p-bill", name: "Billing", isDefault: true, archived: false },
];
const DOC: DocRow = {
  id: "d1",
  slug: "auth-spec",
  title: "Auth Spec",
  kind: "markdown",
  version: 1,
  annotationCount: 8,
  authorName: "Mai",
  status: "draft",
  projectId: "p-bill",
  projectName: "Billing",
};

function renderCard(canDelete: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DocCard doc={DOC} workspaceId={WORKSPACE} projects={PROJECTS} canDelete={canDelete} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  deleteDoc.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
});

describe("doc-delete-trash S-001 — delete a doc into Trash", () => {
  it("AS-001: a permitted caller deletes via the ⋯ menu → deleteDoc called, success toast", async () => {
    renderCard(true);
    await userEvent.click(screen.getByTestId("doc-more-auth-spec"));
    // The Delete item is offered to a permitted caller.
    await userEvent.click(await screen.findByTestId("doc-more-delete-auth-spec"));

    // The confirm dialog warns that the doc + its 8 annotations move to Trash and can be restored.
    const confirm = await screen.findByTestId("doc-delete-confirm");
    expect(document.body).toHaveTextContent(/8 annotations move to Trash and can be restored/i);

    await userEvent.click(confirm);

    await waitFor(() => expect(deleteDoc).toHaveBeenCalledWith(WORKSPACE, "auth-spec"));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
  });

  it("AS-004: a commenter (canDelete=false) is NOT offered the Delete item", async () => {
    renderCard(false);
    await userEvent.click(screen.getByTestId("doc-more-auth-spec"));
    // Share / Move / Copy are present, but no Delete item.
    expect(await screen.findByTestId("doc-more-share-auth-spec")).toBeInTheDocument();
    expect(screen.queryByTestId("doc-more-delete-auth-spec")).toBeNull();
    expect(deleteDoc).not.toHaveBeenCalled();
  });
});
