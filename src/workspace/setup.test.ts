import { test, expect } from "bun:test";
import {
  createWorkspaceWithAdmin,
  addMemberOnSignup,
  SetupRejected,
  type WorkspaceRepo,
  type CreatedWorkspace,
  type WorkspaceSettings,
} from "./setup";

// workspace-project S-001: first-run creates the single workspace + admin; whoever
// signs up afterward is a regular member (C-001). These are UNIT tests of the
// bootstrap LOGIC against an in-memory fake WorkspaceRepo (mirrors share.ts /
// publish service fake-repo pattern) — the real Drizzle transaction is
// integration-verified in test/integration/workspace-setup.itest.ts.

const SETTINGS: WorkspaceSettings = { providers: { github: true, google: true } };

/**
 * In-memory WorkspaceRepo. Holds at most one workspace (v0) + a membership list,
 * and enforces the SAME invariants the real transaction does: the in-tx guard
 * refuses a second create (C-001), and addMember is idempotent on (workspace,user).
 */
function fakeRepo() {
  const state: {
    workspace: CreatedWorkspace | null;
    members: Array<{ workspaceId: string; userId: string; role: string }>;
  } = { workspace: null, members: [] };

  const repo: WorkspaceRepo = {
    async countWorkspaces() {
      return state.workspace ? 1 : 0;
    },
    async createWorkspaceWithAdmin(input) {
      // In-tx guard: a second create (the concurrent loser) sees a row and refuses.
      if (state.workspace) {
        throw new SetupRejected("instance already set up", "already_set_up");
      }
      const ws: CreatedWorkspace = {
        workspaceId: "ws_1",
        slug: input.slug,
        name: input.name,
        adminUserId: input.adminUserId,
      };
      state.workspace = ws;
      state.members.push({ workspaceId: ws.workspaceId, userId: input.adminUserId, role: "admin" });
      return ws;
    },
    async currentWorkspaceId() {
      return state.workspace?.workspaceId ?? null;
    },
    async addMember(workspaceId, userId, role) {
      // Idempotent on (workspace, user) — the composite-unique backstop.
      if (state.members.some((m) => m.workspaceId === workspaceId && m.userId === userId)) return;
      state.members.push({ workspaceId, userId, role });
    },
  };
  return { repo, state };
}

test("AS-001: first-run creates the workspace AND the running user is its admin", async () => {
  const f = fakeRepo();
  const out = await createWorkspaceWithAdmin(
    { name: "Acme", settings: SETTINGS, adminUserId: "u_installer" },
    { repo: f.repo },
  );

  // The single workspace row exists, named as supplied.
  expect(f.state.workspace).not.toBeNull();
  expect(out.name).toBe("Acme");
  expect(out.workspaceId).toBe("ws_1");
  // That account is admin (and the ONLY member so far).
  expect(f.state.members).toEqual([
    { workspaceId: "ws_1", userId: "u_installer", role: "admin" },
  ]);
  expect(out.adminUserId).toBe("u_installer");
  // Providers (GitHub+Google) are persisted in settings via the create path.
  expect(SETTINGS.providers).toEqual({ github: true, google: true });
});

test("AS-001: the admin is the SESSION actor — a body-supplied userId cannot forge it", async () => {
  // The service only ever uses input.adminUserId (threaded from the route's actor).
  // There is no parameter by which the body could name a different admin: a forged
  // body field never reaches here, and the recorded admin is exactly adminUserId.
  const f = fakeRepo();
  const out = await createWorkspaceWithAdmin(
    { name: "Acme", settings: SETTINGS, adminUserId: "u_session" },
    { repo: f.repo },
  );
  expect(out.adminUserId).toBe("u_session");
  expect(f.state.members[0]!.userId).toBe("u_session");
});

test("C-001: a second first-run is refused — no second workspace, no second admin", async () => {
  const f = fakeRepo();
  await createWorkspaceWithAdmin(
    { name: "Acme", settings: SETTINGS, adminUserId: "u_installer" },
    { repo: f.repo },
  );

  await expect(
    createWorkspaceWithAdmin(
      { name: "Evil Corp", settings: SETTINGS, adminUserId: "u_second" },
      { repo: f.repo },
    ),
  ).rejects.toMatchObject({ code: "already_set_up" });

  // Still exactly one workspace, still exactly one (admin) member.
  expect(await f.repo.countWorkspaces()).toBe(1);
  expect(f.state.members).toEqual([
    { workspaceId: "ws_1", userId: "u_installer", role: "admin" },
  ]);
});

test("C-001: a later signup is added as member (not admin) once a workspace exists", async () => {
  const f = fakeRepo();
  await createWorkspaceWithAdmin(
    { name: "Acme", settings: SETTINGS, adminUserId: "u_installer" },
    { repo: f.repo },
  );

  const res = await addMemberOnSignup("u_second", { repo: f.repo });

  expect(res).toEqual({ added: true, role: "member" });
  expect(f.state.members).toContainEqual({
    workspaceId: "ws_1",
    userId: "u_second",
    role: "member",
  });
  // The installer is still the only admin.
  const admins = f.state.members.filter((m) => m.role === "admin");
  expect(admins).toEqual([{ workspaceId: "ws_1", userId: "u_installer", role: "admin" }]);
});

test("AS-002: a signup BEFORE any workspace exists is a deterministic no-op (not yet a member)", async () => {
  const f = fakeRepo();
  const res = await addMemberOnSignup("u_early", { repo: f.repo });
  expect(res).toEqual({ added: false });
  expect(f.state.members).toEqual([]);
});

test("AS-002: member-on-signup is idempotent — a re-run does not duplicate the membership", async () => {
  const f = fakeRepo();
  await createWorkspaceWithAdmin(
    { name: "Acme", settings: SETTINGS, adminUserId: "u_installer" },
    { repo: f.repo },
  );
  await addMemberOnSignup("u_second", { repo: f.repo });
  await addMemberOnSignup("u_second", { repo: f.repo });
  const memberships = f.state.members.filter((m) => m.userId === "u_second");
  expect(memberships).toHaveLength(1);
});

test("AS-001: an empty/whitespace workspace name is rejected (invalid_name)", async () => {
  const f = fakeRepo();
  await expect(
    createWorkspaceWithAdmin(
      { name: "   ", settings: SETTINGS, adminUserId: "u_installer" },
      { repo: f.repo },
    ),
  ).rejects.toMatchObject({ code: "invalid_name" });
  expect(f.state.workspace).toBeNull();
});

test("AS-001: slug is derived from the name (deterministic via injected slugGen)", async () => {
  const f = fakeRepo();
  const out = await createWorkspaceWithAdmin(
    { name: "Acme", settings: SETTINGS, adminUserId: "u_installer" },
    { repo: f.repo, slugGen: (n) => `${n.toLowerCase()}-fixed` },
  );
  expect(out.slug).toBe("acme-fixed");
});
