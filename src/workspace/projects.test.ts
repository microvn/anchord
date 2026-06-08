import { test, expect, describe } from "bun:test";
import {
  createProject,
  ensureDefaultProject,
  listProjects,
  renameProject,
  archiveProject,
  unarchiveProject,
  deleteProject,
  canBrowseDoc,
  filterBrowsableDocs,
  ProjectRejected,
  MAX_PROJECT_NAME_LENGTH,
  type ProjectRepo,
  type ProjectRow,
  type BrowseDoc,
} from "./projects";

// workspace-project S-003: UNIT tests of the project service LOGIC against an
// in-memory fake ProjectRepo (mirrors setup.test.ts). The real Drizzle glue is
// integration-verified in test/integration/projects.itest.ts.

const WS = "ws_1";

function fakeRepo(seed: ProjectRow[] = []) {
  let n = seed.length;
  const state: { projects: ProjectRow[]; docCounts: Map<string, number> } = {
    projects: [...seed],
    docCounts: new Map(),
  };
  const repo: ProjectRepo = {
    async insert(input) {
      const row: ProjectRow = {
        id: `p_${++n}`,
        workspaceId: input.workspaceId,
        name: input.name,
        ownerId: input.ownerId,
        isDefault: input.isDefault,
        archivedAt: null,
      };
      state.projects.push(row);
      return row;
    },
    async findById(workspaceId, projectId) {
      return (
        state.projects.find((p) => p.workspaceId === workspaceId && p.id === projectId) ?? null
      );
    },
    async findDefaultFor(workspaceId, ownerId) {
      return (
        state.projects.find(
          (p) => p.workspaceId === workspaceId && p.ownerId === ownerId && p.isDefault,
        ) ?? null
      );
    },
    async listActive(workspaceId) {
      return state.projects.filter((p) => p.workspaceId === workspaceId && p.archivedAt == null);
    },
    async listAll(workspaceId) {
      return state.projects.filter((p) => p.workspaceId === workspaceId);
    },
    async setName(projectId, name) {
      const p = state.projects.find((x) => x.id === projectId);
      if (p) p.name = name;
    },
    async setArchivedAt(projectId, archivedAt) {
      const p = state.projects.find((x) => x.id === projectId);
      if (p) p.archivedAt = archivedAt;
    },
    async countDocs(projectId) {
      return state.docCounts.get(projectId) ?? 0;
    },
    async delete(projectId) {
      state.projects = state.projects.filter((p) => p.id !== projectId);
    },
  };
  return { repo, state };
}

