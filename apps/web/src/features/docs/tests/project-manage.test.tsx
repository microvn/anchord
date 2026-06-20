import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// workspace-project-ui S-002 — manage a project (rename / archive / unarchive / delete) from a
// per-project ⋯ more-menu. The Eden client wrappers are MOCKED; we assert the menu fires the
// right wrapper, the default project hides Delete (C-002), delete only runs on explicit confirm
// (C-001), a refused non-empty delete surfaces the reason and keeps the project (AS-007), and
// the "Show archived" toggle broadens the browse so an archived project can be unarchived (AS-005).
// Pixel/responsive [→MANUAL].

const env = (body: unknown) => ({ data: { success: true, data: body }, error: null });
// A backend refusal: treaty puts the non-2xx envelope in the `error` slot (toApiError reads
// .value.error.message). Used for the non-empty-delete refusal (AS-007).
const refusal = (message: string) => ({
  data: null,
  error: { status: 409, value: { success: false, error: { code: "CONFLICT", message } } },
});

const toastSuccess = mock(() => {});
const toastError = mock(() => {});
mock.module("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));

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

// The projects list the screen fans out over; tests mutate `projectsActive` / `projectsAll`.
let projectsActive: { id: string; name: string; isDefault: boolean; archived: boolean }[];
let projectsAll: { id: string; name: string; isDefault: boolean; archived: boolean }[];
const docCounts: Record<string, number> = {};

const fetchProjects = mock(async (_w: string, includeArchived = false) =>
  env({ projects: includeArchived ? projectsAll : projectsActive }),
);
const fetchProjectDocs = mock(async (_w: string, id: string) =>
  env({ docs: Array.from({ length: docCounts[id] ?? 0 }, (_, i) => ({ id: `${id}-d${i}` })) }),
);
const renameProject = mock(async () => env({ id: "p-bill", name: "Payments Ops" }));
const archiveProject = mock(async () => env({ id: "p-old", archived: true }));
const unarchiveProject = mock(async () => env({ id: "p-old", archived: false }));
const deleteProject = mock(async () => env({ id: "p-scratch", deleted: true }));

mock.module("@/features/docs/services/client", () => ({
  fetchProjects,
  fetchProjectDocs,
  fetchWorkspaceDocs: mock(async () => env({ docs: [], projects: [] })),
  createProject: mock(async () => env({})),
  searchDocs: mock(async () => env({ results: [] })),
  publishDoc: mock(async () => env({ docId: "d1", slug: "s1", url: "/d/s1" })),
  moveDoc: mock(async () => env({})),
  copyDoc: mock(async () => env({})),
  renameProject,
  archiveProject,
  unarchiveProject,
  deleteProject,
}));

let bootstrap: unknown;
const { ProjectsScreen } = await import("@/features/docs/components/projects-screen");
const { WorkspaceRouteGuard } = await import("@/features/workspaces/components/active-workspace");

function App() {
  bootstrap = env({
    userId: "me",
    activeWorkspaceId: "ws-acme",
    workspaces: [{ id: "ws-acme", name: "Acme", slug: "acme", role: "admin", adminName: "Me" }],
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/w/ws-acme/projects"]}>
        <Routes>
          <Route path="/w/:workspaceId" element={<WorkspaceRouteGuard />}>
            <Route path="projects" element={<ProjectsScreen />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  [renameProject, archiveProject, unarchiveProject, deleteProject, fetchProjects, toastError].forEach(
    (m) => m.mockClear(),
  );
  projectsActive = [
    { id: "p-default", name: "Default", isDefault: true, archived: false },
    { id: "p-bill", name: "Billing", isDefault: false, archived: false },
    { id: "p-scratch", name: "Scratch", isDefault: false, archived: false },
  ];
  projectsAll = [
    ...projectsActive,
    { id: "p-old", name: "Old Specs", isDefault: false, archived: true },
  ];
  docCounts["p-default"] = 0;
  docCounts["p-bill"] = 2; // non-empty
  docCounts["p-scratch"] = 0; // empty
  docCounts["p-old"] = 0;
});

async function openProjectMenu(id: string) {
  await userEvent.click(await screen.findByTestId(`proj-more-${id}`));
}

describe("workspace-project-ui S-002 — manage a project", () => {
  it("AS-003: Rename a project", async () => {
    render(<App />);
    await openProjectMenu("p-bill");
    await userEvent.click(await screen.findByTestId("proj-more-rename"));

    const input = await screen.findByTestId("rename-project-name");
    expect(input).toHaveValue("Billing");
    await userEvent.clear(input);
    await userEvent.type(input, "Payments Ops");
    await userEvent.click(screen.getByTestId("rename-project-submit"));

    await waitFor(() =>
      expect(renameProject).toHaveBeenCalledWith("ws-acme", "p-bill", "Payments Ops"),
    );
  });

  it("AS-004: Archive a project hides it from the default browse", async () => {
    render(<App />);
    // "Old Specs" is archived → not in the default (active-only) browse.
    await screen.findByTestId("proj-card-p-bill");
    expect(screen.queryByTestId("proj-card-p-old")).not.toBeInTheDocument();

    // Archiving "Billing" calls the archive wrapper; the refetched active list drops it.
    archiveProject.mockImplementationOnce(async () => {
      projectsActive = projectsActive.filter((p) => p.id !== "p-bill");
      return env({ id: "p-bill", archived: true });
    });
    await openProjectMenu("p-bill");
    await userEvent.click(await screen.findByTestId("proj-more-archive"));

    await waitFor(() => expect(archiveProject).toHaveBeenCalledWith("ws-acme", "p-bill"));
    await waitFor(() =>
      expect(screen.queryByTestId("proj-card-p-bill")).not.toBeInTheDocument(),
    );
  });

  it("AS-005: Unarchive a project from the archived view", async () => {
    render(<App />);
    await screen.findByTestId("proj-card-p-bill");
    // Hidden until "Show archived" is on.
    expect(screen.queryByTestId("proj-card-p-old")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("show-archived-toggle"));
    const oldCard = await screen.findByTestId("proj-card-p-old");

    unarchiveProject.mockImplementationOnce(async () => {
      projectsAll = projectsAll.map((p) =>
        p.id === "p-old" ? { ...p, archived: false } : p,
      );
      projectsActive = [...projectsActive, { id: "p-old", name: "Old Specs", isDefault: false, archived: false }];
      return env({ id: "p-old", archived: false });
    });
    await userEvent.click(within(oldCard).getByTestId("proj-more-p-old"));
    await userEvent.click(await screen.findByTestId("proj-more-unarchive"));

    await waitFor(() => expect(unarchiveProject).toHaveBeenCalledWith("ws-acme", "p-old"));
    // It is now in the browse without the archived badge.
    await waitFor(() =>
      expect(screen.queryByTestId("proj-archived-p-old")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("proj-card-p-old")).toBeInTheDocument();
  });

  it("AS-006: Delete an empty project after confirming (C-001: confirm fires the mutation)", async () => {
    render(<App />);
    await openProjectMenu("p-scratch");
    // Opening Delete shows the confirm dialog — it does NOT delete on its own.
    await userEvent.click(await screen.findByTestId("proj-more-delete"));
    expect(deleteProject).not.toHaveBeenCalled();

    deleteProject.mockImplementationOnce(async () => {
      projectsActive = projectsActive.filter((p) => p.id !== "p-scratch");
      return env({ id: "p-scratch", deleted: true });
    });
    await userEvent.click(await screen.findByTestId("proj-delete-confirm"));

    await waitFor(() => expect(deleteProject).toHaveBeenCalledWith("ws-acme", "p-scratch"));
    await waitFor(() =>
      expect(screen.queryByTestId("proj-card-p-scratch")).not.toBeInTheDocument(),
    );
  });

  it("C-001: cancelling the delete confirm leaves the project unchanged", async () => {
    render(<App />);
    await openProjectMenu("p-scratch");
    await userEvent.click(await screen.findByTestId("proj-more-delete"));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(deleteProject).not.toHaveBeenCalled();
    expect(screen.getByTestId("proj-card-p-scratch")).toBeInTheDocument();
  });

  it("AS-007: the default project offers no Delete control (C-002)", async () => {
    render(<App />);
    await openProjectMenu("p-default");
    // Rename + Archive present, but NO Delete item on the default project.
    expect(await screen.findByTestId("proj-more-rename")).toBeInTheDocument();
    expect(screen.queryByTestId("proj-more-delete")).not.toBeInTheDocument();
  });

  it("AS-007: a non-empty delete is refused with a reason and the project stays (C-002)", async () => {
    render(<App />);
    deleteProject.mockImplementationOnce(async () =>
      refusal("Project still has docs — move or delete them first."),
    );
    await openProjectMenu("p-bill");
    await userEvent.click(await screen.findByTestId("proj-more-delete"));
    await userEvent.click(await screen.findByTestId("proj-delete-confirm"));

    await waitFor(() => expect(deleteProject).toHaveBeenCalledWith("ws-acme", "p-bill"));
    // The reason surfaces (toast.error) and the project remains in the browse.
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Project still has docs — move or delete them first."),
    );
    expect(screen.getByTestId("proj-card-p-bill")).toBeInTheDocument();
  });
});

describe("workspace-project-ui S-008 — projects list pagination", () => {
  it("AS-024: 30 projects show the first 20 with a numbered control; page 2 shows the remaining 10", async () => {
    // 30 accessible projects → 2 pages of 20 + 10.
    projectsActive = Array.from({ length: 30 }, (_, i) => ({
      id: `proj-${i + 1}`,
      name: `Project ${i + 1}`,
      isDefault: i === 0,
      archived: false,
    }));
    projectsAll = projectsActive;
    const user = userEvent.setup();

    render(<App />);
    // Page 1: projects 1..20, not 21.
    expect(await screen.findByTestId("proj-card-proj-1")).toBeInTheDocument();
    expect(screen.getByTestId("proj-card-proj-20")).toBeInTheDocument();
    expect(screen.queryByTestId("proj-card-proj-21")).not.toBeInTheDocument();
    // 2-page numbered control (30 / 20), never 3.
    expect(screen.getByTestId("pagination")).toBeInTheDocument();
    expect(screen.getByTestId("pagination-page-2")).toBeInTheDocument();
    expect(screen.queryByTestId("pagination-page-3")).not.toBeInTheDocument();

    // Page 2: the remaining 10 (21..30), and Next is disabled (last page).
    await user.click(screen.getByTestId("pagination-page-2"));
    expect(await screen.findByTestId("proj-card-proj-30")).toBeInTheDocument();
    expect(screen.getByTestId("proj-card-proj-21")).toBeInTheDocument();
    expect(screen.queryByTestId("proj-card-proj-20")).not.toBeInTheDocument();
    expect(screen.getByTestId("pagination-next")).toBeDisabled();
  });
});
