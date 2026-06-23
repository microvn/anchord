// In-process route test for workspace-activity S-006: workspace-level events emitted by the
// workspace lifecycle routes — member join on invite-accept (AS-023), plus the completeness
// sites workspace_renamed and invite (C-005, no dedicated AS). EMIT GLUE only (no DB): a fake
// ActivityRepo captures the rows; a fake TenancyRepo runs route→service without Postgres.
//
// AS map (workspace-activity S-006):
//   AS-023  member join (invite-accept, the single join site F-11) → ONE `member` event naming the joiner
//   C-005   each action logs exactly one event of its originating type (member_renamed / invite smoke)

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { SessionResolver } from "../../src/http/auth-gate";
import type { NewActivity, ActivityRepo, ActivityRow } from "../../src/activity/repo";
import type { TenancyRepo } from "../../src/workspace/tenancy";

const asUser = (userId: string): SessionResolver => async () => ({ userId });

function fakeActivityRepo() {
  const rows: NewActivity[] = [];
  let seq = 0;
  const repo: ActivityRepo = {
    async insertActivity(input) {
      rows.push(input);
      return { id: `act_${++seq}` };
    },
    async countActivity() {
      return rows.length;
    },
    async listActivity() {
      return [] as ActivityRow[];
    },
    async listAllActivity() {
      return [] as ActivityRow[];
    },
    async getActivityById() {
      return null;
    },
    async listRelatedByDoc() {
      return [] as ActivityRow[];
    },
  };
  return { repo, rows };
}

/**
 * A TenancyRepo mirroring the real interface (matches test/routes/workspaces-routes.test.ts).
 * Seeded with workspace ws_1 ("Anchord"), u_admin as its admin, and one pending invite inv_1
 * (token "tok", to priya@x.com as member). The tenancy SERVICE drives accept via findInvitation
 * → addMember → setInvitationStatus, and rename via findMemberRole → setWorkspaceName.
 */
function fakeTenancyRepo() {
  const state = {
    workspaces: [{ id: "ws_1", name: "Anchord", slug: "anchord" }],
    members: [{ workspaceId: "ws_1", userId: "u_admin", role: "admin" as const }] as Array<{
      workspaceId: string;
      userId: string;
      role: "admin" | "member";
    }>,
    invitations: [
      { id: "inv_1", workspaceId: "ws_1", email: "priya@x.com", role: "member" as const, token: "tok", status: "pending", expiresAt: new Date(Date.now() + 1e9) },
    ] as Array<{ id: string; workspaceId: string; email: string; role: "admin" | "member"; token: string; status: string; expiresAt: Date }>,
  };
  let invN = 1;
  const repo = {
    async createWorkspace(input: { name: string; slug: string }) {
      const ws = { id: `ws_${state.workspaces.length + 1}`, name: input.name, slug: input.slug };
      state.workspaces.push(ws);
      return ws;
    },
    async addMember(workspaceId: string, userId: string, role: "admin" | "member") {
      if (!state.members.some((m) => m.workspaceId === workspaceId && m.userId === userId))
        state.members.push({ workspaceId, userId, role });
    },
    async setWorkspaceName(workspaceId: string, name: string) {
      const ws = state.workspaces.find((w) => w.id === workspaceId);
      if (ws) ws.name = name;
    },
    async findWorkspace(id: string) {
      return state.workspaces.find((w) => w.id === id) ?? null;
    },
    async findMemberRole(workspaceId: string, userId: string) {
      return state.members.find((m) => m.workspaceId === workspaceId && m.userId === userId)?.role ?? null;
    },
    async createInvitation(input: { workspaceId: string; email: string; role: "admin" | "member"; token: string }) {
      const inv = { id: `inv_${++invN}`, status: "pending", expiresAt: new Date(Date.now() + 1e9), ...input };
      state.invitations.push(inv);
      return { id: inv.id, token: input.token };
    },
    async findInvitation(id: string) {
      return state.invitations.find((i) => i.id === id) ?? null;
    },
    async setInvitationStatus(id: string, status: string) {
      const i = state.invitations.find((x) => x.id === id);
      if (i) i.status = status;
    },
    async countAdmins() {
      return 1;
    },
    async userName() {
      return null;
    },
  } as unknown as TenancyRepo;
  return { repo, state };
}

