// In-process route tests for the top-level /api/workspaces + /api/invitations mounts
// (workspaces S-002/S-004). HTTP GLUE only — envelope + auth gate + Zod + the tenancy
// service via a fake TenancyRepo. The real-Postgres path is in the workspaces itests.

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { TenancyRepo, WorkspaceRole } from "../../src/workspace/tenancy";
import type { SessionResolver } from "../../src/http/auth-gate";

const asUser = (userId: string): SessionResolver => async () => ({ userId });
const noSession: SessionResolver = async () => null;

function fakeRepo() {
  let wsN = 0;
  let invN = 0;
  const state = {
    workspaces: [] as Array<{ id: string; name: string; slug: string }>,
    members: [] as Array<{ workspaceId: string; userId: string; role: WorkspaceRole }>,
    invitations: [] as Array<{ id: string; workspaceId: string; email: string; role: WorkspaceRole; token: string; status: string; expiresAt: Date }>,
  };
  const repo = {
    async createWorkspace(input: { name: string; slug: string }) {
      const ws = { id: `ws_${++wsN}`, name: input.name, slug: input.slug };
      state.workspaces.push(ws);
      return ws;
    },
    async addMember(workspaceId: string, userId: string, role: WorkspaceRole) {
      if (!state.members.some((m) => m.workspaceId === workspaceId && m.userId === userId))
        state.members.push({ workspaceId, userId, role });
    },
    async setWorkspaceName(workspaceId: string, name: string) {
      const ws = state.workspaces.find((w) => w.id === workspaceId);
      if (ws) ws.name = name;
    },
    async findMemberRole(workspaceId: string, userId: string) {
      return state.members.find((m) => m.workspaceId === workspaceId && m.userId === userId)?.role ?? null;
    },
    async createInvitation(input: any) {
      const inv = { id: `inv_${++invN}`, status: "pending", ...input };
      state.invitations.push(inv);
      return { id: inv.id, token: inv.token };
    },
    async findInvitation(id: string) {
      return state.invitations.find((i) => i.id === id) ?? null;
    },
    async setInvitationStatus(id: string, status: string) {
      const i = state.invitations.find((x) => x.id === id);
      if (i) i.status = status;
    },
    async userName() {
      return null;
    },
  } as unknown as TenancyRepo;
  return { repo, state };
}

function buildApp(
  resolveSession: SessionResolver,
  repo: TenancyRepo,
  emails: Record<string, string> = {},
  enqueueInvite?: (m: any) => void,
) {
  return createApp({
    dbCheck: async () => {},
    workspaces: {
      repo,
      resolveSession,
      resolveActorEmail: async (uid) => (emails[uid] ? { email: emails[uid]! } : null),
      enqueueInvite,
    },
  });
}

