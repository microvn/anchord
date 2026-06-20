// Integration tier (guarded by RUN_INTEGRATION): auth S-001/S-005 wiring — the three
// seams that were SPECCED + unit-tested but never connected to the live better-auth
// instance. This is the proof they now fire end-to-end on real Postgres:
//
//   SEAM 1 (AS-001/AS-012): createAuth's emailVerification block sends a verification
//     email on sign-up (without it, requireEmailVerification:true permanently blocks
//     sign-in). After verifying, the user can sign in.
//   SEAM 2 (AS-008): afterEmailVerification activates a pending invite for the verified
//     email → the invited role lands on the doc.
//   SEAM 3 (AS-011): a pending invite is acceptable via POST /api/invite/accept using
//     the email-independent accept-link, gated on the SESSION actor's verified email.
//
// PRODUCTION FIDELITY: the auth instance is built with the SAME createAuth(...) the
// production index.ts uses, INCLUDING the emailVerification block — the only divergence
// is a FAKE mail transport that captures sent mail instead of hitting Resend/SMTP (so
// the test has a "mailbox" to read the verify token + accept-link out of). The pending-
// invite repo, the accept route, and the session resolver are all the concrete prod wiring.
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/auth-wiring.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { docs, docMembers, user as userTable } from "../../src/db/schema";
import { createApp } from "../../src/app";
import { createAuth } from "../../src/auth/auth";
import { betterAuthSessionResolver } from "../../src/http/auth-gate";
import { MailQueue, type MailMessage, type MailTransport } from "../../src/auth/mail-queue";
import { createDocMemberRepo, findUserById } from "../../src/sharing/doc-member-repo";
import { createDocMembersPendingInviteRepo } from "../../src/sharing/invite";
import { mintInviteToken } from "../../src/auth/invite-token";
import { withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;

const SECRET = "x".repeat(32);
const BASE_URL = "http://localhost";

/** A fake mail transport that captures every message sent through the queue. */
function captureTransport(): MailTransport & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    async send(msg: MailMessage): Promise<void> {
      sent.push(msg);
    },
  };
}

