// In-process route tests for the workspaces S-005 /api/w/:workspaceId/members mount (no DB).
// HTTP GLUE only — envelope + auth gate + requireWorkspaceMember + admin re-check + Zod +
// TenancyRejected→DomainError mapping — via app.handle(Request)→Response with a fake
// TenancyRepo. The real-Postgres path is covered by test/integration/members.itest.ts.
//
// AS map (workspaces S-005):
//   AS-021  an admin sees the member list + pending invitations.
//   AS-014  an admin removes a member.
//   AS-015  an admin promotes a member to admin (more than one admin allowed).
//   AS-016  the last admin cannot be removed or demoted → 409.
//   AS-017  a non-admin cannot remove / change-role / list → 403.

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { TenancyRepo, WorkspaceRole } from "../../src/workspace/tenancy";
import type { SessionResolver, WorkspaceRoleResolver } from "../../src/http/auth-gate";
import type { NotifyRepo, NewNotification, MailEnqueuer } from "../../src/notify/notify";

const asUser = (userId: string): SessionResolver => async () => ({ userId });
const noSession: SessionResolver = async () => null;

interface Membership {
  userId: string;
  role: WorkspaceRole;
  name: string;
  email: string;
}

/** A fake TenancyRepo seeded with members + invitations (only the methods members uses). */
function fakeTenancy(seed: Membership[]) {
  const state = {
    members: seed.map((m) => ({ ...m })),
    invitations: [
      { id: "inv_1", email: "eve@acme.com", role: "member" as WorkspaceRole, status: "pending" as const },
    ],
  };
  const repo = {
    async findWorkspace(workspaceId: string) {
      return { id: workspaceId, name: "Acme", slug: "acme" };
    },
    async findMemberRole(_ws: string, userId: string) {
      return state.members.find((m) => m.userId === userId)?.role ?? null;
    },
    async setMemberRole(_ws: string, userId: string, role: WorkspaceRole) {
      const m = state.members.find((x) => x.userId === userId);
      if (m) m.role = role;
    },
    async removeMember(_ws: string, userId: string) {
      const before = state.members.length;
      state.members = state.members.filter((m) => m.userId !== userId);
      return state.members.length < before;
    },
    async countAdmins() {
      return state.members.filter((m) => m.role === "admin").length;
    },
    async listMembers() {
      return state.members.map((m) => ({ ...m }));
    },
    async listInvitations() {
      return state.invitations.map((i) => ({ ...i }));
    },
  } as unknown as TenancyRepo;
  return { repo, state };
}

function buildApp(
  resolveSession: SessionResolver,
  repo: TenancyRepo,
  admins: Set<string>,
  notify?: { repo?: NotifyRepo; mail: MailEnqueuer; appUrl?: string },
) {
  const resolveWorkspaceRole: WorkspaceRoleResolver = async (_ws, userId) =>
    // A signed-in user is a member of the workspace (the gate); admins are in the set.
    admins.has(userId) ? "admin" : "member";
  return createApp({
    dbCheck: async () => {},
    members: { repo, resolveSession, resolveWorkspaceRole, notify },
  });
}

/**
 * A recording NotifyRepo for the route's removed-member notice (S-003). Only the methods the
 * removal path uses are real: getUserEmail (the PRE-delete email snapshot) + insertNotification
 * (the in-app row). `emailByUser` seeds the snapshot; `throwOnInsert` proves best-effort (AS-008).
 */
function fakeNotify(opts: { emailByUser?: Record<string, string>; throwOnInsert?: boolean }) {
  const inserted: NewNotification[] = [];
  const sent: { to: string; subject: string; text?: string }[] = [];
  const repo = {
    async listParticipantIds() { return []; },
    async getDocOwnerId() { return null; },
    async getUserEmail(userId: string) { return opts.emailByUser?.[userId] ?? null; },
    async insertNotification(input: NewNotification) {
      if (opts.throwOnInsert) throw new Error("notify db boom");
      inserted.push(input);
      return { id: `n_${inserted.length}` };
    },
  } as unknown as NotifyRepo;
  const mail: MailEnqueuer = {
    enqueue(msg) {
      sent.push(msg);
      return `mail_${sent.length}`;
    },
  };
  return { repo, mail, inserted, sent };
}

