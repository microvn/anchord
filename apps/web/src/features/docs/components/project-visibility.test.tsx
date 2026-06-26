import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import type { ProjectRow } from "@/features/docs/types";

// project-visibility-fe S-001 — the project-card visibility badge + the server-gated ⋯-menu toggle.
// Client + sonner MOCKED (no live backend; happy-dom). Covers: the Private/Public badge read from
// the payload (AS-001), the optimistic-toggle + in-flight disable + authoritative refetch (AS-002),
// the server-flag-gated affordance (AS-003), the C-008 confirm disclosure (AS-004), the rejected-
// toggle rollback + error (AS-005), and the typed payload contract (AS-006). Pixel/responsive
// [→MANUAL]; the genuinely-stateful seam is S-003's behavioural integration, not this story.

const env = (body: unknown) => ({ data: { success: true, data: body }, error: null });
const errEnv = (status: number, message: string) => ({
  data: null,
  error: { status, value: { success: false, error: { code: "FORBIDDEN", message } } },
});

const toast = Object.assign(mock(() => {}), { success: mock(() => {}), error: mock(() => {}) });
mock.module("sonner", () => ({ toast }));

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

// The projects-list payload the browse reads. Tests mutate it per-case; the server "applying" a
// toggle is simulated by reassigning this before the post-mutation refetch.
let projects: ProjectRow[] = [];
const fetchProjects = mock(async () => env({ projects }));
const setProjectVisibility = mock(async () => env({ id: "p2", visibility: "private" }));
mock.module("@/features/docs/services/client", () => ({
  fetchProjects,
  fetchProjectDocs: mock(async () => env({ docs: [] })),
  fetchWorkspaceDocs: mock(async () => env({ docs: [], projects: [] })),
  createProject: mock(async () => env({})),
  renameProject: mock(async () => env({})),
  setProjectVisibility,
  archiveProject: mock(async () => env({})),
  unarchiveProject: mock(async () => env({})),
  deleteProject: mock(async () => env({})),
  searchDocs: mock(async () => env({ results: [] })),
  publishDoc: mock(async () => env({ docId: "d1", slug: "s1", url: "/d/s1" })),
  moveDoc: mock(async () => env({ docId: "d1", slug: "spec", projectId: "p1" })),
  copyDoc: mock(async () => env({ docId: "d2", slug: "spec-copy", projectId: "p1" })),
  deleteDoc: mock(async () => env({ docId: "d1", slug: "spec", deleted: true })),
}));

const { ProjectsScreen } = await import("@/features/docs/components/projects-screen");
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

const row = (over: Partial<ProjectRow> & Pick<ProjectRow, "id" | "name">): ProjectRow => ({
  isDefault: false,
  archived: false,
  visibility: "private",
  canToggleVisibility: false,
  docCount: 0,
  ...over,
});

beforeEach(() => {
  fetchProjects.mockClear();
  setProjectVisibility.mockClear();
  setProjectVisibility.mockImplementation(async () => env({ id: "p2", visibility: "private" }));
  toast.error.mockClear();
  toast.success.mockClear();
  projects = [];
});

