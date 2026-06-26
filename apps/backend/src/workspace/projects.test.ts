import { test, expect, describe } from "bun:test";
import {
  createProject,
  ensureDefaultProject,
  listProjects,
  renameProject,
  archiveProject,
  unarchiveProject,
  deleteProject,
  setProjectVisibility,
  canViewProject,
  projectNameForViewer,
  deriveNewDocAccess,
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

// project-visibility-cascade S-001: a doc's two-axis share_links state + the docs/invites the fake
// repo models so the cascade's scope can be asserted at the service tier (the bulk-null targets the
// project's docs only, and never doc_members).
interface FakeShareLink {
  docId: string;
  projectId: string;
  workspaceRole: "viewer" | "commenter" | "editor" | null;
  linkRole: "viewer" | "commenter" | "editor" | null;
}
interface FakeDocMember {
  docId: string;
  userId: string;
  role: "viewer" | "commenter" | "editor";
}

function fakeRepo(
  seed: ProjectRow[] = [],
  fixtures: { shareLinks?: FakeShareLink[]; docMembers?: FakeDocMember[] } = {},
) {
  let n = seed.length;
  const state: {
    projects: ProjectRow[];
    docCounts: Map<string, number>;
    shareLinks: FakeShareLink[];
    docMembers: FakeDocMember[];
    cascadeCalls: string[];
  } = {
    projects: [...seed],
    docCounts: new Map(),
    shareLinks: (fixtures.shareLinks ?? []).map((s) => ({ ...s })),
    // doc_members is a SENTINEL: the cascade must never mutate it. Held by value so a deep-equal
    // snapshot proves it untouched (AS-002 / C-001).
    docMembers: (fixtures.docMembers ?? []).map((m) => ({ ...m })),
    cascadeCalls: [],
  };
  const repo: ProjectRepo = {
    async insert(input) {
      const row: ProjectRow = {
        id: `p_${++n}`,
        workspaceId: input.workspaceId,
        name: input.name,
        ownerId: input.ownerId,
        isDefault: input.isDefault,
        visibility: input.visibility,
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
    async setVisibility(projectId, visibility) {
      const p = state.projects.find((x) => x.id === projectId);
      if (p) p.visibility = visibility;
    },
    async setVisibilityPrivateCascade(projectId) {
      state.cascadeCalls.push(projectId);
      const p = state.projects.find((x) => x.id === projectId);
      if (p) p.visibility = "private";
      // Bulk-null BOTH axes for THIS project's docs ONLY (scoped by projectId). doc_members is
      // deliberately NOT touched — modelling the real SQL, which never writes that table.
      for (const sl of state.shareLinks) {
        if (sl.projectId === projectId) {
          sl.workspaceRole = null;
          sl.linkRole = null;
        }
      }
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

  test("AS-001: a user-created project is created with visibility = public (project-visibility S-001)", async () => {
    const f = fakeRepo();
    const p = await createProject({ workspaceId: WS, name: "Vantage", ownerId: "u_a" }, { repo: f.repo });
    expect(p.visibility).toBe("public");
  });

  test("AS-002: the auto default project is private (project-visibility S-001/C-001)", async () => {
    const f = fakeRepo();
    const p = await ensureDefaultProject(
      { workspaceId: WS, ownerId: "u_a", userName: "Ada" },
      { repo: f.repo },
    );
    expect(p.isDefault).toBe(true);
    expect(p.visibility).toBe("private");
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

    const active = await listProjects({ workspaceId: WS, userId: "u_a" }, { repo: f.repo });
    expect(active.map((p) => p.id)).toEqual([a.id]);

    const all = await listProjects({ workspaceId: WS, userId: "u_a", includeArchived: true }, { repo: f.repo });
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
    const doc: BrowseDoc = { id: "d1", ownerId: "u_a", workspaceShared: false };
    expect(await canBrowseDoc("u_a", doc, deps({}))).toBe(true);
  });

  test("AS-006: a workspace-shared doc is visible to a workspace member", async () => {
    const doc: BrowseDoc = { id: "dB", ownerId: "u_a", workspaceShared: true };
    expect(await canBrowseDoc("u_x", doc, deps({ members: new Set(["u_x"]) }))).toBe(true);
  });

  test("AS-006: a restricted doc the viewer is NOT invited to is hidden", async () => {
    const doc: BrowseDoc = { id: "dA", ownerId: "u_a", workspaceShared: false };
    expect(await canBrowseDoc("u_x", doc, deps({ members: new Set(["u_x"]) }))).toBe(false);
  });

  test("AS-006: a restricted doc the viewer IS invited to is visible", async () => {
    const doc: BrowseDoc = { id: "dA", ownerId: "u_a", workspaceShared: false };
    expect(await canBrowseDoc("u_x", doc, deps({ invited: new Set(["dA:u_x"]) }))).toBe(true);
  });

  test("AS-006: filterBrowsableDocs drops the out-of-access doc (existence-hiding)", async () => {
    const docs: BrowseDoc[] = [
      { id: "dA", ownerId: "u_a", workspaceShared: false },
      { id: "dB", ownerId: "u_a", workspaceShared: true },
    ];
    const visible = await filterBrowsableDocs("u_x", docs, deps({ members: new Set(["u_x"]) }));
    expect(visible.map((d) => d.id)).toEqual(["dB"]);
  });

  test("AS-006: empty project → empty list (not an error)", async () => {
    const visible = await filterBrowsableDocs("u_x", [], deps({}));
    expect(visible).toEqual([]);
  });
});

// doc-access-two-axis S-004 — the ONE shared workspace-visibility predicate (C-006). A doc is
// visible in the workspace iff owner OR individually-invited OR `workspace_role IS NOT NULL`
// (workspaceShared) AND a member. The LINK axis is irrelevant — keying on the raw workspace axis
// (not the derived level, which the link axis dominates) is what makes AS-013 correct.
describe("workspace visibility predicate (doc-access-two-axis S-004, C-006)", () => {
  const deps = (opts: { invited?: Set<string>; members?: Set<string> }) => ({
    isInvited: (docId: string, userId: string) => !!opts.invited?.has(`${docId}:${userId}`),
    isWorkspaceMember: (userId: string) => !!opts.members?.has(userId),
  });

  test("AS-012: a workspace-shared doc is listed in every member's dashboard", async () => {
    // workspace_role on (workspaceShared:true) → any workspace member sees it.
    const doc: BrowseDoc = { id: "dWs", ownerId: "u_owner", workspaceShared: true };
    expect(await canBrowseDoc("u_member1", doc, deps({ members: new Set(["u_member1"]) }))).toBe(true);
    expect(await canBrowseDoc("u_member2", doc, deps({ members: new Set(["u_member2"]) }))).toBe(true);
  });

  test("AS-013: turning the link on does NOT remove a workspace-shared doc from the workspace", async () => {
    // The predicate keys on workspaceShared ALONE; the link axis is not an input here. A doc that
    // is workspace=commenter + link=viewer (the derived level would be anyone_with_link, link wins)
    // is STILL workspaceShared:true → still listed for a member. This is the bug the redesign fixes.
    const doc: BrowseDoc = { id: "dWsLink", ownerId: "u_owner", workspaceShared: true };
    expect(await canBrowseDoc("u_member", doc, deps({ members: new Set(["u_member"]) }))).toBe(true);
  });

  test("AS-014: a link-only (workspace off) doc is hidden from a non-invited member, shown to an invited one", async () => {
    // workspace_role null (workspaceShared:false) + link on → NOT a workspace grant.
    const linkOnly: BrowseDoc = { id: "dLink", ownerId: "u_owner", workspaceShared: false };
    // A workspace member who is NOT individually invited does not see it.
    expect(await canBrowseDoc("u_member", linkOnly, deps({ members: new Set(["u_member"]) }))).toBe(false);
    // An individually-invited member DOES see it (the invite grant, independent of either axis).
    expect(
      await canBrowseDoc("u_invited", linkOnly, deps({ members: new Set(["u_invited"]), invited: new Set(["dLink:u_invited"]) })),
    ).toBe(true);
  });

  test("C-006: the link axis is irrelevant — a member of the workspace is not admitted by link alone", async () => {
    // Even a workspace member is denied a link-only doc (only invite/owner/workspace-axis admit in browse).
    const linkOnly: BrowseDoc = { id: "dL", ownerId: "u_owner", workspaceShared: false };
    expect(await canBrowseDoc("u_member", linkOnly, deps({ members: new Set(["u_member"]) }))).toBe(false);
    // A workspace-shared doc, by contrast, IS admitted — proving the decision is the workspace axis.
    const wsShared: BrowseDoc = { id: "dW", ownerId: "u_owner", workspaceShared: true };
    expect(await canBrowseDoc("u_member", wsShared, deps({ members: new Set(["u_member"]) }))).toBe(true);
  });
});

// ── project-visibility S-002: canViewProject + listProjects visibility filter (C-002/C-003) ──
describe("canViewProject + listProjects visibility (project-visibility S-002)", () => {
  const proj = (over: Partial<ProjectRow>): ProjectRow => ({
    id: "p_x",
    workspaceId: WS,
    name: "X",
    ownerId: "u_a",
    isDefault: false,
    visibility: "public",
    archivedAt: null,
    ...over,
  });

  test("C-002: owner sees their own private project; a non-owner does not", () => {
    const priv = proj({ ownerId: "u_a", visibility: "private" });
    expect(canViewProject("u_a", priv)).toBe(true); // owner
    expect(canViewProject("u_b", priv)).toBe(false); // non-owner
  });

  test("C-002: a public project is visible to everyone (owner and non-owner)", () => {
    const pub = proj({ ownerId: "u_a", visibility: "public" });
    expect(canViewProject("u_a", pub)).toBe(true);
    expect(canViewProject("u_b", pub)).toBe(true);
  });

  test("AS-005: listProjects shows A their private project but hides it from B", async () => {
    const seed: ProjectRow[] = [proj({ id: "p_priv", ownerId: "u_a", visibility: "private" })];
    const f = fakeRepo(seed);
    const forA = await listProjects({ workspaceId: WS, userId: "u_a" }, { repo: f.repo });
    const forB = await listProjects({ workspaceId: WS, userId: "u_b" }, { repo: f.repo });
    expect(forA.map((p) => p.id)).toContain("p_priv");
    expect(forB.map((p) => p.id)).not.toContain("p_priv");
  });

  test("AS-006: listProjects shows a public project owned by A to member B", async () => {
    const seed: ProjectRow[] = [proj({ id: "p_pub", ownerId: "u_a", visibility: "public" })];
    const f = fakeRepo(seed);
    const forB = await listProjects({ workspaceId: WS, userId: "u_b" }, { repo: f.repo });
    expect(forB.map((p) => p.id)).toContain("p_pub");
  });

  test("AS-007: a workspace admin C gets NO exception — A's private project is absent for C", () => {
    // canViewProject takes no admin flag — there is no admin branch to exercise (C-003). The
    // predicate is identical for an admin: own + public only. C (admin, non-owner) → false.
    const priv = proj({ ownerId: "u_a", visibility: "private" });
    expect(canViewProject("u_c_admin", priv)).toBe(false);
  });

  test("AS-007: listProjects for admin C omits A's private project (no admin exception)", async () => {
    const seed: ProjectRow[] = [proj({ id: "p_priv", ownerId: "u_a", visibility: "private" })];
    const f = fakeRepo(seed);
    // listProjects has no isAdmin param — admin C runs the same userId filter as any member.
    const forAdminC = await listProjects({ workspaceId: WS, userId: "u_c_admin" }, { repo: f.repo });
    expect(forAdminC.map((p) => p.id)).not.toContain("p_priv");
  });
});

// ── project-visibility S-003: setProjectVisibility toggle + C-008 auth + C-011 payload ──────
describe("setProjectVisibility toggle (project-visibility S-003, C-008/C-011)", () => {
  const proj = (over: Partial<ProjectRow>): ProjectRow => ({
    id: "p_x",
    workspaceId: WS,
    name: "X",
    ownerId: "u_a",
    isDefault: false,
    visibility: "public",
    archivedAt: null,
    ...over,
  });

  test("AS-011: the owner toggles their public project → private; the row reflects private", async () => {
    const f = fakeRepo([proj({ id: "p1", ownerId: "u_a", visibility: "public" })]);
    const updated = await setProjectVisibility(
      { workspaceId: WS, projectId: "p1", actorId: "u_a", isAdmin: false, visibility: "private" },
      { repo: f.repo },
    );
    expect(updated.visibility).toBe("private");
    // Persisted: a re-fetch (here the fake's state) shows private, and it is now owner-only —
    // canViewProject hides it from a non-owner (the "disappears from other members'" half).
    const stored = f.state.projects.find((p) => p.id === "p1")!;
    expect(stored.visibility).toBe("private");
    expect(canViewProject("u_a", stored)).toBe(true);
    expect(canViewProject("u_b", stored)).toBe(false);
  });

  test("AS-012: a non-owner non-admin toggle is refused (forbidden); visibility unchanged", async () => {
    const f = fakeRepo([proj({ id: "p1", ownerId: "u_a", visibility: "public" })]);
    await expect(
      setProjectVisibility(
        { workspaceId: WS, projectId: "p1", actorId: "u_b", isAdmin: false, visibility: "private" },
        { repo: f.repo },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    // Unchanged — the refusal never wrote.
    expect(f.state.projects.find((p) => p.id === "p1")!.visibility).toBe("public");
  });

  test("AS-013: a workspace admin can toggle a PUBLIC project they can see", async () => {
    const f = fakeRepo([proj({ id: "p1", ownerId: "u_a", visibility: "public" })]);
    const updated = await setProjectVisibility(
      { workspaceId: WS, projectId: "p1", actorId: "u_c_admin", isAdmin: true, visibility: "private" },
      { repo: f.repo },
    );
    expect(updated.visibility).toBe("private");
  });

  test("C-008: an admin CANNOT toggle another member's PRIVATE project (cannot see it → refused)", async () => {
    // Admin gets no exception (C-003): a private project they don't own is not visible, so the
    // admin arm (isAdmin && canViewProject) is false → forbidden. No new admin exception invented.
    const f = fakeRepo([proj({ id: "p_priv", ownerId: "u_a", visibility: "private" })]);
    await expect(
      setProjectVisibility(
        { workspaceId: WS, projectId: "p_priv", actorId: "u_c_admin", isAdmin: true, visibility: "public" },
        { repo: f.repo },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(f.state.projects.find((p) => p.id === "p_priv")!.visibility).toBe("private");
  });

  test("AS-014: toggling visibility does NOT touch existing docs' share_links (no retro change)", async () => {
    // The toggle path uses only findById + setVisibility on the ProjectRepo — which has NO
    // share_links surface at all. We model an existing doc's two-axis access as a sentinel held
    // OUTSIDE the project repo; the toggle has no handle to it, so it is byte-identical after.
    const existingDocAccess = { workspaceRole: "commenter" as const, linkRole: null };
    const before = JSON.stringify(existingDocAccess);
    const f = fakeRepo([proj({ id: "p1", ownerId: "u_a", visibility: "public" })]);
    await setProjectVisibility(
      { workspaceId: WS, projectId: "p1", actorId: "u_a", isAdmin: false, visibility: "private" },
      { repo: f.repo },
    );
    // The project flipped, but the existing doc's access is untouched (only NEW docs derive from
    // the new visibility — S-004); the ProjectRepo never exposed share_links to the toggle.
    expect(f.state.projects.find((p) => p.id === "p1")!.visibility).toBe("private");
    expect(JSON.stringify(existingDocAccess)).toBe(before);
  });

  test("AS-015: listProjects rows carry isDefault AND visibility for every project (C-011 payload)", async () => {
    // The projects-list payload maps straight off these ProjectRow fields — the shape the web
    // badges (Default + Private/Public) read from. Each returned row must carry both.
    const seed: ProjectRow[] = [
      proj({ id: "p_def", ownerId: "u_a", isDefault: true, visibility: "private" }),
      proj({ id: "p_pub", ownerId: "u_a", isDefault: false, visibility: "public" }),
    ];
    const f = fakeRepo(seed);
    const list = await listProjects({ workspaceId: WS, userId: "u_a" }, { repo: f.repo });
    for (const row of list) {
      expect(row).toHaveProperty("isDefault");
      expect(row).toHaveProperty("visibility");
    }
    const byId = new Map(list.map((p) => [p.id, p]));
    expect(byId.get("p_def")).toMatchObject({ isDefault: true, visibility: "private" });
    expect(byId.get("p_pub")).toMatchObject({ isDefault: false, visibility: "public" });
  });

  test("C-008: toggle on a missing project → not_found", async () => {
    const f = fakeRepo();
    await expect(
      setProjectVisibility(
        { workspaceId: WS, projectId: "nope", actorId: "u_a", isAdmin: true, visibility: "private" },
        { repo: f.repo },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

// ── project-visibility-cascade S-001 / C-001: make-private cascade (service tier) ──────────
// The service decides WHEN the cascade fires (public→private + cascade flag) and delegates the
// bulk-null to the repo. These unit tests drive that decision + the scope against the fake repo
// (which models share_links + a doc_members SENTINEL). The real SQL scope (other projects untouched)
// is proven in test/integration/projects.itest.ts.
describe("project-visibility-cascade S-001 — make-private cascade (C-001)", () => {
  const proj = (over: Partial<ProjectRow>): ProjectRow => ({
    id: "p_x",
    workspaceId: WS,
    name: "X",
    ownerId: "u_a",
    isDefault: false,
    visibility: "public",
    archivedAt: null,
    ...over,
  });

  test("AS-001: cascade on public→private nulls BOTH axes for every doc in the project", async () => {
    // A public project with doc A (workspace=commenter) + doc B (link=commenter).
    const f = fakeRepo(
      [proj({ id: "p1", ownerId: "u_a", visibility: "public" })],
      {
        shareLinks: [
          { docId: "docA", projectId: "p1", workspaceRole: "commenter", linkRole: null },
          { docId: "docB", projectId: "p1", workspaceRole: null, linkRole: "commenter" },
        ],
      },
    );
    const updated = await setProjectVisibility(
      { workspaceId: WS, projectId: "p1", actorId: "u_a", isAdmin: false, visibility: "private", cascade: true },
      { repo: f.repo },
    );
    // Project private.
    expect(updated.visibility).toBe("private");
    expect(f.state.projects.find((p) => p.id === "p1")!.visibility).toBe("private");
    // BOTH docs end at {null, null} (restricted).
    const a = f.state.shareLinks.find((s) => s.docId === "docA")!;
    const b = f.state.shareLinks.find((s) => s.docId === "docB")!;
    expect(a).toMatchObject({ workspaceRole: null, linkRole: null });
    expect(b).toMatchObject({ workspaceRole: null, linkRole: null });
    // The cascade repo path was taken (not the plain setVisibility).
    expect(f.state.cascadeCalls).toEqual(["p1"]);
  });

  test("AS-002: cascade preserves a specific doc_members invite (doc_members untouched)", async () => {
    // Doc D: public link + a specific invite for reviewer R (commenter).
    const docMembersSeed = [{ docId: "docD", userId: "R", role: "commenter" as const }];
    const f = fakeRepo(
      [proj({ id: "p1", ownerId: "u_a", visibility: "public" })],
      {
        shareLinks: [{ docId: "docD", projectId: "p1", workspaceRole: null, linkRole: "commenter" }],
        docMembers: docMembersSeed,
      },
    );
    const before = JSON.parse(JSON.stringify(f.state.docMembers));
    await setProjectVisibility(
      { workspaceId: WS, projectId: "p1", actorId: "u_a", isAdmin: false, visibility: "private", cascade: true },
      { repo: f.repo },
    );
    // D's share_links both null...
    expect(f.state.shareLinks.find((s) => s.docId === "docD")!).toMatchObject({
      workspaceRole: null,
      linkRole: null,
    });
    // ...but R's doc_members row is byte-identical — the cascade NEVER writes doc_members (C-001).
    expect(f.state.docMembers).toEqual(before);
    expect(f.state.docMembers).toEqual([{ docId: "docD", userId: "R", role: "commenter" }]);
  });

  test("AS-004 (guard): keep-shared (no cascade flag) takes the plain path — share_links untouched", async () => {
    const f = fakeRepo(
      [proj({ id: "p1", ownerId: "u_a", visibility: "public" })],
      {
        shareLinks: [{ docId: "docA", projectId: "p1", workspaceRole: "commenter", linkRole: null }],
      },
    );
    await setProjectVisibility(
      // No cascade flag → the keep-shared choice: project flips, docs keep their sharing (AS-014).
      { workspaceId: WS, projectId: "p1", actorId: "u_a", isAdmin: false, visibility: "private" },
      { repo: f.repo },
    );
    expect(f.state.projects.find((p) => p.id === "p1")!.visibility).toBe("private");
    // The doc's access is unchanged — the cascade repo method was never called.
    expect(f.state.shareLinks.find((s) => s.docId === "docA")!).toMatchObject({
      workspaceRole: "commenter",
      linkRole: null,
    });
    expect(f.state.cascadeCalls).toEqual([]);
  });

  test("C-001 (guard): private→public NEVER cascades even with cascade:true — no share_links write", async () => {
    // A private project being made public, with cascade erroneously set: the guard rejects the
    // cascade (it is public→private ONLY), so no doc's share_links are nulled.
    const f = fakeRepo(
      [proj({ id: "p1", ownerId: "u_a", visibility: "private" })],
      {
        shareLinks: [{ docId: "docA", projectId: "p1", workspaceRole: "commenter", linkRole: "viewer" }],
      },
    );
    await setProjectVisibility(
      { workspaceId: WS, projectId: "p1", actorId: "u_a", isAdmin: false, visibility: "public", cascade: true },
      { repo: f.repo },
    );
    expect(f.state.projects.find((p) => p.id === "p1")!.visibility).toBe("public");
    // Untouched — private→public is not a cascade direction (C-001).
    expect(f.state.shareLinks.find((s) => s.docId === "docA")!).toMatchObject({
      workspaceRole: "commenter",
      linkRole: "viewer",
    });
    expect(f.state.cascadeCalls).toEqual([]);
  });
});

// ── project-visibility S-004 / C-007: new-doc access derives from the TARGET project ──────
// deriveNewDocAccess is the ONE pure helper called from every doc-creation surface (web
// publish, MCP create_document, copy). It replaces doc-access-two-axis's FIXED {commenter,null}
// default with a project-derived one — except the per-member default project, whose new docs
// stay {commenter,null} (the carve-out that keeps the agent round-trip reviewable).
describe("project-visibility S-004 — deriveNewDocAccess (C-007)", () => {
  test("AS-016: a non-default PUBLIC project → workspace_role=commenter, link_role=null (shared)", () => {
    expect(deriveNewDocAccess({ isDefault: false, visibility: "public" })).toEqual({
      workspaceRole: "commenter",
      linkRole: null,
    });
  });

  test("AS-017: a non-default PRIVATE project → workspace_role=null, link_role=null (restricted)", () => {
    expect(deriveNewDocAccess({ isDefault: false, visibility: "private" })).toEqual({
      workspaceRole: null,
      linkRole: null,
    });
  });

  test("AS-018: the DEFAULT project (is_default, private shell) → commenter/null (carve-out holds despite private)", () => {
    // The carve-out: a default project is private-SHELL but its new docs stay workspace-shared,
    // so a quick-publish into it (no projectId) is never reviewer-invisible. Private does NOT win here.
    expect(deriveNewDocAccess({ isDefault: true, visibility: "private" })).toEqual({
      workspaceRole: "commenter",
      linkRole: null,
    });
  });

  test("C-007: a default project that is somehow public also stays commenter/null (carve-out is is_default-first)", () => {
    // Defensive boundary: is_default short-circuits regardless of the visibility value.
    expect(deriveNewDocAccess({ isDefault: true, visibility: "public" })).toEqual({
      workspaceRole: "commenter",
      linkRole: null,
    });
  });
});

// ── project-visibility S-006: projectNameForViewer — private project NAME suppression (C-004) ──
describe("projectNameForViewer — private project name suppression (project-visibility S-006, C-004)", () => {
  test("AS-026: a non-owner viewing a shared doc in a PRIVATE project sees the project name SUPPRESSED (null)", () => {
    // B can otherwise see the doc (per-doc access, C-005), but A's PRIVATE project's name must not
    // leak on the card/breadcrumb — projectNameForViewer returns null for the non-owner.
    const priv = { name: "Secret", ownerId: "u_a", visibility: "private" as const };
    expect(projectNameForViewer("u_b", priv)).toBeNull();
  });

  test("AS-026: the OWNER of the private project still sees the real name", () => {
    const priv = { name: "Secret", ownerId: "u_a", visibility: "private" as const };
    expect(projectNameForViewer("u_a", priv)).toBe("Secret");
  });

  test("AS-026: a PUBLIC project's name shows for every member (no suppression)", () => {
    const pub = { name: "Open", ownerId: "u_a", visibility: "public" as const };
    expect(projectNameForViewer("u_b", pub)).toBe("Open");
    expect(projectNameForViewer("u_a", pub)).toBe("Open");
  });

  test("C-004: name suppression reuses the SAME canViewProject predicate (never drifts from the shell gate)", () => {
    // For any (viewer, project) pair, the name is present IFF canViewProject is true — the two gates
    // are bound, so a name can never surface for a project whose shell the viewer can't see.
    const cases = [
      { name: "P", ownerId: "u_a", visibility: "private" as const },
      { name: "P", ownerId: "u_b", visibility: "private" as const },
      { name: "P", ownerId: "u_a", visibility: "public" as const },
    ];
    for (const proj of cases) {
      for (const viewer of ["u_a", "u_b", "u_c"]) {
        const present = projectNameForViewer(viewer, proj) !== null;
        expect(present).toBe(canViewProject(viewer, proj));
      }
    }
  });
});