function req(method: string, path: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const SEED: Membership[] = [
  { userId: "u_admin", role: "admin", name: "Admin", email: "admin@acme.com" },
  { userId: "u_dev", role: "member", name: "Dev", email: "dev@acme.com" },
];

describe("/api/w/:workspaceId/members route glue (workspaces S-005)", () => {
  test("AS-021: an admin sees the member list + pending invitations", async () => {
    const f = fakeTenancy(SEED);
    const app = buildApp(asUser("u_admin"), f.repo, new Set(["u_admin"]));
    const res = await app.handle(req("GET", "/api/w/ws_1/members"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    const ids = json.data.members.map((m: any) => m.userId).sort();
    expect(ids).toEqual(["u_admin", "u_dev"]);
    expect(json.data.invitations[0].email).toBe("eve@acme.com");
    expect(json.data.invitations[0].status).toBe("pending");
  });

  test("AS-017: a non-admin member cannot list members → 403", async () => {
    const f = fakeTenancy(SEED);
    const app = buildApp(asUser("u_dev"), f.repo, new Set(["u_admin"]));
    const res = await app.handle(req("GET", "/api/w/ws_1/members"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe("FORBIDDEN");
  });

  test("AS-014: an admin removes a member → 200; only that membership gone", async () => {
    const f = fakeTenancy(SEED);
    const app = buildApp(asUser("u_admin"), f.repo, new Set(["u_admin"]));
    const res = await app.handle(req("DELETE", "/api/w/ws_1/members/u_dev"));
    expect(res.status).toBe(200);
    expect(f.state.members.map((m) => m.userId)).toEqual(["u_admin"]);
  });

  test("AS-017: a non-admin member cannot remove a member → 403 (nobody removed)", async () => {
    const f = fakeTenancy(SEED);
    const app = buildApp(asUser("u_dev"), f.repo, new Set(["u_admin"]));
    const res = await app.handle(req("DELETE", "/api/w/ws_1/members/u_admin"));
    expect(res.status).toBe(403);
    expect(f.state.members).toHaveLength(2);
  });

  test("AS-015: an admin promotes a member to admin (more than one admin allowed)", async () => {
    const f = fakeTenancy(SEED);
    const app = buildApp(asUser("u_admin"), f.repo, new Set(["u_admin"]));
    const res = await app.handle(req("PATCH", "/api/w/ws_1/members/u_dev", { role: "admin" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.role).toBe("admin");
    expect(f.state.members.filter((m) => m.role === "admin")).toHaveLength(2);
  });

  test("AS-016: the last admin cannot be removed → 409 CONFLICT", async () => {
    const f = fakeTenancy([SEED[0]!]); // only the admin
    const app = buildApp(asUser("u_admin"), f.repo, new Set(["u_admin"]));
    const res = await app.handle(req("DELETE", "/api/w/ws_1/members/u_admin"));
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.code).toBe("CONFLICT");
  });

  test("AS-016: the last admin cannot be demoted to member → 409 CONFLICT", async () => {
    const f = fakeTenancy([SEED[0]!]);
    const app = buildApp(asUser("u_admin"), f.repo, new Set(["u_admin"]));
    const res = await app.handle(req("PATCH", "/api/w/ws_1/members/u_admin", { role: "member" }));
    expect(res.status).toBe(409);
  });

  test("AS-017: a non-admin member cannot change a role → 403", async () => {
    const f = fakeTenancy(SEED);
    const app = buildApp(asUser("u_dev"), f.repo, new Set(["u_admin"]));
    const res = await app.handle(req("PATCH", "/api/w/ws_1/members/u_admin", { role: "member" }));
    expect(res.status).toBe(403);
  });

  test("admin removing a non-member → 404 NOT_FOUND", async () => {
    const f = fakeTenancy(SEED);
    const app = buildApp(asUser("u_admin"), f.repo, new Set(["u_admin"]));
    const res = await app.handle(req("DELETE", "/api/w/ws_1/members/u_ghost"));
    expect(res.status).toBe(404);
  });

  test("no session → 401 on every endpoint (handler never runs)", async () => {
    const f = fakeTenancy(SEED);
    const app = buildApp(noSession, f.repo, new Set(["u_admin"]));
    expect((await app.handle(req("GET", "/api/w/ws_1/members"))).status).toBe(401);
    expect((await app.handle(req("DELETE", "/api/w/ws_1/members/u_dev"))).status).toBe(401);
    expect(
      (await app.handle(req("PATCH", "/api/w/ws_1/members/u_dev", { role: "admin" }))).status,
    ).toBe(401);
  });
});

// workspace-notifications S-003: the DELETE handler dispatches a removed-member notice (in-app +
// email) using a PRE-delete snapshot of the workspace name + the target's email. Best-effort:
// notify never fails the removal. The notice goes to the removed user only — never the admin.
describe("/api/w/:workspaceId/members removed-member notice (workspace-notifications S-003)", () => {
  test("AS-005.T1/T2: removing a member dispatches ONE in-app row + ONE email to the removed user", async () => {
    const f = fakeTenancy(SEED);
    const n = fakeNotify({ emailByUser: { u_dev: "dev@acme.com" } });
    const app = buildApp(asUser("u_admin"), f.repo, new Set(["u_admin"]), {
      repo: n.repo,
      mail: n.mail,
      appUrl: "https://anchord.example.com",
    });

    const res = await app.handle(req("DELETE", "/api/w/ws_1/members/u_dev"));
    expect(res.status).toBe(200);
    expect(f.state.members.map((m) => m.userId)).toEqual(["u_admin"]); // removed
    // in-app row to the removed user, workspace-shaped refId + sanitized name as refLabel.
    expect(n.inserted).toHaveLength(1);
    expect(n.inserted[0].userId).toBe("u_dev");
    expect(n.inserted[0].type).toBe("workspace_member_removed");
    expect(n.inserted[0].refId).toBe("ws_1");
    expect(n.inserted[0].refLabel).toBe("Acme");
    // one email, removal-titled, workspace-shaped deep-link.
    expect(n.sent).toHaveLength(1);
    expect(n.sent[0].to).toBe("dev@acme.com");
    expect(n.sent[0].subject).toMatch(/removed/i);
    expect(n.sent[0].text).toContain("/w/ws_1");
  });

  test("AS-005.T3 / C-002: the removing admin gets no row and no email", async () => {
    const f = fakeTenancy(SEED);
    const n = fakeNotify({ emailByUser: { u_dev: "dev@acme.com", u_admin: "admin@acme.com" } });
    const app = buildApp(asUser("u_admin"), f.repo, new Set(["u_admin"]), {
      repo: n.repo,
      mail: n.mail,
      appUrl: "https://anchord.example.com",
    });

    await app.handle(req("DELETE", "/api/w/ws_1/members/u_dev"));

    expect(n.inserted.map((r) => r.userId)).toEqual(["u_dev"]);
    expect(n.sent.map((m) => m.to)).toEqual(["dev@acme.com"]);
  });

  test("AS-006 / C-003: the email snapshot is read PRE-delete so the removed user is still reachable", async () => {
    // getUserEmail is captured at snapshot time (before removeMember runs). Spy on call order:
    // the email read must happen while the member still exists, and the notice must still reach them.
    const f = fakeTenancy(SEED);
    const n = fakeNotify({ emailByUser: { u_dev: "dev@acme.com" } });
    let memberCountWhenEmailRead = -1;
    const origGetEmail = n.repo.getUserEmail.bind(n.repo);
    n.repo.getUserEmail = async (userId: string) => {
      // Record the FIRST read only (the pre-delete snapshot); deliverToRecipients reads again
      // post-delete for the email channel, which is fine — the user row survives the membership delete.
      if (memberCountWhenEmailRead === -1) memberCountWhenEmailRead = f.state.members.length;
      return origGetEmail(userId);
    };
    const app = buildApp(asUser("u_admin"), f.repo, new Set(["u_admin"]), {
      repo: n.repo,
      mail: n.mail,
      appUrl: "https://anchord.example.com",
    });

    const res = await app.handle(req("DELETE", "/api/w/ws_1/members/u_dev"));
    expect(res.status).toBe(200);
    // The email was snapshotted while u_dev was STILL a member (2 members present).
    expect(memberCountWhenEmailRead).toBe(2);
    // And the removed user still got the notice despite their now-deleted membership.
    expect(n.sent.map((m) => m.to)).toEqual(["dev@acme.com"]);
    expect(n.inserted[0].userId).toBe("u_dev");
  });

  test("AS-008 / C-004: a throwing notify dispatch does NOT fail the removal (still 200, member gone)", async () => {
    const f = fakeTenancy(SEED);
    const n = fakeNotify({ emailByUser: { u_dev: "dev@acme.com" }, throwOnInsert: true });
    const app = buildApp(asUser("u_admin"), f.repo, new Set(["u_admin"]), {
      repo: n.repo,
      mail: n.mail,
      appUrl: "https://anchord.example.com",
    });

    const res = await app.handle(req("DELETE", "/api/w/ws_1/members/u_dev"));
    expect(res.status).toBe(200);
    expect((await res.json()).data.removed).toBe(true);
    // The removal committed even though the notify insert threw (swallowed best-effort).
    expect(f.state.members.map((m) => m.userId)).toEqual(["u_admin"]);
  });
});