function req(method: string, path: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("/api/workspaces + /api/invitations route glue (workspaces S-002/S-004)", () => {
  test("AS-003: POST /api/workspaces creates a workspace; the creator is admin", async () => {
    const f = fakeRepo();
    const app = buildApp(asUser("u_a"), f.repo);
    const res = await app.handle(req("POST", "/api/workspaces", { name: "Acme" }));
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.data.name).toBe("Acme");
    expect(json.data.role).toBe("admin");
    expect(f.state.members[0]!.role).toBe("admin");
  });

  test("AS-004: PATCH /api/workspaces/:id renames (admin)", async () => {
    const f = fakeRepo();
    const app = buildApp(asUser("u_a"), f.repo);
    await app.handle(req("POST", "/api/workspaces", { name: "Acme" }));
    const res = await app.handle(req("PATCH", "/api/workspaces/ws_1", { name: "Acme Docs" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.name).toBe("Acme Docs");
  });

  test("AS-005: a non-admin renaming is refused → 403", async () => {
    const f = fakeRepo();
    const app = buildApp(asUser("u_member"), f.repo);
    // u_a creates; u_member is only a member.
    await buildApp(asUser("u_a"), f.repo).handle(req("POST", "/api/workspaces", { name: "Acme" }));
    await f.repo.addMember("ws_1", "u_member", "member");
    const res = await app.handle(req("PATCH", "/api/workspaces/ws_1", { name: "Hijack" }));
    expect(res.status).toBe(403);
  });

  test("AS-009: POST /api/workspaces/:id/invitations records a pending invite + enqueues the link", async () => {
    const f = fakeRepo();
    const enqueued: any[] = [];
    const app = buildApp(asUser("u_a"), f.repo, {}, (m) => enqueued.push(m));
    await app.handle(req("POST", "/api/workspaces", { name: "Acme" }));
    const res = await app.handle(
      req("POST", "/api/workspaces/ws_1/invitations", { email: "bob@acme.com" }),
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).data.status).toBe("pending");
    expect(enqueued[0].email).toBe("bob@acme.com");
    expect(typeof enqueued[0].token).toBe("string");
  });

  test("AS-013: a non-admin inviting is refused → 403", async () => {
    const f = fakeRepo();
    await buildApp(asUser("u_a"), f.repo).handle(req("POST", "/api/workspaces", { name: "Acme" }));
    await f.repo.addMember("ws_1", "u_member", "member");
    const app = buildApp(asUser("u_member"), f.repo);
    const res = await app.handle(req("POST", "/api/workspaces/ws_1/invitations", { email: "x@acme.com" }));
    expect(res.status).toBe(403);
  });

  test("AS-010: POST /api/invitations/:id/accept joins the workspace when the email matches", async () => {
    const f = fakeRepo();
    const enqueued: any[] = [];
    await buildApp(asUser("u_a"), f.repo, {}, (m) => enqueued.push(m)).handle(
      req("POST", "/api/workspaces", { name: "Acme" }),
    );
    await buildApp(asUser("u_a"), f.repo, {}, (m) => enqueued.push(m)).handle(
      req("POST", "/api/workspaces/ws_1/invitations", { email: "bob@acme.com" }),
    );
    const { invitationId, token } = { invitationId: enqueued[0].invitationId, token: enqueued[0].token };
    const bob = buildApp(asUser("u_bob"), f.repo, { u_bob: "bob@acme.com" });
    const res = await bob.handle(req("POST", `/api/invitations/${invitationId}/accept`, { token }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.workspaceId).toBe("ws_1");
    expect(f.state.members.some((m) => m.userId === "u_bob")).toBe(true);
  });

  test("AS-012: accept by a different email is refused (uniform 404) and joins nobody", async () => {
    const f = fakeRepo();
    const enqueued: any[] = [];
    await buildApp(asUser("u_a"), f.repo, {}, (m) => enqueued.push(m)).handle(
      req("POST", "/api/workspaces", { name: "Acme" }),
    );
    await buildApp(asUser("u_a"), f.repo, {}, (m) => enqueued.push(m)).handle(
      req("POST", "/api/workspaces/ws_1/invitations", { email: "bob@acme.com" }),
    );
    const eve = buildApp(asUser("u_eve"), f.repo, { u_eve: "eve@acme.com" });
    const res = await eve.handle(
      req("POST", `/api/invitations/${enqueued[0].invitationId}/accept`, { token: enqueued[0].token }),
    );
    expect(res.status).toBe(404);
    expect(f.state.members.some((m) => m.userId === "u_eve")).toBe(false);
  });

  test("AS-011: POST /api/invitations/:id/reject leaves no membership", async () => {
    const f = fakeRepo();
    const enqueued: any[] = [];
    await buildApp(asUser("u_a"), f.repo, {}, (m) => enqueued.push(m)).handle(
      req("POST", "/api/workspaces", { name: "Acme" }),
    );
    await buildApp(asUser("u_a"), f.repo, {}, (m) => enqueued.push(m)).handle(
      req("POST", "/api/workspaces/ws_1/invitations", { email: "bob@acme.com" }),
    );
    const bob = buildApp(asUser("u_bob"), f.repo, { u_bob: "bob@acme.com" });
    const res = await bob.handle(
      req("POST", `/api/invitations/${enqueued[0].invitationId}/reject`, { token: enqueued[0].token }),
    );
    expect(res.status).toBe(200);
    expect(f.state.members.some((m) => m.userId === "u_bob")).toBe(false);
    expect(f.state.invitations[0]!.status).toBe("rejected");
  });

  test("no session → 401 on create", async () => {
    const f = fakeRepo();
    const app = buildApp(noSession, f.repo);
    const res = await app.handle(req("POST", "/api/workspaces", { name: "Acme" }));
    expect(res.status).toBe(401);
  });
});
