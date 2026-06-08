// In-process route tests for the workspace-project S-002 /api/members mount (no DB).
// HTTP GLUE only — envelope + auth gate + requireWorkspaceAdmin + Zod + MemberRejected→
// DomainError mapping — via app.handle(Request)→Response with fake repos. The real-
// Postgres path (invite → signup → member; remove keeps the doc; admin takes over the
// share) is covered by test/integration/members.itest.ts.
//
// AS map (workspace-project S-002):
//   AS-003  admin invites a member → 201 { status: "invited" }.
//   AS-004  a member cannot invite / remove / list → 403 (handler never runs).
//   C-002   member-management is admin-only (the requireWorkspaceAdmin gate).
//   EDGE    no session → 401; forged {role:"admin"} in body is ignored (still 403).

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import {
  MemberRejected,
  type WorkspaceMembersRepo,
  type EnqueuedWorkspaceInvite,
} from "../../src/workspace/members";
import type { ProjectsRouteRepo } from "../../src/workspace/repo";
import type { SessionResolver } from "../../src/http/auth-gate";

const WS = "ws_1";
const asUser = (userId: string): SessionResolver => async () => ({ userId });
const noSession: SessionResolver = async () => null;

interface Membership {
  userId: string;
  role: "admin" | "member";
  name: string;
  email: string;
}

function fakeMembersRepo(seed: Membership[]) {
  const state = { members: [...seed], invites: [] as EnqueuedWorkspaceInvite[] };
  const repo: WorkspaceMembersRepo = {
    async listMembers() {
      return state.members.map((m) => ({ ...m }));
    },
    async findMemberRole(_ws, userId) {
      return state.members.find((m) => m.userId === userId)?.role ?? null;
    },
    async findMemberByEmail(_ws, email) {
      const m = state.members.find((x) => x.email === email);
      return m ? { userId: m.userId, role: m.role } : null;
    },
    async countAdmins() {
      return state.members.filter((m) => m.role === "admin").length;
    },
    async removeMember(_ws, userId) {
      const before = state.members.length;
      state.members = state.members.filter((m) => m.userId !== userId);
      return state.members.length < before;
    },
  };
  return { repo, state };
}

/** The members route group needs the single-workspace id + an admin check. Reuse the
 *  ProjectsRouteRepo ctx shape (it already carries currentWorkspaceId + isAdmin). */
function fakeCtx(admins: Set<string>): ProjectsRouteRepo {
  return {
    async currentWorkspaceId() {
      return WS;
    },
    async isAdmin(_ws, userId) {
      return admins.has(userId);
    },
    async isWorkspaceMember() {
      return true;
    },
    async isInvited() {
      return false;
    },
    async docsInProject() {
      return [];
    },
  };
}

