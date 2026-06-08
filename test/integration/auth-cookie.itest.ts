// Integration tier (guarded by RUN_INTEGRATION): auth-routes S-004 — the LIVE
// better-auth session cookie resolves the actor for /api routes.
//
// This is the verification story for the production resolver. Prior route tests
// (docs-routes.itest.ts) injected a FAKE SessionResolver to isolate the DB write;
// the gate logic (src/http/auth-gate.ts) was unit-tested with a fake. Neither
// proved the REAL path: a cookie minted by better-auth over HTTP, replayed to a
// protected /api route, resolved server-side by betterAuthSessionResolver(auth)
// into ctx.actor. THIS test closes that gap end-to-end on real Postgres:
//   sign-up + sign-in over app.handle → real Set-Cookie session token →
//   call the gated POST /api/docs WITH that cookie → handler runs as that user
//   (the persisted owner_id == the signed-up user's id) ; drop/garble the cookie
//   → 401 UNAUTHENTICATED, handler never reached.
//
// PRODUCTION FIDELITY — what matches prod vs what diverges (and why):
//   - SAME createApp(deps) composition as src/index.ts (better-auth mounted at
//     /api/auth/*, the gated /api/docs route, the REAL betterAuthSessionResolver
//     wired into deps.docs.resolveSession). No fake resolver here.
//   - The ONE divergence is requireEmailVerification: production sets it TRUE,
//     which blocks sign-IN until an emailed link is clicked. A pure API+HTTP test
//     has no mailbox, so — exactly as auth-session.itest.ts documents — this builds
//     the auth instance with verification NOT required. Same drizzle adapter, same
//     DB, same DB-backed session/cookie strategy, same APP_SECRET-signed cookie.
//     The cookie issuance + server-side resolution under test are identical to prod.
//   - EXPIRED cookie: a genuinely time-expired session token can't be forced in a
//     fast in-process test; the GARBAGE/tampered token covers the "invalid" branch
//     of AS-010 (better-auth fails to verify it → getSession null → 401), which is
//     the same refusal path an expired token takes.
//   - C-006 (identity from the cookie, NOT the body): the AS-009 call sends a
//     FORGED userId in the body; the persisted owner is still the COOKIE's user —
//     the body field is ignored (the publish route reads actor.userId only). This,
//     plus the no-cookie 401, proves the actor is server-resolved.
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/auth-cookie.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { docs, user as userTable } from "../../src/db/schema";
import { createApp } from "../../src/app";
import { betterAuthSessionResolver } from "../../src/http/auth-gate";
import { withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;

const SECRET = "x".repeat(32);
const BASE_URL = "http://localhost";

/**
 * Build the auth instance the way src/index.ts does (createAuth), but with the
 * email-verification gate off so sign-in issues a cookie in-process (see header).
 * Same secret/baseURL/adapter/session strategy as production — the cookie this
 * mints is the cookie betterAuthSessionResolver verifies.
 */
function makeAuth(db: MigratedDb["db"]) {
  return betterAuth({
    secret: SECRET,
    baseURL: BASE_URL,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false, // diverges from prod ONLY here — see header
      minPasswordLength: 8,
    },
  });
}

/** POST a JSON body to /api/auth/*, returning the raw Response (to read Set-Cookie). */
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
    .split(/,(?=[^;]+=[^;]+)/) // split multiple cookies, not commas inside Expires
    .map((c) => c.split(";")[0]!.trim())
    .join("; ");
}

/** Build the protected-route request (POST /api/docs); optionally with a cookie + body. */
function publishReq(opts: { cookie?: string; body: unknown }): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cookie) headers.cookie = opts.cookie;
  return new Request(`${BASE_URL}/api/docs`, {
    method: "POST",
    headers,
    body: JSON.stringify(opts.body),
  });
}

