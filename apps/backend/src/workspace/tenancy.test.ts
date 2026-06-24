// Unit tests for the multi-workspace tenancy service (workspaces S-001..S-005), driven
// against an in-memory fake TenancyRepo (mirrors the project/share fake-repo pattern).
// The Drizzle glue is integration-verified in test/integration/workspaces-*.itest.ts.

import { test, expect } from "bun:test";
import {
  createOwnWorkspaceOnSignup,
  createWorkspace,
  renameWorkspace,
  listMyWorkspaces,
  listWorkspaceMembers,
  inviteToWorkspace,
  acceptInvitation,
  rejectInvitation,
  revokeWorkspaceInvitation,
  removeWorkspaceMember,
  changeMemberRole,
  TenancyRejected,
  type TenancyRepo,
  type WorkspaceRole,
} from "./tenancy";

interface Member {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  createdAt: number;
}
interface Invitation {
  id: string;
  workspaceId: string;
  email: string;
  role: WorkspaceRole;
  token: string;
  status: "pending" | "accepted" | "rejected" | "revoked";
  expiresAt: Date;
}

/** In-memory tenancy state + repo. Deterministic ids; enforces (workspace,user) uniqueness. */
function fakeRepo(opts: { names?: Record<string, string> } = {}) {
  let wsN = 0;
  let invN = 0;
  const state = {
    workspaces: [] as Array<{ id: string; name: string; slug: string; creatorId: string | null }>,
    members: [] as Member[],
    invitations: [] as Invitation[],
    projects: [] as Array<{ workspaceId: string; ownerId: string; isDefault: boolean }>,
  };
  const repo: TenancyRepo = {
    async createWorkspace(input) {
      const ws = { id: `ws_${++wsN}`, name: input.name, slug: input.slug, creatorId: input.creatorId ?? null };
      state.workspaces.push(ws);
      return ws;
    },
    async addMember(workspaceId, userId, role) {
      if (state.members.some((m) => m.workspaceId === workspaceId && m.userId === userId)) return;
      state.members.push({ workspaceId, userId, role, createdAt: state.members.length });
    },
    async setWorkspaceName(workspaceId, name) {
      const ws = state.workspaces.find((w) => w.id === workspaceId);
      if (ws) ws.name = name;
    },
    async findWorkspace(workspaceId) {
      return state.workspaces.find((w) => w.id === workspaceId) ?? null;
    },
    async listMyWorkspaces(userId) {
      return state.members
        .filter((m) => m.userId === userId)
        .map((m) => {
          const ws = state.workspaces.find((w) => w.id === m.workspaceId)!;
          const admin = state.members
            .filter((x) => x.workspaceId === m.workspaceId && x.role === "admin")
            .sort((a, b) => a.createdAt - b.createdAt)[0];
          return {
            id: ws.id,
            name: ws.name,
            slug: ws.slug,
            role: m.role,
            adminName: admin ? (opts.names?.[admin.userId] ?? null) : null,
            creatorId: ws.creatorId,
          };
        });
    },
    async findMemberRole(workspaceId, userId) {
      return state.members.find((m) => m.workspaceId === workspaceId && m.userId === userId)?.role ?? null;
    },
    async setMemberRole(workspaceId, userId, role) {
      const m = state.members.find((x) => x.workspaceId === workspaceId && x.userId === userId);
      if (m) m.role = role;
    },
    async removeMember(workspaceId, userId) {
      const before = state.members.length;
      state.members = state.members.filter(
        (m) => !(m.workspaceId === workspaceId && m.userId === userId),
      );
      return state.members.length < before;
    },
    async countAdmins(workspaceId) {
      return state.members.filter((m) => m.workspaceId === workspaceId && m.role === "admin").length;
    },
    async listMembers(workspaceId) {
      return state.members
        .filter((m) => m.workspaceId === workspaceId)
        .map((m) => ({ userId: m.userId, role: m.role, name: opts.names?.[m.userId] ?? m.userId, email: `${m.userId}@x.com` }));
    },
    async listInvitations(workspaceId) {
      return state.invitations
        .filter((i) => i.workspaceId === workspaceId && i.status === "pending")
        .map((i) => ({ id: i.id, email: i.email, role: i.role, status: i.status }));
    },
    async createInvitation(input) {
      const inv: Invitation = {
        id: `inv_${++invN}`,
        workspaceId: input.workspaceId,
        email: input.email,
        role: input.role,
        token: input.token,
        status: "pending",
        expiresAt: input.expiresAt,
      };
      state.invitations.push(inv);
      return { id: inv.id, token: inv.token };
    },
    async findInvitation(id) {
      const i = state.invitations.find((x) => x.id === id);
      return i ? { ...i } : null;
    },
    async setInvitationStatus(id, status) {
      const i = state.invitations.find((x) => x.id === id);
      if (i) i.status = status;
    },
    async userName(userId) {
      return opts.names?.[userId] ?? null;
    },
  };
  // A projectRepo stub so default-project creation is observable + idempotent.
  const projectRepo = {
    async insert(input: { workspaceId: string; ownerId: string | null; isDefault: boolean }) {
      const row = { workspaceId: input.workspaceId, ownerId: input.ownerId, isDefault: input.isDefault };
      state.projects.push(row as any);
      return { id: `p_${state.projects.length}`, ...input, name: "x", archivedAt: null } as any;
    },
    async findDefaultFor(ws: string, owner: string) {
      const p = state.projects.find((x) => x.workspaceId === ws && x.ownerId === owner && x.isDefault);
      return p ? ({ id: "p_existing", workspaceId: ws, ownerId: owner, isDefault: true, name: "x", archivedAt: null } as any) : null;
    },
  } as any;
  return { repo, state, projectRepo, deps: { repo, projectRepo, slugGen: (n: string) => n, tokenGen: () => `tok_${invN + 1}` } };
}

