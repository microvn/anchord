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
// An Eden non-2xx result: treaty hands the parsed envelope body at `.error.value`. The backend
// stamps `reason` on a CONFLICT so the FE branches on it, never on the bare 409 status (C-002).
const errEnv = (status: number, code: string, message: string, reason?: string) => ({
  data: null,
  error: { status, value: { success: false, error: { code, message, ...(reason ? { reason } : {}) } } },
});

const moveDoc = mock(async () => env({ docId: "d1", slug: "auth-spec", projectId: "p-pay" }));
const copyDoc = mock(async () => env({ docId: "d2", slug: "auth-spec-copy", projectId: "p-pay" }));
// project-visibility-fe S-003 / AS-014: the post-boundary-move reconcile reads the doc's ACTUAL
// resulting access from this workspace-docs refetch. Overridden per-test to drive the reconcile.
const fetchWorkspaceDocs = mock(async () => env({ docs: [], projects: [] }));
mock.module("@/features/docs/services/client", () => ({
  moveDoc,
  copyDoc,
  deleteDoc: mock(async () => env({ docId: "d1", slug: "auth-spec", deleted: true })),
  fetchProjects: mock(async () => env({ projects: [] })),
  fetchProjectDocs: mock(async () => env({ docs: [] })),
  fetchWorkspaceDocs,
  createProject: mock(async () => env({})),
  setProjectVisibility: mock(async () => env({})),
  searchDocs: mock(async () => env({ results: [] })),
  publishDoc: mock(async () => env({ docId: "d1", slug: "s1", url: "/d/s1" })),
}));

// Stub the toast so a missing Toaster host doesn't error under happy-dom. `toastSuccess` is kept so
// AS-012/AS-014 can assert what the move confirmation claims (a true "private" vs the reconciled
// "still shared").
const toastSuccess = mock((_msg?: string) => {});
mock.module("sonner", () => ({ toast: { success: toastSuccess, error: mock(() => {}) } }));

const { DocCard } = await import("@/features/docs/components/doc-card");
const { DocList } = await import("@/features/docs/components/doc-list");
import type { DocRow, ProjectRow } from "@/features/docs/types";

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
  annotationCount: 0,
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
  fetchWorkspaceDocs.mockClear();
  toastSuccess.mockClear();
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

// project-visibility-fe S-003 / C-002 — the doc-move visibility-boundary alert, keyed on the
// server's `reason === "visibility_boundary"` discriminator (never a bare 409), with every retry
// outcome handled: make-private success, no-longer-crossing reconcile, terminal failure. The FE
// never computes the boundary itself (C-001) — it keys purely on `reason` and reconciles the actual
// resulting access from a refetch. The client wrappers are MOCKED here (the real-contract roundtrip
// is the AS-015 seam test); these assert the FE consumer behaviour around the discriminator.

const BOUNDARY = () =>
  errEnv(409, "CONFLICT", "this move crosses a visibility boundary", "visibility_boundary");

/** Open the ⋯ menu → Move, pick the Payments target, and confirm the move. */
async function startMove() {
  renderCard();
  await userEvent.click(screen.getByTestId("doc-more-auth-spec"));
  await userEvent.click(await screen.findByTestId("doc-more-move-auth-spec"));
  await screen.findByTestId("move-copy-dialog");
  await userEvent.click(await screen.findByTestId("dest-project-p-pay"));
  await userEvent.click(screen.getByTestId("move-copy-confirm"));
}

describe("project-visibility-fe S-003 — doc-move visibility-boundary alert + retry outcomes", () => {
  it("AS-010: a visibility_boundary refusal opens the alert; Cancel sends nothing", async () => {
    moveDoc.mockImplementationOnce(async () => BOUNDARY());
    await startMove();

    // The alert opens, keyed on the server reason discriminator.
    await screen.findByTestId("visibility-boundary-alert");
    expect(moveDoc).toHaveBeenCalledTimes(1);

    // Cancel sends no further request and leaves the doc + sharing unchanged.
    await userEvent.click(screen.getByTestId("boundary-cancel"));
    await waitFor(() =>
      expect(screen.queryByTestId("visibility-boundary-alert")).toBeNull(),
    );
    expect(moveDoc).toHaveBeenCalledTimes(1); // nothing sent on Cancel
  });

  it("AS-011: a non-boundary conflict does NOT open the alert; a generic error is surfaced", async () => {
    // A 409 whose `reason` is NOT visibility_boundary — the trigger is the discriminator, not status.
    moveDoc.mockImplementationOnce(async () =>
      errEnv(409, "CONFLICT", "some other conflict"),
    );
    await startMove();

    await screen.findByTestId("move-copy-error");
    expect(screen.queryByTestId("visibility-boundary-alert")).toBeNull();
  });

  it("AS-012: choosing make-private retries with the choice and confirms the doc is now private", async () => {
    moveDoc.mockImplementationOnce(async () => BOUNDARY());
    moveDoc.mockImplementationOnce(async () =>
      env({ docId: "d1", slug: "auth-spec", projectId: "p-pay" }),
    );
    // Reconcile refetch reports the doc as restricted (private) — the actual server outcome.
    fetchWorkspaceDocs.mockImplementationOnce(async () =>
      env({ docs: [{ slug: "auth-spec", generalAccess: "restricted" }], projects: [] }),
    );
    await startMove();

    await userEvent.click(await screen.findByTestId("boundary-make-private"));

    await waitFor(() =>
      expect(moveDoc).toHaveBeenLastCalledWith(WORKSPACE, "auth-spec", "p-pay", "make_private"),
    );
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/private/i)),
    );
  });

  it("AS-013: a retry that fails terminally closes the alert with an error, no loop", async () => {
    moveDoc.mockImplementationOnce(async () => BOUNDARY());
    // Between refusal and choice the target became unviewable → the retry 404s.
    moveDoc.mockImplementationOnce(async () => errEnv(404, "NOT_FOUND", "target gone"));
    await startMove();

    await userEvent.click(await screen.findByTestId("boundary-make-private"));

    // The error is surfaced, the alert is dismissed, and it does NOT silently re-arm or loop.
    await screen.findByTestId("move-copy-error");
    await waitFor(() =>
      expect(screen.queryByTestId("visibility-boundary-alert")).toBeNull(),
    );
    expect(moveDoc).toHaveBeenCalledTimes(2); // initial + one retry, never a third
  });

  it("AS-014: a retry that no longer crosses reconciles the real access, never a false 'private'", async () => {
    moveDoc.mockImplementationOnce(async () => BOUNDARY());
    // The target was flipped PUBLIC before the retry → the server applied a plain move (200), WITHOUT
    // making the doc private. The response shape is identical, so only the refetch reveals the truth.
    moveDoc.mockImplementationOnce(async () =>
      env({ docId: "d1", slug: "auth-spec", projectId: "p-pay" }),
    );
    fetchWorkspaceDocs.mockImplementationOnce(async () =>
      env({ docs: [{ slug: "auth-spec", generalAccess: "anyone_in_workspace" }], projects: [] }),
    );
    await startMove();

    await userEvent.click(await screen.findByTestId("boundary-make-private"));

    await waitFor(() => expect(fetchWorkspaceDocs).toHaveBeenCalled());
    // The confirmation reflects the ACTUAL (still-shared) outcome, never a false "now private".
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/still shared/i)),
    );
    expect(toastSuccess).not.toHaveBeenCalledWith(expect.stringMatching(/private/i));
  });
});
