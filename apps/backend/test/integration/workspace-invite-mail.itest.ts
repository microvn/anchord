// Integration tier (RUN_INTEGRATION): workspaces S-004 / AS-009 over REAL Postgres.
// Proves the Bug-1 wiring fix on real rows: inviting a member through createApp wired
// with the PRODUCTION enqueue (createEnqueueWorkspaceInvite over the shared MailQueue +
// a fake transport — the same builder src/index.ts injects) actually ENQUEUES and
// DELIVERS a workspace-invite email to the invitee carrying the accept link.
//
// Before the fix, src/index.ts assembled the workspaces deps WITHOUT enqueueInvite, so the
// route's `deps.enqueueInvite?.(...)` no-op'd: a 201 with a real pending row but no mail and
// no way in. This drives the real tenancy repo (real createInvitation token) so the link in
// the delivered mail points at the real invitation.
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/workspace-invite-mail.itest.ts

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
import { createTenancyRepo } from "../../src/workspace/tenancy-repo";
import { findUserById } from "../../src/sharing/doc-member-repo";
import { MailQueue, type MailMessage, type MailTransport } from "../../src/auth/mail-queue";
import { createEnqueueWorkspaceInvite } from "../../src/auth/mail-transport";
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

describe.skipIf(!RUN)("workspaces S-004 AS-009: invite enqueues mail (real Postgres)", () => {
  let h: MigratedDb;
  let app: ReturnType<typeof createApp>;
  let A: { userId: string; cookie: string };
  let WA = "";
  const sent: MailMessage[] = [];

  async function signUpAndIn(email: string, name: string) {
    const password = "correct horse battery staple";
    await app.handle(authPost("/api/auth/sign-up/email", { email, password, name }));
    const inn = await app.handle(authPost("/api/auth/sign-in/email", { email, password }));
    const cookie = setCookieToCookie(inn.headers.get("set-cookie")!);
    const rows = await h.db.select().from(userTable).where(eq(userTable.email, email));
    return { userId: rows[0]!.id, cookie };
  }
  const email = (who: string) => `wim${who}-${process.pid}@itest.local`;

  beforeAll(async () => {
    h = await withMigratedDb();
    const auth = makeAuth(h.db);
    const resolveSession = betterAuthSessionResolver(auth);

    // PRODUCTION enqueue wiring: the SAME createEnqueueWorkspaceInvite src/index.ts injects,
    // over a real MailQueue + a fake transport that records delivered mail.
    const queue = new MailQueue();
    const transport: MailTransport = {
      async send(msg) {
        sent.push(msg);
      },
    };

    app = createApp({
      dbCheck: async () => {},
      authHandler: auth.handler,
      workspaces: {
        db: h.db,
        resolveSession,
        resolveActorEmail: (userId: string) => findUserById(h.db, userId),
        enqueueInvite: createEnqueueWorkspaceInvite(queue, transport),
      },
    });

    A = await signUpAndIn(email("a"), "Alice");
    const [row] = await h.db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, A.userId));
    WA = row!.workspaceId;
  });

  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  });

  test("inviting bob enqueues + delivers a workspace-invite mail to bob with an accept link", async () => {
    sent.length = 0;
    const res = await app.handle(
      withCookie(`/api/workspaces/${WA}/invitations`, A.cookie, "POST", { email: email("bob") }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    // AS-011: the 201 surfaces the accept link too (email-independent join path).
    expect(json.data.acceptLink).toContain("/invite/workspace/");

    // The fire-and-forget queue.send drives delivery through the transport.
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(email("bob"));
    expect(sent[0]!.subject).toContain("workspace");
    expect(sent[0]!.text).toContain("/invite/workspace/");
    // The accept link in the mail points at the REAL invitation id (json.data.id).
    expect(sent[0]!.text).toContain(json.data.id);
  });
});