test("AS-001: signing up creates the user's OWN workspace named after them, recording them as creator", async () => {
  const f = fakeRepo({ names: { u_dung: "Dung" } });
  const out = await createOwnWorkspaceOnSignup("u_dung", f.deps);
  expect(out.role).toBe("admin");
  expect(f.state.workspaces).toHaveLength(1);
  expect(f.state.workspaces[0]!.name).toBe("Dung's workspace");
  expect(f.state.workspaces[0]!.creatorId).toBe("u_dung");
  expect(f.state.members).toEqual([
    expect.objectContaining({ userId: "u_dung", role: "admin" }),
  ]);
  // A default project was created for the new account (C-001).
  expect(f.state.projects.filter((p) => p.isDefault && p.ownerId === "u_dung")).toHaveLength(1);
});

test("AS-002 / C-001: a new account does NOT auto-join an existing workspace — it gets its own", async () => {
  const f = fakeRepo();
  await createOwnWorkspaceOnSignup("u_first", f.deps); // ws_1
  await createOwnWorkspaceOnSignup("u_second", f.deps); // ws_2, NOT ws_1
  // Two separate workspaces, each with its creator as the only member.
  expect(f.state.workspaces).toHaveLength(2);
  const secondMemberships = f.state.members.filter((m) => m.userId === "u_second");
  expect(secondMemberships).toHaveLength(1);
  expect(secondMemberships[0]!.workspaceId).toBe("ws_2");
  // The second user is NOT a member of the first user's workspace.
  expect(f.state.members.some((m) => m.userId === "u_second" && m.workspaceId === "ws_1")).toBe(false);
});

test("AS-003: creating a workspace makes me its admin and it appears in my list", async () => {
  const f = fakeRepo();
  const ws = await createWorkspace({ name: "Acme", actorId: "u_a" }, f.deps);
  expect(ws.role).toBe("admin");
  const mine = await listMyWorkspaces("u_a", f.deps);
  expect(mine.map((w) => w.name)).toContain("Acme");
});

test("AS-004: a workspace admin renames the workspace", async () => {
  const f = fakeRepo();
  const ws = await createWorkspace({ name: "Acme", actorId: "u_a" }, f.deps);
  const out = await renameWorkspace({ workspaceId: ws.id, actorId: "u_a", name: "Acme Docs" }, f.deps);
  expect(out.name).toBe("Acme Docs");
  expect(f.state.workspaces.find((w) => w.id === ws.id)!.name).toBe("Acme Docs");
});

test("AS-005 / C-003: a non-admin cannot rename the workspace (admin only)", async () => {
  const f = fakeRepo();
  const ws = await createWorkspace({ name: "Acme", actorId: "u_a" }, f.deps);
  await f.repo.addMember(ws.id, "u_member", "member");
  await expect(
    renameWorkspace({ workspaceId: ws.id, actorId: "u_member", name: "Hijack" }, f.deps),
  ).rejects.toMatchObject({ code: "forbidden" });
});