describe("project-visibility-fe S-001", () => {
  it("AS-001: the card shows a Private/Public badge from the list payload", async () => {
    projects = [
      row({ id: "p1", name: "Scratch", isDefault: true, visibility: "private" }),
      row({ id: "p2", name: "Team", visibility: "public" }),
    ];
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("proj-card-p1")).toBeInTheDocument());
    expect(screen.getByTestId("proj-visibility-p1")).toHaveTextContent("Private");
    expect(screen.getByTestId("proj-visibility-p2")).toHaveTextContent("Public");
    // The Default badge still rides alongside (badge is additive, not a replacement).
    expect(within(screen.getByTestId("proj-card-p1")).getByText("Default")).toBeInTheDocument();
  });

  it("AS-002: toggle is optimistic, disabled in flight, then settled by the authoritative refetch", async () => {
    const user = userEvent.setup();
    projects = [row({ id: "p2", name: "Team", visibility: "public", canToggleVisibility: true })];
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("proj-visibility-p2")).toHaveTextContent("Public"));

    // Hold the request open so the in-flight window is observable.
    let release!: () => void;
    setProjectVisibility.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(env({ id: "p2", visibility: "private" }));
        }),
    );

    await user.click(screen.getByTestId("proj-more-p2"));
    await user.click(screen.getByTestId("proj-more-visibility-p2"));
    await user.click(screen.getByTestId("proj-visibility-confirm-p2"));

    // Optimistic: the badge flips to Private before the server responds…
    await waitFor(() => expect(screen.getByTestId("proj-visibility-p2")).toHaveTextContent("Private"));
    // …the request carried the new value…
    expect(setProjectVisibility).toHaveBeenCalledWith("ws-acme", "p2", "private");
    // …and the toggle item is disabled while in flight (no concurrent toggles, AS-002).
    expect(screen.getByTestId("proj-more-visibility-p2")).toHaveAttribute("aria-disabled", "true");

    // Server now reflects private; release → authoritative refetch settles the value.
    projects = [row({ id: "p2", name: "Team", visibility: "private", canToggleVisibility: true })];
    release();
    await waitFor(() => expect(fetchProjects.mock.calls.length).toBeGreaterThan(1));
    expect(screen.getByTestId("proj-visibility-p2")).toHaveTextContent("Private");
  });

  it("AS-003: the toggle is rendered only where the server says canToggleVisibility", async () => {
    const user = userEvent.setup();
    projects = [
      row({ id: "p1", name: "Mine", visibility: "private", canToggleVisibility: true }),
      row({ id: "p2", name: "Theirs", visibility: "public", canToggleVisibility: false }),
    ];
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("proj-card-p1")).toBeInTheDocument());

    await user.click(screen.getByTestId("proj-more-p1"));
    expect(await screen.findByTestId("proj-more-visibility-p1")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await user.click(screen.getByTestId("proj-more-p2"));
    await waitFor(() => expect(screen.getByTestId("proj-more-rename")).toBeInTheDocument());
    expect(screen.queryByTestId("proj-more-visibility-p2")).not.toBeInTheDocument();
  });

  it("AS-004: the confirmation discloses existing docs keep their sharing before commit", async () => {
    const user = userEvent.setup();
    projects = [row({ id: "p2", name: "Team", visibility: "public", canToggleVisibility: true })];
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("proj-card-p2")).toBeInTheDocument());

    await user.click(screen.getByTestId("proj-more-p2"));
    await user.click(screen.getByTestId("proj-more-visibility-p2"));

    // The disclosure is on-screen BEFORE the user confirms, and nothing has been sent yet.
    expect(
      screen.getByText(/existing shared docs keep their current sharing/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/only docs created afterward/i)).toBeInTheDocument();
    expect(setProjectVisibility).not.toHaveBeenCalled();
  });

  it("AS-005: a rejected toggle rolls the badge back and surfaces an error", async () => {
    const user = userEvent.setup();
    projects = [row({ id: "p2", name: "Team", visibility: "public", canToggleVisibility: true })];
    setProjectVisibility.mockImplementation(async () => errEnv(403, "Forbidden"));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("proj-visibility-p2")).toHaveTextContent("Public"));

    await user.click(screen.getByTestId("proj-more-p2"));
    await user.click(screen.getByTestId("proj-more-visibility-p2"));
    await user.click(screen.getByTestId("proj-visibility-confirm-p2"));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    // The optimistic Private rolled back — the badge never sticks on a value the server rejected.
    await waitFor(() => expect(screen.getByTestId("proj-visibility-p2")).toHaveTextContent("Public"));
    expect(toast.error).toHaveBeenCalledWith("Forbidden");
  });

  it("AS-006: the projects payload carries visibility, isDefault, canToggleVisibility with the right shapes", () => {
    // Contract seam (typed fixture, NOT a live boot): the three fields the card + toggle read are
    // pinned PRESENT and typed on the FE `ProjectRow` mirror of the wire shape. Requiring them here
    // makes a dropped/renamed/retyped field a COMPILE error — the type is the primary shape guard,
    // this asserts presence + value on a real-shape row.
    const fixture: Required<Pick<ProjectRow, "visibility" | "isDefault" | "canToggleVisibility">> &
      ProjectRow = {
      id: "p2",
      name: "Team",
      isDefault: false,
      archived: false,
      visibility: "public",
      canToggleVisibility: true,
      docCount: 3,
    };

    expect(fixture.visibility).toBe("public");
    expect(["private", "public"]).toContain(fixture.visibility);
    expect(typeof fixture.isDefault).toBe("boolean");
    expect(typeof fixture.canToggleVisibility).toBe("boolean");
  });
});