describe("project service (workspace-project S-003)", () => {
  test("AS-005: a member creates a project and is its owner", async () => {
    const f = fakeRepo();
    const p = await createProject({ workspaceId: WS, name: "Billing", ownerId: "u_a" }, { repo: f.repo });
    expect(p.name).toBe("Billing");
    expect(p.ownerId).toBe("u_a");
    expect(p.isDefault).toBe(false);
    expect(p.workspaceId).toBe(WS);
    expect(f.state.projects).toHaveLength(1);
  });

  test("C-002: any member may create a project (no admin gate in the service)", async () => {
    // The service takes no admin flag for create — a plain member id creates fine.
    const f = fakeRepo();
    const p = await createProject({ workspaceId: WS, name: "Payments", ownerId: "u_member" }, { repo: f.repo });
    expect(p.ownerId).toBe("u_member");
  });

  test("AS-005: create rejects an empty / whitespace name (Zod-equivalent guard)", async () => {
    const f = fakeRepo();
    await expect(
      createProject({ workspaceId: WS, name: "   ", ownerId: "u_a" }, { repo: f.repo }),
    ).rejects.toMatchObject({ code: "invalid_name" });
  });

  test("AS-005: create rejects an over-long name (boundary)", async () => {
    const f = fakeRepo();
    const tooLong = "x".repeat(MAX_PROJECT_NAME_LENGTH + 1);
    await expect(
      createProject({ workspaceId: WS, name: tooLong, ownerId: "u_a" }, { repo: f.repo }),
    ).rejects.toMatchObject({ code: "invalid_name" });
  });

  test("AS-014/C-009: ensureDefaultProject creates '<name>\\'s docs' (is_default=true)", async () => {
    const f = fakeRepo();
    const p = await ensureDefaultProject(
      { workspaceId: WS, ownerId: "u_a", userName: "Alice" },
      { repo: f.repo },
    );
    expect(p.name).toBe("Alice's docs");
    expect(p.isDefault).toBe(true);
    expect(p.ownerId).toBe("u_a");
  });

  test("AS-014/C-009: ensureDefaultProject is idempotent — re-firing yields the SAME project", async () => {
    const f = fakeRepo();
    const first = await ensureDefaultProject(
      { workspaceId: WS, ownerId: "u_a", userName: "Alice" },
      { repo: f.repo },
    );
    const second = await ensureDefaultProject(
      { workspaceId: WS, ownerId: "u_a", userName: "Alice" },
      { repo: f.repo },
    );
    expect(second.id).toBe(first.id);
    // Exactly ONE default project for the account.
    expect(f.state.projects.filter((p) => p.isDefault && p.ownerId === "u_a")).toHaveLength(1);
  });

  test("C-009: ensureDefaultProject falls back to 'My' when the user has no name", async () => {
    const f = fakeRepo();
    const p = await ensureDefaultProject(
      { workspaceId: WS, ownerId: "u_a", userName: "  " },
      { repo: f.repo },
    );
    expect(p.name).toBe("My's docs");
  });

  test("AS-007/C-005: listProjects excludes archived by default, includes when asked", async () => {
    const f = fakeRepo();
    const a = await createProject({ workspaceId: WS, name: "Active", ownerId: "u_a" }, { repo: f.repo });
    const b = await createProject({ workspaceId: WS, name: "Gone", ownerId: "u_a" }, { repo: f.repo });
    await archiveProject(
      { workspaceId: WS, projectId: b.id, actorId: "u_a", isAdmin: false },
      { repo: f.repo },
    );

    const active = await listProjects({ workspaceId: WS }, { repo: f.repo });
    expect(active.map((p) => p.id)).toEqual([a.id]);

    const all = await listProjects({ workspaceId: WS, includeArchived: true }, { repo: f.repo });
    expect(all.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("AS-007/C-005: archive then unarchive round-trips archived_at", async () => {
    const f = fakeRepo();
    const p = await createProject({ workspaceId: WS, name: "Billing", ownerId: "u_a" }, { repo: f.repo });
    const archived = await archiveProject(
      { workspaceId: WS, projectId: p.id, actorId: "u_a", isAdmin: false },
      { repo: f.repo },
    );
    expect(archived.archivedAt).toBeInstanceOf(Date);
    const back = await unarchiveProject(
      { workspaceId: WS, projectId: p.id, actorId: "u_a", isAdmin: false },
      { repo: f.repo },
    );
    expect(back.archivedAt).toBeNull();
  });

  test("C-002: a non-owner member cannot archive someone else's project (forbidden)", async () => {
    const f = fakeRepo();
    const p = await createProject({ workspaceId: WS, name: "Billing", ownerId: "u_a" }, { repo: f.repo });
    await expect(
      archiveProject(
        { workspaceId: WS, projectId: p.id, actorId: "u_other", isAdmin: false },
        { repo: f.repo },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  test("C-002: a workspace admin CAN archive another member's project", async () => {
    const f = fakeRepo();
    const p = await createProject({ workspaceId: WS, name: "Billing", ownerId: "u_a" }, { repo: f.repo });
    const archived = await archiveProject(
      { workspaceId: WS, projectId: p.id, actorId: "u_admin", isAdmin: true },
      { repo: f.repo },
    );
    expect(archived.archivedAt).toBeInstanceOf(Date);
  });

  test("C-009: the default project cannot be archived (it is the MCP fallback)", async () => {
    const f = fakeRepo();
    const def = await ensureDefaultProject(
      { workspaceId: WS, ownerId: "u_a", userName: "Alice" },
      { repo: f.repo },
    );
    await expect(
      archiveProject(
        { workspaceId: WS, projectId: def.id, actorId: "u_a", isAdmin: false },
        { repo: f.repo },
      ),
    ).rejects.toMatchObject({ code: "default_protected" });
  });

  test("C-009: the default project cannot be deleted", async () => {
    const f = fakeRepo();
    const def = await ensureDefaultProject(
      { workspaceId: WS, ownerId: "u_a", userName: "Alice" },
      { repo: f.repo },
    );
    await expect(
      deleteProject(
        { workspaceId: WS, projectId: def.id, actorId: "u_a", isAdmin: false },
        { repo: f.repo },
      ),
    ).rejects.toMatchObject({ code: "default_protected" });
  });

  test("delete: a non-empty project is blocked (no silent orphan)", async () => {
    const f = fakeRepo();
    const p = await createProject({ workspaceId: WS, name: "Billing", ownerId: "u_a" }, { repo: f.repo });
    f.state.docCounts.set(p.id, 2);
    await expect(
      deleteProject(
        { workspaceId: WS, projectId: p.id, actorId: "u_a", isAdmin: false },
        { repo: f.repo },
      ),
    ).rejects.toMatchObject({ code: "not_empty" });
    expect(f.state.projects).toHaveLength(1); // still there
  });

  test("delete: an empty non-default project deletes", async () => {
    const f = fakeRepo();
    const p = await createProject({ workspaceId: WS, name: "Empty", ownerId: "u_a" }, { repo: f.repo });
    await deleteProject(
      { workspaceId: WS, projectId: p.id, actorId: "u_a", isAdmin: false },
      { repo: f.repo },
    );
    expect(f.state.projects).toHaveLength(0);
  });

  test("rename: owner renames; the name is trimmed", async () => {
    const f = fakeRepo();
    const p = await createProject({ workspaceId: WS, name: "Old", ownerId: "u_a" }, { repo: f.repo });
    const renamed = await renameProject(
      { workspaceId: WS, projectId: p.id, actorId: "u_a", isAdmin: false, name: "  New  " },
      { repo: f.repo },
    );
    expect(renamed.name).toBe("New");
  });

  test("manage on a missing project → not_found", async () => {
    const f = fakeRepo();
    await expect(
      renameProject(
        { workspaceId: WS, projectId: "nope", actorId: "u_a", isAdmin: true, name: "X" },
        { repo: f.repo },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("browse access filter (workspace-project S-003, C-003/AS-006)", () => {
  const deps = (opts: { invited?: Set<string>; members?: Set<string> }) => ({
    isInvited: (docId: string, userId: string) => !!opts.invited?.has(`${docId}:${userId}`),
    isWorkspaceMember: (userId: string) => !!opts.members?.has(userId),
  });

  test("AS-006: owner sees their own restricted doc", async () => {
    const doc: BrowseDoc = { id: "d1", ownerId: "u_a", generalAccess: "restricted" };
    expect(await canBrowseDoc("u_a", doc, deps({}))).toBe(true);
  });

  test("AS-006: anyone_in_workspace doc is visible to a workspace member", async () => {
    const doc: BrowseDoc = { id: "dB", ownerId: "u_a", generalAccess: "anyone_in_workspace" };
    expect(await canBrowseDoc("u_x", doc, deps({ members: new Set(["u_x"]) }))).toBe(true);
  });

  test("AS-006: a restricted doc the viewer is NOT invited to is hidden", async () => {
    const doc: BrowseDoc = { id: "dA", ownerId: "u_a", generalAccess: "restricted" };
    expect(await canBrowseDoc("u_x", doc, deps({ members: new Set(["u_x"]) }))).toBe(false);
  });

  test("AS-006: a restricted doc the viewer IS invited to is visible", async () => {
    const doc: BrowseDoc = { id: "dA", ownerId: "u_a", generalAccess: "restricted" };
    expect(await canBrowseDoc("u_x", doc, deps({ invited: new Set(["dA:u_x"]) }))).toBe(true);
  });

  test("C-003: anyone_with_link is NOT a browse grant (link is for direct-link holders)", async () => {
    const doc: BrowseDoc = { id: "dL", ownerId: "u_a", generalAccess: "anyone_with_link" };
    // A non-owner, non-invited workspace member does NOT see a link-only doc in browse.
    expect(await canBrowseDoc("u_x", doc, deps({ members: new Set(["u_x"]) }))).toBe(false);
  });

  test("AS-006: filterBrowsableDocs drops the out-of-access doc (existence-hiding)", async () => {
    const docs: BrowseDoc[] = [
      { id: "dA", ownerId: "u_a", generalAccess: "restricted" },
      { id: "dB", ownerId: "u_a", generalAccess: "anyone_in_workspace" },
    ];
    const visible = await filterBrowsableDocs("u_x", docs, deps({ members: new Set(["u_x"]) }));
    expect(visible.map((d) => d.id)).toEqual(["dB"]);
  });

  test("AS-006: empty project → empty list (not an error)", async () => {
    const visible = await filterBrowsableDocs("u_x", [], deps({}));
    expect(visible).toEqual([]);
  });
});