test("AS-006: my workspace list shows every workspace I belong to with my role + who created each", async () => {
  const f = fakeRepo({ names: { u_me: "Me", u_lan: "Lan" } });
  // I created my own workspace; I am a member of Lan's "Acme" (creator = Lan).
  await createOwnWorkspaceOnSignup("u_me", f.deps); // ws_1, "Me's workspace", creator u_me
  const lanWs = await createWorkspace({ name: "Acme", actorId: "u_lan" }, f.deps); // ws_2, creator u_lan
  await f.repo.addMember(lanWs.id, "u_me", "member");
  const mine = await listMyWorkspaces("u_me", f.deps);
  expect(mine).toHaveLength(2);
  const own = mine.find((w) => w.role === "admin")!;
  const lan = mine.find((w) => w.role === "member")!;
  // The one I created is identifiable by creator === me; the other's creator is Lan.
  expect(own.name).toBe("Me's workspace");
  expect(own.creatorId).toBe("u_me");
  expect(lan.creatorId).toBe("u_lan");
});

test("AS-003: creating a workspace records me as its creator", async () => {
  const f = fakeRepo();
  const ws = await createWorkspace({ name: "Acme", actorId: "u_a" }, f.deps);
  expect(f.state.workspaces.find((w) => w.id === ws.id)!.creatorId).toBe("u_a");
});

test("AS-008: listMyWorkspaces never includes a workspace I do not belong to", async () => {
  const f = fakeRepo();
  await createWorkspace({ name: "Globex", actorId: "u_other" }, f.deps);
  await createOwnWorkspaceOnSignup("u_me", f.deps);
  const mine = await listMyWorkspaces("u_me", f.deps);
  expect(mine.some((w) => w.name === "Globex")).toBe(false);
});

test("AS-009 / C-004: an admin invites by email → a PENDING invitation is recorded", async () => {
  const f = fakeRepo();
  const ws = await createWorkspace({ name: "Acme", actorId: "u_a" }, f.deps);
  const inv = await inviteToWorkspace(
    { workspaceId: ws.id, actorId: "u_a", email: "Bob@Acme.com" },
    f.deps,
  );
  expect(inv.status).toBe("pending");
  expect(f.state.invitations[0]!.email).toBe("bob@acme.com"); // normalized
  expect(f.state.invitations[0]!.status).toBe("pending");
});

test("AS-013 / C-003: only an admin can invite (a member is refused)", async () => {
  const f = fakeRepo();
  const ws = await createWorkspace({ name: "Acme", actorId: "u_a" }, f.deps);
  await f.repo.addMember(ws.id, "u_member", "member");
  await expect(
    inviteToWorkspace({ workspaceId: ws.id, actorId: "u_member", email: "x@acme.com" }, f.deps),
  ).rejects.toMatchObject({ code: "forbidden" });
});

test("AS-010 / C-004: accepting an invite joins the workspace and marks it accepted", async () => {
  const f = fakeRepo();
  const ws = await createWorkspace({ name: "Acme", actorId: "u_a" }, f.deps);
  const inv = await inviteToWorkspace({ workspaceId: ws.id, actorId: "u_a", email: "bob@acme.com" }, f.deps);
  const out = await acceptInvitation(
    { invitationId: inv.id, token: inv.token, actorId: "u_bob", actorEmail: "bob@acme.com" },
    f.deps,
  );
  expect(out.workspaceId).toBe(ws.id);
  expect(f.state.members.some((m) => m.userId === "u_bob" && m.workspaceId === ws.id)).toBe(true);
  expect(f.state.invitations[0]!.status).toBe("accepted");
});

test("AS-011 / C-004: rejecting an invite leaves no membership and marks it rejected", async () => {
  const f = fakeRepo();
  const ws = await createWorkspace({ name: "Acme", actorId: "u_a" }, f.deps);
  const inv = await inviteToWorkspace({ workspaceId: ws.id, actorId: "u_a", email: "bob@acme.com" }, f.deps);
  await rejectInvitation({ invitationId: inv.id, token: inv.token, actorEmail: "bob@acme.com" }, f.deps);
  expect(f.state.members.some((m) => m.userId === "u_bob")).toBe(false);
  expect(f.state.invitations[0]!.status).toBe("rejected");
});