function buildApp(act: ReturnType<typeof fakeActivityRepo>, tenancy: ReturnType<typeof fakeTenancyRepo>, actor: string, opts: { noActivity?: boolean } = {}) {
  return createApp({
    dbCheck: async () => {},
    workspaces: {
      repo: tenancy.repo,
      resolveSession: asUser(actor),
      resolveActorEmail: async (userId) =>
        userId === "u_priya" ? { email: "priya@x.com" } : userId === "u_admin" ? { email: "admin@x.com" } : null,
      activity: opts.noActivity
        ? undefined
        : {
            repo: act.repo,
            resolveActorName: async (userId) =>
              userId === "u_priya" ? "Priya" : userId === "u_admin" ? "Ada" : null,
          },
    },
  });
}

function req(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, { headers: { "content-type": "application/json" }, ...init });
}

describe("workspace-activity S-006: member-join event (AS-023)", () => {
  test("AS-023/C-005/F-11: Priya accepting her invite logs ONE member-joined event naming her", async () => {
    const act = fakeActivityRepo();
    const tenancy = fakeTenancyRepo();
    const app = buildApp(act, tenancy, "u_priya");
    const res = await app.handle(
      req("/api/invitations/inv_1/accept", { method: "POST", body: JSON.stringify({ token: "tok" }) }),
    );
    expect(res.status).toBe(200);

    // Exactly one event, type=member (the join), workspace-level (no doc), actor = the joiner.
    const members = act.rows.filter((r) => r.type === "member");
    expect(members).toHaveLength(1);
    const row = members[0];
    expect(row.actorUserId).toBe("u_priya");
    expect(row.actorName).toBe("Priya");
    expect(row.workspaceId).toBe("ws_1");
    expect(row.docId ?? null).toBeNull();
    // meta.role = the role they joined as.
    expect((row.meta as any).role).toBe("member");
  });

  test("C-002: invite-accept still succeeds (200) with no activity block — no row, no throw", async () => {
    const act = fakeActivityRepo();
    const tenancy = fakeTenancyRepo();
    const app = buildApp(act, tenancy, "u_priya", { noActivity: true });
    const res = await app.handle(
      req("/api/invitations/inv_1/accept", { method: "POST", body: JSON.stringify({ token: "tok" }) }),
    );
    expect(res.status).toBe(200);
    expect(act.rows).toHaveLength(0);
  });
});

describe("workspace-activity S-006: workspace_renamed + invite completeness sites (C-005)", () => {
  test("C-005: renaming a workspace logs a workspace_renamed event", async () => {
    const act = fakeActivityRepo();
    const tenancy = fakeTenancyRepo();
    const app = buildApp(act, tenancy, "u_admin");
    const res = await app.handle(
      req("/api/workspaces/ws_1", { method: "PATCH", body: JSON.stringify({ name: "Anchord HQ" }) }),
    );
    expect(res.status).toBe(200);
    const renamed = act.rows.filter((r) => r.type === "workspace_renamed");
    expect(renamed).toHaveLength(1);
    expect(renamed[0].workspaceId).toBe("ws_1");
    expect(renamed[0].actorUserId).toBe("u_admin");
  });

  test("C-005: sending a workspace invite logs an invite event", async () => {
    const act = fakeActivityRepo();
    const tenancy = fakeTenancyRepo();
    const app = buildApp(act, tenancy, "u_admin");
    const res = await app.handle(
      req("/api/workspaces/ws_1/invitations", { method: "POST", body: JSON.stringify({ email: "newbie@x.com", role: "member" }) }),
    );
    expect(res.status).toBe(201);
    const invites = act.rows.filter((r) => r.type === "invite");
    expect(invites).toHaveLength(1);
    expect(invites[0].workspaceId).toBe("ws_1");
    expect(invites[0].actorUserId).toBe("u_admin");
  });
});
