// Integration tier (guarded by RUN_INTEGRATION): workspaces S-004/S-005/S-006 over REAL
// Postgres. Proves on real rows:
//   S-001       — each signup auto-creates its OWN workspace (admin), not a shared one.
//   S-004       — admin invites by email → pending; invitee accepts (email match) → member;
//                 a mismatched email is refused; reject leaves no membership.
//   S-005       — admin lists members + pending invites; removes a member; the ≥1-admin
//                 invariant refuses removing the sole admin; non-admin is refused.
//   S-006/C-002 — a member of workspace A cannot read workspace B's members (cross-tenant).
//
// PRODUCTION FIDELITY: SAME createApp(deps) as src/index.ts — better-auth mounted; the
// onUserCreated hook auto-creating each user's own workspace; /api/workspaces,
// /api/invitations, and the path-scoped /api/w/:id/members wired to the REAL
// betterAuthSessionResolver + db-backed tenancy repo. Divergence: requireEmailVerification
// :false so sign-in issues a cookie in-process.
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/members.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { user as userTable, workspaceMembers } from "../../src/db/schema";
import { createApp } from "../../src/app";
import { betterAuthSessionResolver } from "../../src/http/auth-gate";
import { onUserCreated } from "../../src/auth/auth";
import { createProjectRepo } from "../../src/workspace/repo";
import { createTenancyRepo, createWorkspaceAccess } from "../../src/workspace/tenancy-repo";
import { findUserById } from "../../src/sharing/doc-member-repo";
import { withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;
const SECRET = "x".repeat(32);
const BASE_URL = "http://localhost";

function makeAuth(db: MigratedDb["db"]) {
  const tenancyRepo = createTenancyRepo(db);
  const projectRepo = createProjectRepo(db);
  return betterAuth({
    secret: SECRET,
    baseURL: BASE_URL,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: { enabled: true, requireEmailVerification: false, minPasswordLength: 8 },
    databaseHooks: {
      user: {
        create: {
          after: async (createdUser: { id: string }) => {
            await onUserCreated(createdUser.id, tenancyRepo, projectRepo);
          },
        },
      },
    },
  });
}

function authPost(path: string, body: unknown): Request {
  return new Request(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function setCookieToCookie(setCookie: string): string {
  return setCookie
    .split(/,(?=[^;]+=[^;]+)/)
    .map((c) => c.split(";")[0]!.trim())
    .join("; ");
}
function withCookie(path: string, cookie: string, method = "GET", body?: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new Request(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe.skipIf(!RUN)("workspaces S-004/S-005/S-006: membership (real Postgres)", () => {
  let h: MigratedDb;
  let app: ReturnType<typeof createApp>;
  let A: { userId: string; cookie: string };
  let B: { userId: string; cookie: string };
  let Eve: { userId: string; cookie: string };
  let WA = ""; // A's auto-created workspace
  const enqueued: Array<{ email: string; token: string; invitationId: string }> = [];

  async function signUpAndIn(email: string, name: string) {
    const password = "correct horse battery staple";
    const up = await app.handle(authPost("/api/auth/sign-up/email", { email, password, name }));
    expect(up.status).toBeLessThan(400);
    const inn = await app.handle(authPost("/api/auth/sign-in/email", { email, password }));
    expect(inn.status).toBeLessThan(400);
    const cookie = setCookieToCookie(inn.headers.get("set-cookie")!);
    const rows = await h.db.select().from(userTable).where(eq(userTable.email, email));
    return { userId: rows[0]!.id, cookie };
  }
  const email = (who: string) => `s5${who}-${process.pid}@itest.local`;
  async function workspaceOf(userId: string) {
    const [row] = await h.db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, userId));
    return row!.workspaceId;
  }

  beforeAll(async () => {
    h = await withMigratedDb();
    const auth = makeAuth(h.db);
    const resolveSession = betterAuthSessionResolver(auth);
    const wsAccess = createWorkspaceAccess(h.db);
    const resolveWorkspaceRole = (wsId: string, userId: string) => wsAccess.workspaceRoleOf(wsId, userId);

    app = createApp({
      dbCheck: async () => {},
      authHandler: auth.handler,
      workspaces: {
        db: h.db,
        resolveSession,
        resolveActorEmail: (userId: string) => findUserById(h.db, userId),
        enqueueInvite: (m) => enqueued.push(m),
      },
      members: { db: h.db, resolveSession, resolveWorkspaceRole },
    });

    A = await signUpAndIn(email("a"), "Alice");
    WA = await workspaceOf(A.userId);
    B = await signUpAndIn(email("b"), "Bob");
    Eve = await signUpAndIn(email("eve"), "Eve");
  });

  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  });

  test("AS-001: A signs up → its OWN workspace with A as admin (not a shared instance)", async () => {
    const [row] = await h.db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, A.userId));
    expect(row!.role).toBe("admin");
  });

  test("AS-002: B's signup did NOT join A's workspace — B is in its own", async () => {
    const wb = await workspaceOf(B.userId);
    expect(wb).not.toBe(WA);
    const inWA = await h.db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, B.userId));
    expect(inWA.some((m) => m.workspaceId === WA)).toBe(false);
  });

  test("AS-009/AS-010: A invites B by email → pending; B accepts (email match) → member of WA", async () => {
    enqueued.length = 0;
    const inv = await app.handle(
      withCookie(`/api/workspaces/${WA}/invitations`, A.cookie, "POST", { email: email("b") }),
    );
    expect(inv.status).toBe(201);
    expect(((await inv.json()) as any).data.status).toBe("pending");
    const e = enqueued[0]!;
    const accept = await app.handle(
      withCookie(`/api/invitations/${e.invitationId}/accept`, B.cookie, "POST", { token: e.token }),
    );
    expect(accept.status).toBe(200);
    const inWA = await h.db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, B.userId));
    expect(inWA.some((m) => m.workspaceId === WA && m.role === "member")).toBe(true);
  });

  test("AS-012: an invite accepted by a DIFFERENT email is refused (404); no membership", async () => {
    enqueued.length = 0;
    await app.handle(
      withCookie(`/api/workspaces/${WA}/invitations`, A.cookie, "POST", { email: "ghost@acme.com" }),
    );
    const e = enqueued[0]!;
    // Eve (a different email) tries to claim the invite issued to ghost@acme.com.
    const res = await app.handle(
      withCookie(`/api/invitations/${e.invitationId}/accept`, Eve.cookie, "POST", { token: e.token }),
    );
    expect(res.status).toBe(404);
    const inWA = await h.db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, Eve.userId));
    expect(inWA.some((m) => m.workspaceId === WA)).toBe(false);
  });

  test("AS-011: rejecting an invite leaves no membership", async () => {
    enqueued.length = 0;
    await app.handle(
      withCookie(`/api/workspaces/${WA}/invitations`, A.cookie, "POST", { email: email("eve") }),
    );
    const e = enqueued[0]!;
    const res = await app.handle(
      withCookie(`/api/invitations/${e.invitationId}/reject`, Eve.cookie, "POST", { token: e.token }),
    );
    expect(res.status).toBe(200);
    const inWA = await h.db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, Eve.userId));
    expect(inWA.some((m) => m.workspaceId === WA)).toBe(false);
  });

  test("AS-021: the admin lists WA members (A, B) + pending invitations", async () => {
    const res = await app.handle(withCookie(`/api/w/${WA}/members`, A.cookie));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    const ids = json.data.members.map((m: any) => m.userId);
    expect(ids).toEqual(expect.arrayContaining([A.userId, B.userId]));
    expect(Array.isArray(json.data.invitations)).toBe(true);
  });

  test("AS-017: a non-admin member (B) cannot list / remove → 403", async () => {
    const list = await app.handle(withCookie(`/api/w/${WA}/members`, B.cookie));
    expect(list.status).toBe(403);
    const rm = await app.handle(withCookie(`/api/w/${WA}/members/${A.userId}`, B.cookie, "DELETE"));
    expect(rm.status).toBe(403);
  });

  test("AS-014: the admin removes member B → 200; B loses WA membership", async () => {
    const res = await app.handle(withCookie(`/api/w/${WA}/members/${B.userId}`, A.cookie, "DELETE"));
    expect(res.status).toBe(200);
    const inWA = await h.db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, B.userId));
    expect(inWA.some((m) => m.workspaceId === WA)).toBe(false);
  });

  test("AS-016: the sole admin (A) cannot be removed → 409", async () => {
    const res = await app.handle(withCookie(`/api/w/${WA}/members/${A.userId}`, A.cookie, "DELETE"));
    expect(res.status).toBe(409);
  });

  test("AS-018/C-002: A cannot read another workspace's members (Eve's own workspace) → 404", async () => {
    const wEve = await workspaceOf(Eve.userId);
    const res = await app.handle(withCookie(`/api/w/${wEve}/members`, A.cookie));
    expect(res.status).toBe(404); // existence-hiding: A is not a member of Eve's workspace
  });
});