test("AS-017: an admin revokes a pending invite → marked revoked and gone from the pending list", async () => {
  const f = fakeRepo();
  const ws = await createWorkspace({ name: "Acme", actorId: "u_a" }, f.deps);
  const inv = await inviteToWorkspace({ workspaceId: ws.id, actorId: "u_a", email: "bob@acme.com" }, f.deps);
  await revokeWorkspaceInvitation({ workspaceId: ws.id, actorId: "u_a", invitationId: inv.id }, f.deps);
  expect(f.state.invitations[0]!.status).toBe("revoked");
  // The members surface lists only pending invites → the revoked one is gone.
  const { invitations } = await listWorkspaceMembers({ workspaceId: ws.id, actorId: "u_a" }, f.deps);
  expect(invitations.some((i) => i.id === inv.id)).toBe(false);
});

test("AS-017 / C-002: a non-admin cannot revoke an invite", async () => {
  const f = fakeRepo();
  const ws = await createWorkspace({ name: "Acme", actorId: "u_a" }, f.deps);
  await f.repo.addMember(ws.id, "u_bob", "member");
  const inv = await inviteToWorkspace({ workspaceId: ws.id, actorId: "u_a", email: "eve@acme.com" }, f.deps);
  await expect(
    revokeWorkspaceInvitation({ workspaceId: ws.id, actorId: "u_bob", invitationId: inv.id }, f.deps),
  ).rejects.toMatchObject({ code: "forbidden" });
  expect(f.state.invitations[0]!.status).toBe("pending");
});

test("AS-017: revoking an invite that belongs to another workspace is refused (scoped)", async () => {
  const f = fakeRepo();
  const a = await createWorkspace({ name: "Acme", actorId: "u_a" }, f.deps);
  const b = await createWorkspace({ name: "Beta", actorId: "u_a" }, f.deps);
  const inv = await inviteToWorkspace({ workspaceId: b.id, actorId: "u_a", email: "bob@acme.com" }, f.deps);
  // Revoke addressed to workspace A but the invite lives in B → not found (no cross-workspace revoke).
  await expect(
    revokeWorkspaceInvitation({ workspaceId: a.id, actorId: "u_a", invitationId: inv.id }, f.deps),
  ).rejects.toMatchObject({ code: "not_found" });
  expect(f.state.invitations[0]!.status).toBe("pending");
});

test("AS-017: revoking a non-pending invite is refused (not_pending)", async () => {
  const f = fakeRepo();
  const ws = await createWorkspace({ name: "Acme", actorId: "u_a" }, f.deps);
  const inv = await inviteToWorkspace({ workspaceId: ws.id, actorId: "u_a", email: "bob@acme.com" }, f.deps);
  await acceptInvitation(
    { invitationId: inv.id, token: inv.token, actorId: "u_bob", actorEmail: "bob@acme.com" },
    f.deps,
  );
  await expect(
    revokeWorkspaceInvitation({ workspaceId: ws.id, actorId: "u_a", invitationId: inv.id }, f.deps),
  ).rejects.toMatchObject({ code: "not_pending" });
});

test("AS-012 / C-004: an invite used by a different email is refused (email must match); no membership", async () => {
  const f = fakeRepo();
  const ws = await createWorkspace({ name: "Acme", actorId: "u_a" }, f.deps);
  const inv = await inviteToWorkspace({ workspaceId: ws.id, actorId: "u_a", email: "bob@acme.com" }, f.deps);
  await expect(
    acceptInvitation(
      { invitationId: inv.id, token: inv.token, actorId: "u_eve", actorEmail: "eve@acme.com" },
      f.deps,
    ),
  ).rejects.toMatchObject({ code: "email_mismatch" });
  expect(f.state.members.some((m) => m.userId === "u_eve")).toBe(false);
});

// your-activity-inbox S-005 — TOKENLESS accept/decline from the For-you inbox (C-003/C-007).
// An already-authenticated invitee whose SESSION EMAIL matches the invited email accepts/declines
// with NO token; the email-match is the authorization gate and is NEVER skipped.