function authPost(path: string, body: unknown): Request {
  return new Request(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Reduce a Set-Cookie header to a replayable Cookie header (name=value pairs, no attrs). */
function setCookieToCookie(setCookie: string): string {
  return setCookie
    .split(/,(?=[^;]+=[^;]+)/)
    .map((c) => c.split(";")[0]!.trim())
    .join("; ");
}

/** Pull the first http(s) URL out of a verify/invite mail body (S-007: plain text now, no href). */
function urlFromBody(body: string | undefined): string {
  const text = body ?? "";
  // Prefer an href if a future HTML body sets one; otherwise grab the first bare http(s) URL.
  const href = text.match(/href="([^"]+)"/);
  if (href) return href[1]!;
  const bare = text.match(/https?:\/\/\S+/);
  if (!bare) throw new Error(`no link found in mail body: ${text}`);
  return bare[0]!;
}

describe.skipIf(!RUN)("auth wiring S-001/S-005: verification + invite-on-verify + accept-link (real Postgres)", () => {
  let h: MigratedDb;
  let transport: ReturnType<typeof captureTransport>;
  let queue: MailQueue;
  let auth: ReturnType<typeof createAuth>;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    h = await withMigratedDb();
    transport = captureTransport();
    queue = new MailQueue();
    const pendingInviteRepo = createDocMembersPendingInviteRepo(createDocMemberRepo(h.db));

    // SAME composition as src/index.ts: createAuth with the REAL emailVerification block
    // (capturing transport), the better-auth handler mounted, and the invite accept route
    // wired to the concrete repo + a session-resolved actor email.
    auth = createAuth(h.db, {
      secret: SECRET,
      baseURL: BASE_URL,
      emailVerification: { queue, transport, pendingInviteRepo },
      // Many sign-up/sign-in calls share one in-process instance in a single window; turn
      // the brute-force limiter off so it doesn't 429 the test's own legitimate calls.
      rateLimitEnabled: false,
    });
    app = createApp({
      dbCheck: async () => {},
      authHandler: auth.handler,
      invite: {
        db: h.db,
        resolveSession: betterAuthSessionResolver(auth),
        pendingInviteRepo,
        resolveActorEmail: (userId: string) => findUserById(h.db, userId),
        secret: SECRET,
      },
    });
  });

  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  });

  /** Sign up over the mounted /api/auth/* (real HTTP path). */
  async function signUp(email: string): Promise<void> {
    const res = await app.handle(
      authPost("/api/auth/sign-up/email", { email, password: "correct horse battery staple", name: "User" }),
    );
    expect(res.status).toBeLessThan(400);
  }

  /** Drive better-auth's verify endpoint with a token (GET /api/auth/verify-email?token=). */
  async function verifyToken(token: string): Promise<void> {
    const res = await app.handle(
      new Request(`${BASE_URL}/api/auth/verify-email?token=${encodeURIComponent(token)}`, { method: "GET" }),
    );
    // better-auth redirects (302) on a successful verify (or 200) — either is success.
    expect(res.status).toBeLessThan(400);
  }

  test("AS-001/AS-012: email+password sign-up enqueues a verification email; the user is unverified until verified", async () => {
    const email = `as001-${process.pid}@itest.local`;
    const before = transport.sent.length;
    await signUp(email);

    // The fake transport captured a verification email to that address.
    const verifyMail = transport.sent.slice(before).find((m) => m.to === email && /verify/i.test(m.subject));
    expect(verifyMail).toBeDefined();
    // It carries a usable verify URL with a token (AS-012 — the deliverable artifact).
    const url = urlFromBody(verifyMail!.text);
    expect(url).toContain("/verify-email");
    expect(url).toContain("token=");

    // The user row exists but is NOT yet verified (requireEmailVerification gate).
    const rows = await h.db.select().from(userTable).where(eq(userTable.email, email));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.emailVerified).toBe(false);
  });

  test("AS-001: after verifying, the user can sign in", async () => {
    const email = `as001b-${process.pid}@itest.local`;
    const before = transport.sent.length;
    await signUp(email);

    // Before verifying, sign-in is blocked (requireEmailVerification).
    const blocked = await app.handle(
      authPost("/api/auth/sign-in/email", { email, password: "correct horse battery staple" }),
    );
    expect(blocked.status).toBeGreaterThanOrEqual(400);

    // Verify via the real token captured from the verify mail.
    const verifyMail = transport.sent.slice(before).find((m) => m.to === email);
    const url = new URL(urlFromBody(verifyMail!.text));
    const token = url.searchParams.get("token");
    expect(token).toBeTruthy();
    await verifyToken(token!);

    const verified = await h.db.select().from(userTable).where(eq(userTable.email, email));
    expect(verified[0]!.emailVerified).toBe(true);

    // Now sign-in succeeds and issues a session cookie.
    const signIn = await app.handle(
      authPost("/api/auth/sign-in/email", { email, password: "correct horse battery staple" }),
    );
    expect(signIn.status).toBeLessThan(400);
    const setCookie = signIn.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookieToCookie(setCookie!)).toContain("session_token");
  });

  test("AS-008: signing up with a pending-invited email + verifying activates the invited role", async () => {
    const bob = `bob-${process.pid}@itest.local`;

    // Seed an inviter + a doc + a PENDING editor invite for Bob (the sharing repo shape).
    const [inviter] = await h.db
      .insert(userTable)
      .values({ id: `inviter-${process.pid}`, name: "Inviter", email: `inviter-${process.pid}@itest.local`, emailVerified: true })
      .returning();
    const [doc] = await h.db
      .insert(docs)
      .values({ slug: `as008-${process.pid}`, title: "Invited Doc", kind: "markdown", ownerId: inviter!.id })
      .returning();
    const [invite] = await h.db
      .insert(docMembers)
      .values({ docId: doc!.id, userId: null, email: bob, role: "editor", invitedBy: inviter!.id, status: "pending" })
      .returning();

    // Bob signs up + verifies (the afterEmailVerification hook must activate his invite).
    const before = transport.sent.length;
    await signUp(bob);
    const verifyMail = transport.sent.slice(before).find((m) => m.to === bob);
    const token = new URL(urlFromBody(verifyMail!.text)).searchParams.get("token")!;
    await verifyToken(token);

    // The invite is now ACTIVE, bound to Bob's user id, role editor on the doc.
    const [bobUser] = await h.db.select().from(userTable).where(eq(userTable.email, bob));
    const [row] = await h.db.select().from(docMembers).where(eq(docMembers.id, invite!.id));
    expect(row!.status).toBe("active");
    expect(row!.role).toBe("editor");
    expect(row!.userId).toBe(bobUser!.id);
  });

  test("AS-011: a pending invite is acceptable via the accept-link endpoint (right actor), refused for the wrong actor", async () => {
    const carol = `carol-${process.pid}@itest.local`;
    const mallory = `mallory-${process.pid}@itest.local`;

    // Both users sign up + verify + sign in FIRST, so the verify-time auto-activation hook
    // (Seam 2) finds no invite — this isolates the accept-LINK path (Seam 3): the invitee
    // already has a verified account and joins via the shareable link, not the mail.
    const carolCookie = await signUpVerifySignIn(carol);
    const malloryCookie = await signUpVerifySignIn(mallory);

    const [inviter] = await h.db
      .insert(userTable)
      .values({ id: `inviter2-${process.pid}`, name: "Inviter2", email: `inviter2-${process.pid}@itest.local`, emailVerified: true })
      .returning();
    const [doc] = await h.db
      .insert(docs)
      .values({ slug: `as011-${process.pid}`, title: "Link Doc", kind: "markdown", ownerId: inviter!.id })
      .returning();
    // Pending invite for Carol, seeded AFTER she already exists+verified (e.g. the verify
    // mail never arrived) → the accept-link is her independent path in.
    const [invite] = await h.db
      .insert(docMembers)
      .values({ docId: doc!.id, userId: null, email: carol, role: "commenter", invitedBy: inviter!.id, status: "pending" })
      .returning();

    // The real accept-link token for this invite (what the invite mail would carry).
    const token = mintInviteToken(invite!.id, SECRET);

    // Mallory (wrong actor) tries to accept Carol's invite using the real link → refused
    // (the accepting email is Mallory's, server-resolved, not Carol's — AS-009 family).
    const wrong = await app.handle(acceptReq({ cookie: malloryCookie, inviteId: invite!.id, token }));
    expect(wrong.status).toBe(200);
    const wrongJson = (await wrong.json()) as any;
    expect(wrongJson.success).toBe(true);
    expect(wrongJson.data.status).toBe("not_accepted");
    // Still pending — Mallory could not claim Carol's invite (AS-009 family).
    const [stillPending] = await h.db.select().from(docMembers).where(eq(docMembers.id, invite!.id));
    expect(stillPending!.status).toBe("pending");

    // Carol (right actor) accepts via the link → role granted.
    const ok = await app.handle(acceptReq({ cookie: carolCookie, inviteId: invite!.id, token }));
    expect(ok.status).toBe(200);
    const okJson = (await ok.json()) as any;
    expect(okJson.data.status).toBe("active");
    expect(okJson.data.role).toBe("commenter");

    const [carolUser] = await h.db.select().from(userTable).where(eq(userTable.email, carol));
    const [granted] = await h.db.select().from(docMembers).where(eq(docMembers.id, invite!.id));
    expect(granted!.status).toBe("active");
    expect(granted!.userId).toBe(carolUser!.id);
  });

  /** Build the accept-invite request. */
  function acceptReq(opts: { cookie: string; inviteId: string; token: string }): Request {
    return new Request(`${BASE_URL}/api/invite/accept`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: opts.cookie },
      body: JSON.stringify({ inviteId: opts.inviteId, token: opts.token }),
    });
  }

  /** Sign up, verify via the captured token, sign in → return the replayable session cookie. */
  async function signUpVerifySignIn(email: string): Promise<string> {
    const before = transport.sent.length;
    await signUp(email);
    const verifyMail = transport.sent.slice(before).find((m) => m.to === email);
    const token = new URL(urlFromBody(verifyMail!.text)).searchParams.get("token")!;
    await verifyToken(token);
    const signIn = await app.handle(
      authPost("/api/auth/sign-in/email", { email, password: "correct horse battery staple" }),
    );
    expect(signIn.status).toBeLessThan(400);
    return setCookieToCookie(signIn.headers.get("set-cookie")!);
  }
});