describe.skipIf(!RUN)("auth-routes S-004: live session cookie resolves the /api actor (real Postgres)", () => {
  let h: MigratedDb;
  let auth: ReturnType<typeof makeAuth>;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    h = await withMigratedDb();
    auth = makeAuth(h.db);
    // SAME composition as src/index.ts: better-auth mounted + the gated /api/docs
    // route wired to the REAL betterAuthSessionResolver(auth) — no fake resolver.
    app = createApp({
      dbCheck: async () => {},
      authHandler: auth.handler,
      docs: { db: h.db, resolveSession: betterAuthSessionResolver(auth) },
    });
  });

  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  });

  /** Sign up then sign in over HTTP; return the signed-in user's id + replayable cookie. */
  async function signUpAndIn(email: string): Promise<{ userId: string; cookie: string }> {
    const password = "correct horse battery staple";
    // Sign up over the mounted /api/auth/* (real HTTP path, not a direct api call).
    const signUpRes = await app.handle(
      authPost("/api/auth/sign-up/email", { email, password, name: "Cookie User" }),
    );
    expect(signUpRes.status).toBeLessThan(400);
    // Sign in over HTTP → the Response carries the Set-Cookie session token.
    const signInRes = await app.handle(
      authPost("/api/auth/sign-in/email", { email, password }),
    );
    expect(signInRes.status).toBeLessThan(400);
    const setCookie = signInRes.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    const cookie = setCookieToCookie(setCookie!);
    expect(cookie).toContain("session_token"); // the better-auth session cookie

    const rows = await h.db.select().from(userTable).where(eq(userTable.email, email));
    expect(rows).toHaveLength(1);
    return { userId: rows[0]!.id, cookie };
  }

  test("AS-009: a valid session cookie resolves the calling user; the handler runs as them (C-006)", async () => {
    const { userId, cookie } = await signUpAndIn(`as009-${process.pid}@itest.local`);

    // Call the protected route WITH the live cookie. The body carries a FORGED
    // userId — C-006 says it must be ignored; the actor comes from the cookie.
    const res = await app.handle(
      publishReq({
        cookie,
        body: { content: "# Owned by cookie user", title: "Cookie Doc", userId: "u_forged_attacker" },
      }),
    );

    // Not 401: the live cookie resolved a session, so the gate let the handler run.
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);

    // Identity is OBSERVABLE: the handler recorded owner_id from ctx.actor. It MUST
    // be the cookie's user (the signed-up id), NOT the forged body userId. This is
    // the C-006 proof: server-resolved identity, body cannot forge it.
    const docRows = await h.db.select().from(docs).where(eq(docs.id, json.data.docId));
    expect(docRows[0]?.ownerId).toBe(userId);
    expect(docRows[0]?.ownerId).not.toBe("u_forged_attacker");
  });

  test("AS-010: no session cookie → 401 UNAUTHENTICATED; the handler never runs", async () => {
    const before = await h.db.select().from(docs);
    const res = await app.handle(publishReq({ body: { content: "# nope", title: "No Cookie" } }));

    expect(res.status).toBe(401);
    const json = (await res.json()) as any;
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("UNAUTHENTICATED");

    // Handler not reached: no doc was created.
    const after = await h.db.select().from(docs);
    expect(after.length).toBe(before.length);
  });

  test("AS-010: a garbage/tampered session cookie → 401 UNAUTHENTICATED; the handler never runs", async () => {
    // A tampered token better-auth cannot verify → getSession returns null → 401.
    // (A genuinely EXPIRED token can't be forced in-test; this garbage token covers
    // the same 'invalid session' refusal branch — see header note.)
    const before = await h.db.select().from(docs);
    const res = await app.handle(
      publishReq({
        cookie: "better-auth.session_token=deadbeef.deadbeefsignature",
        body: { content: "# nope", title: "Garbage Cookie" },
      }),
    );

    expect(res.status).toBe(401);
    const json = (await res.json()) as any;
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("UNAUTHENTICATED");

    const after = await h.db.select().from(docs);
    expect(after.length).toBe(before.length); // handler not reached, nothing written
  });
});