test("AS-016: a TOKENLESS accept (no token) joins the workspace when the session email matches", async () => {
  const f = fakeRepo();
  const ws = await createWorkspace({ name: "Mercury Docs", actorId: "u_a" }, f.deps);
  const inv = await inviteToWorkspace(
    { workspaceId: ws.id, actorId: "u_a", email: "bob@acme.com", role: "member" },
    f.deps,
  );
  // No token supplied — authorized purely by the matching session email.
  const out = await acceptInvitation(
    { invitationId: inv.id, actorId: "u_bob", actorEmail: "bob@acme.com" },
    f.deps,
  );
  expect(out.workspaceId).toBe(ws.id);
  expect(out.role).toBe("member");
  expect(f.state.members.some((m) => m.userId === "u_bob" && m.workspaceId === ws.id)).toBe(true);
  expect(f.state.invitations[0]!.status).toBe("accepted");
});

test("AS-016 (SECURITY): a TOKENLESS accept is STILL refused when the session email does NOT match", async () => {
  const f = fakeRepo();
  const ws = await createWorkspace({ name: "Mercury Docs", actorId: "u_a" }, f.deps);
  const inv = await inviteToWorkspace({ workspaceId: ws.id, actorId: "u_a", email: "bob@acme.com" }, f.deps);
  // Tokenless but wrong email → the email-match gate (never skipped) refuses.
  await expect(
    acceptInvitation(
      { invitationId: inv.id, actorId: "u_eve", actorEmail: "eve@acme.com" },
      f.deps,
    ),
  ).rejects.toMatchObject({ code: "email_mismatch" });
  expect(f.state.members.some((m) => m.userId === "u_eve")).toBe(false);
});

test("AS-017: a TOKENLESS decline (no token) rejects the invite when the session email matches", async () => {
  const f = fakeRepo();
  const ws = await createWorkspace({ name: "Mercury Docs", actorId: "u_a" }, f.deps);
  const inv = await inviteToWorkspace({ workspaceId: ws.id, actorId: "u_a", email: "bob@acme.com" }, f.deps);
  await rejectInvitation({ invitationId: inv.id, actorEmail: "bob@acme.com" }, f.deps);
  expect(f.state.members.some((m) => m.userId === "u_bob")).toBe(false);
  expect(f.state.invitations[0]!.status).toBe("rejected");
});

test("AS-019: a TOKENLESS accept on an already-settled (accepted) invite is refused (not_pending — no dead 404)", async () => {
  const f = fakeRepo();
  const ws = await createWorkspace({ name: "Mercury Docs", actorId: "u_a" }, f.deps);
  const inv = await inviteToWorkspace({ workspaceId: ws.id, actorId: "u_a", email: "bob@acme.com" }, f.deps);
  await acceptInvitation({ invitationId: inv.id, actorId: "u_bob", actorEmail: "bob@acme.com" }, f.deps);
  // Acting again on the now-accepted invite degrades to not_pending (the FE surfaces "no longer available").
  await expect(
    acceptInvitation({ invitationId: inv.id, actorId: "u_bob", actorEmail: "bob@acme.com" }, f.deps),
  ).rejects.toMatchObject({ code: "not_pending" });
});

test("the token-bearing email-link accept path still works (tokenless change is additive)", async () => {
  const f = fakeRepo();
  const ws = await createWorkspace({ name: "Acme", actorId: "u_a" }, f.deps);
  const inv = await inviteToWorkspace({ workspaceId: ws.id, actorId: "u_a", email: "bob@acme.com" }, f.deps);
  const out = await acceptInvitation(
    { invitationId: inv.id, token: inv.token, actorId: "u_bob", actorEmail: "bob@acme.com" },
    f.deps,
  );
  expect(out.workspaceId).toBe(ws.id);
  expect(f.state.invitations[0]!.status).toBe("accepted");
});

test("a token-bearing accept with the WRONG token is still refused (not_found — email-link path unchanged)", async () => {
  const f = fakeRepo();
  const ws = await createWorkspace({ name: "Acme", actorId: "u_a" }, f.deps);
  const inv = await inviteToWorkspace({ workspaceId: ws.id, actorId: "u_a", email: "bob@acme.com" }, f.deps);
  await expect(
    acceptInvitation(
      { invitationId: inv.id, token: "wrong-token", actorId: "u_bob", actorEmail: "bob@acme.com" },
      f.deps,
    ),
  ).rejects.toMatchObject({ code: "not_found" });
});

