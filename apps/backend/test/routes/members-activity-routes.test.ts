// In-process route test for workspace-activity S-006: the `member_removed` event emitted when an
// admin removes a workspace member (C-005 completeness site — no dedicated AS). EMIT GLUE only
// (no DB): a fake ActivityRepo captures the row the DELETE /api/w/:workspaceId/members/:userId
// route writes post-commit; a fake TenancyRepo runs route→service without Postgres.
//
// C-005: each action logs exactly one event of its originating type (member_removed smoke).

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { TenancyRepo, WorkspaceRole } from "../../src/workspace/tenancy";
import type { SessionResolver, WorkspaceRoleResolver } from "../../src/http/auth-gate";
import type { NewActivity, ActivityRepo, ActivityRow } from "../../src/activity/repo";

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

/** Fake TenancyRepo seeded with two admins + one member (so removing one is allowed). */
function fakeTenancy() {
  const state = {
    members: [
      { userId: "u_admin", role: "admin" as WorkspaceRole },
      { userId: "u_admin2", role: "admin" as WorkspaceRole },
      { userId: "u_bob", role: "member" as WorkspaceRole },
    ],
  };
  const repo = {
    async findWorkspace(workspaceId: string) {
      return { id: workspaceId, name: "Acme", slug: "acme" };
    },
    async findMemberRole(_ws: string, userId: string) {
      return state.members.find((m) => m.userId === userId)?.role ?? null;
    },
    async removeMember(_ws: string, userId: string) {
      const before = state.members.length;
      state.members = state.members.filter((m) => m.userId !== userId);
      return state.members.length < before;
    },
    async countAdmins() {
      return state.members.filter((m) => m.role === "admin").length;
    },
  } as unknown as TenancyRepo;
  return { repo, state };
}

function buildApp(act: ReturnType<typeof fakeActivityRepo>, opts: { noActivity?: boolean } = {}) {
  const tenancy = fakeTenancy();
  const resolveWorkspaceRole: WorkspaceRoleResolver = async (_ws, userId) =>
    userId === "u_admin" ? "admin" : "member";
  return createApp({
    dbCheck: async () => {},
    members: {
      repo: tenancy.repo,
      resolveSession: asUser("u_admin"),
      resolveWorkspaceRole,
      activity: opts.noActivity
        ? undefined
        : {
            repo: act.repo,
            resolveActorName: async (userId) => (userId === "u_admin" ? "Ada" : null),
          },
    },
  });
}

function req(method: string, path: string) {
  return new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json" } });
}

describe("workspace-activity S-006: member_removed event (C-005)", () => {
  test("C-005: an admin removing a member logs ONE member_removed event", async () => {
    const act = fakeActivityRepo();
    const app = buildApp(act);
    const res = await app.handle(req("DELETE", "/api/w/ws_1/members/u_bob"));
    expect(res.status).toBe(200);

    const removed = act.rows.filter((r) => r.type === "member_removed");
    expect(removed).toHaveLength(1);
    expect(removed[0].actorUserId).toBe("u_admin");
    expect(removed[0].workspaceId).toBe("ws_1");
    expect(removed[0].docId ?? null).toBeNull();
  });

  test("C-002: removal still succeeds (200) with no activity block — no row, no throw", async () => {
    const act = fakeActivityRepo();
    const app = buildApp(act, { noActivity: true });
    const res = await app.handle(req("DELETE", "/api/w/ws_1/members/u_bob"));
    expect(res.status).toBe(200);
    expect(act.rows).toHaveLength(0);
  });
});
