import { test, expect } from "bun:test";
import {
  listMembers,
  inviteMember,
  removeMember,
  MemberRejected,
  type WorkspaceMembersRepo,
  type EnqueuedWorkspaceInvite,
} from "./members";

// workspace-project S-002: an admin manages membership (invite + remove); a member
// cannot. UNIT tests of the membership LOGIC against an in-memory fake repo (mirrors
// setup.test.ts). The admin-gate (who may call these) is the route's requireWorkspaceAdmin
// gate, tested in test/routes/members-routes.test.ts; here we test the service rules:
// list, invite (records intent + idempotency), remove (deletes only membership +
// sole-admin guard + not-a-member no-op). The real Drizzle glue is integration-verified
// in test/integration/members.itest.ts.

const WS = "ws_1";

interface Membership {
  workspaceId: string;
  userId: string;
  role: "admin" | "member";
  name: string;
  email: string;
}

function fakeRepo(seed: Membership[] = []) {
  const state = { members: [...seed], invites: [] as EnqueuedWorkspaceInvite[] };
  const repo: WorkspaceMembersRepo = {
    async listMembers(workspaceId) {
      return state.members
        .filter((m) => m.workspaceId === workspaceId)
        .map((m) => ({ userId: m.userId, role: m.role, name: m.name, email: m.email }));
    },
    async findMemberRole(workspaceId, userId) {
      return state.members.find((m) => m.workspaceId === workspaceId && m.userId === userId)?.role ?? null;
    },
    async findMemberByEmail(workspaceId, email) {
      const m = state.members.find((x) => x.workspaceId === workspaceId && x.email === email);
      return m ? { userId: m.userId, role: m.role } : null;
    },
    async countAdmins(workspaceId) {
      return state.members.filter((m) => m.workspaceId === workspaceId && m.role === "admin").length;
    },
    async removeMember(workspaceId, userId) {
      const before = state.members.length;
      state.members = state.members.filter(
        (m) => !(m.workspaceId === workspaceId && m.userId === userId),
      );
      return state.members.length < before;
    },
  };
  return { repo, state };
}

const enqueue = (state: { invites: EnqueuedWorkspaceInvite[] }) => (msg: EnqueuedWorkspaceInvite) =>
  state.invites.push(msg);

test("AS-003: invite records intent for an email that is not yet a member", async () => {
  const f = fakeRepo([
    { workspaceId: WS, userId: "u_admin", role: "admin", name: "Admin", email: "admin@acme.com" },
  ]);
  const res = await inviteMember(
    { workspaceId: WS, email: "dev@acme.com", invitedBy: "u_admin" },
    { repo: f.repo, enqueueInvite: enqueue(f.state) },
  );
  expect(res.status).toBe("invited");
  expect(f.state.invites).toEqual([{ workspaceId: WS, email: "dev@acme.com", invitedBy: "u_admin" }]);
});

test("AS-003: invite normalizes the email (lowercase + trim)", async () => {
  const f = fakeRepo();
  await inviteMember(
    { workspaceId: WS, email: "  Dev@Acme.com  ", invitedBy: "u_admin" },
    { repo: f.repo, enqueueInvite: enqueue(f.state) },
  );
  expect(f.state.invites[0]!.email).toBe("dev@acme.com");
});

test("AS-003: inviting an email that is ALREADY a member is idempotent (already_member, no enqueue)", async () => {
  const f = fakeRepo([
    { workspaceId: WS, userId: "u_admin", role: "admin", name: "Admin", email: "admin@acme.com" },
    { workspaceId: WS, userId: "u_dev", role: "member", name: "Dev", email: "dev@acme.com" },
  ]);
  const res = await inviteMember(
    { workspaceId: WS, email: "dev@acme.com", invitedBy: "u_admin" },
    { repo: f.repo, enqueueInvite: enqueue(f.state) },
  );
  expect(res.status).toBe("already_member");
  expect(f.state.invites).toEqual([]);
});

test("list returns the workspace members with role/name/email", async () => {
  const f = fakeRepo([
    { workspaceId: WS, userId: "u_admin", role: "admin", name: "Admin", email: "admin@acme.com" },
    { workspaceId: WS, userId: "u_dev", role: "member", name: "Dev", email: "dev@acme.com" },
  ]);
  const list = await listMembers({ workspaceId: WS }, { repo: f.repo });
  expect(list).toHaveLength(2);
  expect(list.map((m) => m.userId).sort()).toEqual(["u_admin", "u_dev"]);
});

test("AS-012: remove deletes ONLY the targeted membership row (others untouched)", async () => {
  const f = fakeRepo([
    { workspaceId: WS, userId: "u_admin", role: "admin", name: "Admin", email: "admin@acme.com" },
    { workspaceId: WS, userId: "u_m", role: "member", name: "M", email: "m@acme.com" },
    { workspaceId: WS, userId: "u_other", role: "member", name: "Other", email: "o@acme.com" },
  ]);
  await removeMember({ workspaceId: WS, targetUserId: "u_m", actorId: "u_admin" }, { repo: f.repo });
  expect(f.state.members.map((m) => m.userId).sort()).toEqual(["u_admin", "u_other"]);
});

test("removing a user who is not a member → MemberRejected not_member (404)", async () => {
  const f = fakeRepo([
    { workspaceId: WS, userId: "u_admin", role: "admin", name: "Admin", email: "admin@acme.com" },
  ]);
  await expect(
    removeMember({ workspaceId: WS, targetUserId: "u_ghost", actorId: "u_admin" }, { repo: f.repo }),
  ).rejects.toMatchObject({ code: "not_member" });
});

test("EDGE: the SOLE admin cannot remove themselves (would orphan the workspace) → sole_admin", async () => {
  const f = fakeRepo([
    { workspaceId: WS, userId: "u_admin", role: "admin", name: "Admin", email: "admin@acme.com" },
    { workspaceId: WS, userId: "u_m", role: "member", name: "M", email: "m@acme.com" },
  ]);
  await expect(
    removeMember({ workspaceId: WS, targetUserId: "u_admin", actorId: "u_admin" }, { repo: f.repo }),
  ).rejects.toMatchObject({ code: "sole_admin" });
  // Nothing removed.
  expect(f.state.members.some((m) => m.userId === "u_admin")).toBe(true);
});

test("EDGE: a NON-sole admin can be removed (two admins → one stays)", async () => {
  const f = fakeRepo([
    { workspaceId: WS, userId: "u_admin", role: "admin", name: "Admin", email: "a@acme.com" },
    { workspaceId: WS, userId: "u_admin2", role: "admin", name: "Admin2", email: "a2@acme.com" },
  ]);
  await removeMember({ workspaceId: WS, targetUserId: "u_admin2", actorId: "u_admin" }, { repo: f.repo });
  expect(f.state.members.map((m) => m.userId)).toEqual(["u_admin"]);
});
