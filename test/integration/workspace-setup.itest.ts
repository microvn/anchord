// Integration tier (guarded by RUN_INTEGRATION): workspace-project S-001 — first-run
// creates the single workspace + admin over real Postgres, and a LATER signup is a
// regular member via better-auth's user.create.after hook.
//
// This is the verification story the unit/route tests deferred: the in-tx
// single-workspace guard (C-001), the real workspace_members rows (admin vs member),
// and the auth member-on-signup hook firing on a real sign-up all need a REAL DB.
//
// PRODUCTION FIDELITY: SAME createApp(deps) composition as src/index.ts (better-auth
// mounted, the gated POST /api/setup wired to the REAL betterAuthSessionResolver and a
// db-backed WorkspaceRepo, the databaseHooks.user.create.after member hook). The ONE
// divergence is requireEmailVerification: prod sets it TRUE (blocks sign-IN until the
// emailed link is clicked); a pure API+HTTP test has no mailbox, so — exactly as
// auth-cookie.itest.ts documents — this builds the auth instance with verification NOT
// required AND wires the same member hook. The hook fires on user CREATE (sign-up),
// independent of verification, so the membership write under test is identical to prod.
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/workspace-setup.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { workspaces, workspaceMembers, user as userTable } from "../../src/db/schema";
import { createApp } from "../../src/app";
import { betterAuthSessionResolver } from "../../src/http/auth-gate";
import { onUserCreated } from "../../src/auth/auth";
import { createWorkspaceRepo } from "../../src/workspace/repo";
import { withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;
const SECRET = "x".repeat(32);
const BASE_URL = "http://localhost";

/**
 * Build the auth instance the way src/index.ts/createAuth does — INCLUDING the
 * workspace-project member-on-signup hook (onUserCreated) — but with verification off
 * so sign-in issues a cookie in-process (see header). Same adapter/session strategy as prod.
 */
function makeAuth(db: MigratedDb["db"]) {
  const workspaceRepo = createWorkspaceRepo(db);
  return betterAuth({
    secret: SECRET,
    baseURL: BASE_URL,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: { enabled: true, requireEmailVerification: false, minPasswordLength: 8 },
    databaseHooks: {
      user: {
        create: {
          after: async (createdUser: { id: string }) => {
            await onUserCreated(createdUser.id, workspaceRepo);
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

function setupReq(cookie: string | undefined, body: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new Request(`${BASE_URL}/api/setup`, { method: "POST", headers, body: JSON.stringify(body) });
}

describe.skipIf(!RUN)("workspace-project S-001: first-run + member-on-signup (real Postgres)", () => {
  let h: MigratedDb;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    h = await withMigratedDb();
    const auth = makeAuth(h.db);
    app = createApp({
      dbCheck: async () => {},
      authHandler: auth.handler,
      setup: { db: h.db, resolveSession: betterAuthSessionResolver(auth) },
    });
  });

  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  });

  async function signUpAndIn(email: string): Promise<{ userId: string; cookie: string }> {
    const password = "correct horse battery staple";
    const up = await app.handle(authPost("/api/auth/sign-up/email", { email, password, name: "User" }));
    expect(up.status).toBeLessThan(400);
    const inn = await app.handle(authPost("/api/auth/sign-in/email", { email, password }));
    expect(inn.status).toBeLessThan(400);
    const cookie = setCookieToCookie(inn.headers.get("set-cookie")!);
    const rows = await h.db.select().from(userTable).where(eq(userTable.email, email));
    return { userId: rows[0]!.id, cookie };
  }

  test("AS-001: sign up user A → POST /api/setup → A is admin + a single workspace row exists", async () => {
    const a = await signUpAndIn(`a-${process.pid}@itest.local`);

    const res = await app.handle(
      setupReq(a.cookie, { name: "Acme", settings: { providers: { github: true, google: true } } }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.data.name).toBe("Acme");

    // Exactly one workspace, settings persisted (GitHub+Google enabled).
    const ws = await h.db.select().from(workspaces);
    expect(ws).toHaveLength(1);
    expect((ws[0]!.settings as any).providers).toEqual({ github: true, google: true });

    // A is admin of that workspace.
    const aMembership = await h.db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, a.userId));
    expect(aMembership).toHaveLength(1);
    expect(aMembership[0]!.role).toBe("admin");
    expect(aMembership[0]!.workspaceId).toBe(ws[0]!.id);
  });

  test("AS-002: sign up user B AFTER the workspace exists → B is a regular member (not admin)", async () => {
    // The workspace already exists (created above). Signing up B fires the auth hook.
    const b = await signUpAndIn(`b-${process.pid}@itest.local`);

    const bMembership = await h.db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, b.userId));
    expect(bMembership).toHaveLength(1);
    expect(bMembership[0]!.role).toBe("member");

    // Still exactly one workspace, still exactly one admin.
    const ws = await h.db.select().from(workspaces);
    expect(ws).toHaveLength(1);
    const admins = await h.db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.role, "admin"));
    expect(admins).toHaveLength(1);
  });

  test("C-001: a second /api/setup once a workspace exists → 409 CONFLICT (no second workspace)", async () => {
    // Re-use B's cookie (a signed-in non-installer). Setup must refuse.
    const b = await signUpAndIn(`c-${process.pid}@itest.local`);
    const res = await app.handle(
      setupReq(b.cookie, { name: "Second", settings: { providers: { github: false, google: false } } }),
    );
    expect(res.status).toBe(409);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("CONFLICT");

    const ws = await h.db.select().from(workspaces);
    expect(ws).toHaveLength(1); // no second workspace
  });
});