function buildApp(
  resolveSession: SessionResolver,
  membersRepo: WorkspaceMembersRepo,
  admins: Set<string>,
  enqueueInvite?: (msg: EnqueuedWorkspaceInvite) => void,
) {
  return createApp({
    dbCheck: async () => {},
    members: { repo: membersRepo, ctx: fakeCtx(admins), resolveSession, enqueueInvite },
  });
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

describe("/api/members route glue (workspace-project S-002)", () => {
  test("AS-003: an admin invites dev@acme.com → 201 { status: 'invited' }, enqueued", async () => {
    const f = fakeMembersRepo([SEED[0]!]);
    const app = buildApp(asUser("u_admin"), f.repo, new Set(["u_admin"]), (m) =>
      f.state.invites.push(m),
    );
    const res = await app.handle(req("POST", "/api/members/invite", { email: "dev@acme.com" }));
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.data.status).toBe("invited");
    expect(f.state.invites[0]!.email).toBe("dev@acme.com");
    expect(f.state.invites[0]!.invitedBy).toBe("u_admin"); // server actor, not a body field
  });

  test("AS-004: a MEMBER cannot invite → 403 (handler never runs, nothing enqueued)", async () => {
    const f = fakeMembersRepo(SEED);
    const app = buildApp(asUser("u_dev"), f.repo, new Set(["u_admin"]));
    const res = await app.handle(req("POST", "/api/members/invite", { email: "x@acme.com" }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe("FORBIDDEN");
    expect(f.state.invites).toHaveLength(0);
  });

  test("AS-004: a member sending a forged {role:'admin'} body is STILL gated out → 403", async () => {
    const f = fakeMembersRepo(SEED);
    const app = buildApp(asUser("u_dev"), f.repo, new Set(["u_admin"]));
    const res = await app.handle(
      req("POST", "/api/members/invite", { email: "x@acme.com", role: "admin" }),
    );
    expect(res.status).toBe(403);
    expect(f.state.invites).toHaveLength(0);
  });

  test("AS-004: a member cannot remove a member → 403 (handler never runs, nobody removed)", async () => {
    const f = fakeMembersRepo(SEED);
    const app = buildApp(asUser("u_dev"), f.repo, new Set(["u_admin"]));
    const res = await app.handle(req("DELETE", "/api/members/u_admin"));
    expect(res.status).toBe(403);
    expect(f.state.members).toHaveLength(2); // nothing removed
  });

  test("AS-004: a member cannot list members → 403", async () => {
    const f = fakeMembersRepo(SEED);
    const app = buildApp(asUser("u_dev"), f.repo, new Set(["u_admin"]));
    const res = await app.handle(req("GET", "/api/members"));
    expect(res.status).toBe(403);
  });

  test("admin lists members → 200 { members: [...] }", async () => {
    const f = fakeMembersRepo(SEED);
    const app = buildApp(asUser("u_admin"), f.repo, new Set(["u_admin"]));
    const res = await app.handle(req("GET", "/api/members"));
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as any).data.members.map((m: any) => m.userId).sort();
    expect(ids).toEqual(["u_admin", "u_dev"]);
  });

  test("admin removes a member → 200; only that membership gone", async () => {
    const f = fakeMembersRepo(SEED);
    const app = buildApp(asUser("u_admin"), f.repo, new Set(["u_admin"]));
    const res = await app.handle(req("DELETE", "/api/members/u_dev"));
    expect(res.status).toBe(200);
    expect(f.state.members.map((m) => m.userId)).toEqual(["u_admin"]);
  });

  test("admin removing a non-member → 404 NOT_FOUND", async () => {
    const f = fakeMembersRepo(SEED);
    const app = buildApp(asUser("u_admin"), f.repo, new Set(["u_admin"]));
    const res = await app.handle(req("DELETE", "/api/members/u_ghost"));
    expect(res.status).toBe(404);
  });

  test("admin removing the SOLE admin (self) → 409 CONFLICT", async () => {
    const f = fakeMembersRepo([SEED[0]!]); // only the admin
    const app = buildApp(asUser("u_admin"), f.repo, new Set(["u_admin"]));
    const res = await app.handle(req("DELETE", "/api/members/u_admin"));
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.code).toBe("CONFLICT");
  });

  test("invalid email on invite → 400 VALIDATION_ERROR", async () => {
    const f = fakeMembersRepo([SEED[0]!]);
    const app = buildApp(asUser("u_admin"), f.repo, new Set(["u_admin"]));
    const res = await app.handle(req("POST", "/api/members/invite", { email: "not-an-email" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("VALIDATION_ERROR");
  });

  test("no session → 401 on every endpoint (handler never runs)", async () => {
    const f = fakeMembersRepo(SEED);
    const app = buildApp(noSession, f.repo, new Set(["u_admin"]));
    expect((await app.handle(req("GET", "/api/members"))).status).toBe(401);
    expect((await app.handle(req("POST", "/api/members/invite", { email: "a@b.com" }))).status).toBe(401);
    expect((await app.handle(req("DELETE", "/api/members/u_dev"))).status).toBe(401);
  });
});