test("AS-014: an admin removes a member; the member loses access", async () => {
  const f = fakeRepo();
  const ws = await createWorkspace({ name: "Acme", actorId: "u_a" }, f.deps);
  await f.repo.addMember(ws.id, "u_bob", "member");
  await removeWorkspaceMember({ workspaceId: ws.id, actorId: "u_a", targetUserId: "u_bob" }, f.deps);
  expect(f.state.members.some((m) => m.userId === "u_bob")).toBe(false);
});

test("AS-015: an admin promotes a member to admin (more than one admin allowed)", async () => {
  const f = fakeRepo();
  const ws = await createWorkspace({ name: "Acme", actorId: "u_a" }, f.deps);
  await f.repo.addMember(ws.id, "u_bob", "member");
  const out = await changeMemberRole(
    { workspaceId: ws.id, actorId: "u_a", targetUserId: "u_bob", role: "admin" },
    f.deps,
  );
  expect(out.role).toBe("admin");
  expect(await f.repo.countAdmins(ws.id)).toBe(2);
});

test("AS-016 / C-003: the last admin cannot be removed", async () => {
  const f = fakeRepo();
  const ws = await createWorkspace({ name: "Acme", actorId: "u_a" }, f.deps);
  await expect(
    removeWorkspaceMember({ workspaceId: ws.id, actorId: "u_a", targetUserId: "u_a" }, f.deps),
  ).rejects.toMatchObject({ code: "sole_admin" });
});

test("AS-016 / C-003: the last admin cannot be demoted to member", async () => {
  const f = fakeRepo();
  const ws = await createWorkspace({ name: "Acme", actorId: "u_a" }, f.deps);
  await expect(
    changeMemberRole({ workspaceId: ws.id, actorId: "u_a", targetUserId: "u_a", role: "member" }, f.deps),
  ).rejects.toMatchObject({ code: "sole_admin" });
});

test("AS-017 / C-003: a non-admin cannot remove or change roles", async () => {
  const f = fakeRepo();
  const ws = await createWorkspace({ name: "Acme", actorId: "u_a" }, f.deps);
  await f.repo.addMember(ws.id, "u_bob", "member");
  await f.repo.addMember(ws.id, "u_carol", "member");
  await expect(
    removeWorkspaceMember({ workspaceId: ws.id, actorId: "u_bob", targetUserId: "u_carol" }, f.deps),
  ).rejects.toMatchObject({ code: "forbidden" });
  await expect(
    changeMemberRole({ workspaceId: ws.id, actorId: "u_bob", targetUserId: "u_carol", role: "admin" }, f.deps),
  ).rejects.toMatchObject({ code: "forbidden" });
});

test("AS-021: an admin sees the workspace's members with roles + pending invitations with status", async () => {
  const f = fakeRepo({ names: { u_a: "Alice", u_bob: "Bob" } });
  const ws = await createWorkspace({ name: "Acme", actorId: "u_a" }, f.deps);
  await f.repo.addMember(ws.id, "u_bob", "member");
  await inviteToWorkspace({ workspaceId: ws.id, actorId: "u_a", email: "eve@acme.com" }, f.deps);
  const out = await listWorkspaceMembers({ workspaceId: ws.id, actorId: "u_a" }, f.deps);
  expect(out.members.map((m) => m.userId).sort()).toEqual(["u_a", "u_bob"]);
  expect(out.invitations).toHaveLength(1);
  expect(out.invitations[0]!.email).toBe("eve@acme.com");
  expect(out.invitations[0]!.status).toBe("pending");
});

test("AS-021 / C-003: a non-admin cannot read the member list", async () => {
  const f = fakeRepo();
  const ws = await createWorkspace({ name: "Acme", actorId: "u_a" }, f.deps);
  await f.repo.addMember(ws.id, "u_bob", "member");
  await expect(
    listWorkspaceMembers({ workspaceId: ws.id, actorId: "u_bob" }, f.deps),
  ).rejects.toMatchObject({ code: "forbidden" });
});

test("AS-003: an empty workspace name is rejected (invalid_name)", async () => {
  const f = fakeRepo();
  await expect(
    createWorkspace({ name: "   ", actorId: "u_a" }, f.deps),
  ).rejects.toMatchObject({ code: "invalid_name" });
});
