// Integration tier (guarded by RUN_INTEGRATION): workspace-project S-002 over REAL
// Postgres. Proves the parts the unit/route tests defer to a DB:
//   AS-003       — admin A invites dev@acme.com (admin-gated OK); dev signs up → member.
//   AS-004       — a plain member B inviting / removing → 403 (member-management is admin-only).
//   AS-012/C-007 — M owns an anyone_in_workspace doc; A removes M → (1) the doc still sits in
//                  its project, (2) another member still resolves access to it, (3) the admin
//                  can manage its sharing (the owner is gone → admin is the fallback), (4) M
//                  (now a non-member) can no longer manage it.
//
// PRODUCTION FIDELITY: SAME createApp(deps) composition as src/index.ts — better-auth
// mounted; the onUserCreated hook that makes every signup a member; the gated /api/setup,
// /api/members, /api/projects, /api/docs, /api/sharing wired to the REAL
// betterAuthSessionResolver + db-backed repos + the workspace-admin override. The one
// divergence (as the sibling itests document) is requireEmailVerification:false so sign-in
// issues a cookie in-process; the create hook fires on sign-up regardless.
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/members.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { docs, projects, user as userTable, workspaceMembers } from "../../src/db/schema";
import { createApp } from "../../src/app";
import { betterAuthSessionResolver } from "../../src/http/auth-gate";
import { onUserCreated } from "../../src/auth/auth";
import {
  createWorkspaceRepo,
  createProjectRepo,
  createProjectsRouteRepo,
} from "../../src/workspace/repo";
import {
  createResolveDocRole,
  createLoadShareConfig,
  createIsDocOwner,
} from "../../src/sharing/resolve-doc-role-repo";
import { withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;
const SECRET = "x".repeat(32);
const BASE_URL = "http://localhost";

function makeAuth(db: MigratedDb["db"]) {
  const workspaceRepo = createWorkspaceRepo(db);
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
            await onUserCreated(createdUser.id, workspaceRepo, projectRepo);
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

describe.skipIf(!RUN)("workspace-project S-002: member management (real Postgres)", () => {
  let h: MigratedDb;
  let app: ReturnType<typeof createApp>;
  let A: { userId: string; cookie: string }; // admin (installer)
  let B: { userId: string; cookie: string }; // plain member (does the AS-004 denials)
  let M: { userId: string; cookie: string }; // member who owns a doc, then is removed
  let dev: { userId: string; cookie: string }; // the invited member (AS-003)

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

  const email = (who: string) => `s2${who}-${process.pid}@itest.local`;

  beforeAll(async () => {
    h = await withMigratedDb();
    const auth = makeAuth(h.db);
    const resolveSession = betterAuthSessionResolver(auth);

    // Real workspace-membership reads (S-002): drive isWorkspaceMember + the admin override.
    const workspaceCtx = createProjectsRouteRepo(h.db);
    const isWorkspaceMember = (userId: string) => workspaceCtx.isWorkspaceMember(userId);
    const isWorkspaceAdmin = async (userId: string): Promise<boolean> => {
      const wsId = await workspaceCtx.currentWorkspaceId();
      return wsId ? workspaceCtx.isAdmin(wsId, userId) : false;
    };
    // S-002 membership-gated owner source (mirrors src/index.ts sharingResolveDocRole):
    // owner_id stays set on removal, but a non-member owner can no longer manage sharing →
    // the admin override is the fallback. This is what makes AS-012 point (4) true for M.
    const docOwner = createIsDocOwner(h.db);
    const resolveDocRole = createResolveDocRole(h.db, {
      isOwner: async (docId: string, userId: string) =>
        (await docOwner(docId, userId)) && (await isWorkspaceMember(userId)),
      isWorkspaceMember,
    });
    const loadShareConfig = createLoadShareConfig(h.db);
    const accessDeps = { isInvited: () => true, isWorkspaceMember: () => true };

    app = createApp({
      dbCheck: async () => {},
      authHandler: auth.handler,
      setup: { db: h.db, resolveSession },
      members: { db: h.db, resolveSession },
      projects: { db: h.db, resolveSession },
      docs: { db: h.db, resolveSession },
      sharing: { db: h.db, resolveSession, resolveDocRole, loadShareConfig, accessDeps, isWorkspaceAdmin },
    });

    A = await signUpAndIn(email("a"), "Alice");
    const setup = await app.handle(
      withCookie("/api/setup", A.cookie, "POST", {
        name: "Acme",
        settings: { providers: { github: false, google: false } },
      }),
    );
    expect(setup.status).toBe(201);

    B = await signUpAndIn(email("b"), "Bob");
    M = await signUpAndIn(email("m"), "Mallory");
  });

  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  });

  test("AS-003: B signs up → joins as a MEMBER (role member, not admin)", async () => {
    const [row] = await h.db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, B.userId));
    expect(row!.role).toBe("member");
  });

  test("AS-003: admin A invites dev@acme.com (admin-gated OK); dev then signs up → member", async () => {
    const devEmail = email("dev");
    const invite = await app.handle(
      withCookie("/api/members/invite", A.cookie, "POST", { email: devEmail }),
    );
    expect(invite.status).toBe(201);
    expect(((await invite.json()) as any).data.status).toBe("invited");

    // The membership materializes on the invitee's signup (live onUserCreated hook).
    dev = await signUpAndIn(devEmail, "Dev");
    const [row] = await h.db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, dev.userId));
    expect(row!.role).toBe("member");
  });

  test("AS-004: a plain member B cannot invite → 403 (member-management is admin-only)", async () => {
    const res = await app.handle(
      withCookie("/api/members/invite", B.cookie, "POST", { email: "nope@acme.com" }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe("FORBIDDEN");
  });

  test("AS-004: a plain member B cannot remove a member → 403", async () => {
    const res = await app.handle(withCookie(`/api/members/${M.userId}`, B.cookie, "DELETE"));
    expect(res.status).toBe(403);
  });

  test("AS-004: a plain member B cannot list the member directory → 403", async () => {
    const res = await app.handle(withCookie("/api/members", B.cookie));
    expect(res.status).toBe(403);
  });

  test("the admin A can list the member directory → 200 (includes A, B, M, dev)", async () => {
    const res = await app.handle(withCookie("/api/members", A.cookie));
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as any).data.members.map((m: any) => m.userId);
    expect(ids).toEqual(expect.arrayContaining([A.userId, B.userId, M.userId, dev.userId]));
  });

  describe("AS-012 / C-007: removing M keeps M's doc; the admin takes over its share", () => {
    let docId: string;
    let docSlug: string;
    let projectId: string;

    test("setup: M owns an anyone_in_workspace doc in a project", async () => {
      const pub = await app.handle(
        withCookie("/api/docs", M.cookie, "POST", {
          content: "# M's shared doc\nrefund policy",
          title: "M Shared",
        }),
      );
      expect(pub.status).toBe(201);
      const data = (await pub.json()) as any;
      docId = data.data.docId;
      docSlug = data.data.slug;
      const [row] = await h.db.select().from(docs).where(eq(docs.id, docId));
      expect(row!.ownerId).toBe(M.userId);
      projectId = row!.projectId!;
      await h.db.update(docs).set({ generalAccess: "anyone_in_workspace" }).where(eq(docs.id, docId));
    });

    test("the admin A removes M → 200", async () => {
      const res = await app.handle(withCookie(`/api/members/${M.userId}`, A.cookie, "DELETE"));
      expect(res.status).toBe(200);
      // M's membership row is gone…
      const mRows = await h.db
        .select()
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, M.userId));
      expect(mRows).toHaveLength(0);
      // …but M's user row and doc survive (C-007: never deleted).
      const uRows = await h.db.select().from(userTable).where(eq(userTable.id, M.userId));
      expect(uRows).toHaveLength(1);
    });

    test("C-007: the doc still sits in its project/workspace after M is removed", async () => {
      const [row] = await h.db.select().from(docs).where(eq(docs.id, docId));
      expect(row).toBeTruthy();
      expect(row!.projectId).toBe(projectId);
    });

    test("AS-012: another member (B) still resolves access to the anyone_in_workspace doc", async () => {
      // B is a workspace member → resolveDocRole grants the link role on anyone_in_workspace.
      const browse = await app.handle(withCookie(`/api/projects/${projectId}/docs`, B.cookie));
      expect(browse.status).toBe(200);
      const titles = ((await browse.json()) as any).data.docs.map((d: any) => d.title);
      expect(titles).toContain("M Shared");
    });

    test("AS-012: the admin A can manage the doc's sharing (fallback owner)", async () => {
      const res = await app.handle(
        withCookie(`/api/docs/${docSlug}/access`, A.cookie, "PUT", {
          level: "anyone_with_link",
          role: "viewer",
        }),
      );
      expect(res.status).toBe(200);
      const [row] = await h.db.select().from(docs).where(eq(docs.id, docId));
      expect(row!.generalAccess).toBe("anyone_with_link");
    });

    test("AS-012 (4): M (now a non-member) can no longer manage the share → 403", async () => {
      // M still holds docs.owner_id, but the membership-gated owner source denies a
      // non-member owner → M's manage-sharing authority is gone (the admin took over).
      const resM = await app.handle(
        withCookie(`/api/docs/${docSlug}/access`, M.cookie, "PUT", {
          level: "restricted",
          role: "viewer",
        }),
      );
      expect(resM.status).toBe(403);
      // And a plain member B (never owner, not admin) also cannot manage it → 403.
      const resB = await app.handle(
        withCookie(`/api/docs/${docSlug}/access`, B.cookie, "PUT", {
          level: "restricted",
          role: "viewer",
        }),
      );
      expect(resB.status).toBe(403);
    });
  });
});
