// Integration tier (guarded by RUN_INTEGRATION): the better-auth instance against a
// REAL Postgres. Drives the live server API (signUpEmail → getSession → signOut) and
// asserts the actual rows in user/account/session — proving DB-backed sessions are
// created and revocable (auth C-001 revocable, AS-001 live). The unit suite could only
// assert the config object + that the API methods exist; this exercises the round-trip.
//
// VERIFICATION GATE — what's verified vs deferred:
// Production auth (src/auth/auth.ts) sets requireEmailVerification: true, which blocks
// sign-IN until the user clicks an emailed link. A pure API+DB test (no mailbox, no
// HTTP browser) cannot complete that gate, and live SMTP/Resend send is out of scope
// (no creds). So this test builds a TEST-TUNED instance with verification NOT required
// — same drizzle adapter, same DB, same session strategy — to exercise the persistence
// + revoke path end-to-end. What's still [→E2E] (needs HTTP + a real mailbox):
//   - the email-verification link round-trip itself,
//   - the production-config sign-in being BLOCKED pre-verification,
//   - the session COOKIE (httpOnly) issuance over HTTP.
// What IS proven here: signUpEmail writes user + account(+session) rows; getSession reads
// the live session; revokeSession/signOut deletes the session row (the C-001 contract).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { count, eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { session as sessionTable, user as userTable } from "../../src/db/schema";
import { withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;

/** Build a test-tuned better-auth: production wiring minus the verification gate. */
function makeTestAuth(db: MigratedDb["db"]) {
  return betterAuth({
    secret: "x".repeat(32),
    baseURL: "http://localhost:3000",
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false, // diverges from prod ONLY here — documented above
      minPasswordLength: 8,
    },
  });
}

describe.skipIf(!RUN)("auth session (real Postgres)", () => {
  let h: MigratedDb;
  let auth: ReturnType<typeof makeTestAuth>;

  beforeAll(async () => {
    h = await withMigratedDb();
    auth = makeTestAuth(h.db);
  });

  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  });

  test("signUpEmail creates a user row + an account row", async () => {
    const email = `signup-${process.pid}@itest.local`;
    const res = await auth.api.signUpEmail({
      body: { email, password: "correct horse battery", name: "Test User" },
      asResponse: false,
    });
    expect(res.user?.email).toBe(email);

    const users = await h.db.select().from(userTable).where(eq(userTable.email, email));
    expect(users).toHaveLength(1);

    // Email+password stores a credential account row keyed to the user.
    const accounts = await h.db.query.account.findMany({
      where: (a, { eq }) => eq(a.userId, users[0]!.id),
    });
    expect(accounts.length).toBeGreaterThanOrEqual(1);
  });

  test("getSession returns a live session; signOut deletes the session row (C-001)", async () => {
    const email = `session-${process.pid}@itest.local`;
    // Sign-up issues a DB session and sets it in a Set-Cookie (the production session
    // mechanism — DB-backed cookie, not JWT, not a bearer token). Capture that cookie
    // and replay it, exactly as a browser would, to drive getSession + signOut.
    const signupRes = await auth.api.signUpEmail({
      body: { email, password: "correct horse battery", name: "Sess User" },
      asResponse: true,
    });
    const setCookie = signupRes.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    // Reduce Set-Cookie to a Cookie header (name=value pairs, drop attributes).
    const cookie = setCookie!
      .split(/,(?=[^;]+=[^;]+)/) // split multiple cookies, not the commas inside Expires
      .map((c) => c.split(";")[0]!.trim())
      .join("; ");

    // A session row exists in the DB for this user (DB-backed, not JWT).
    const userRow = (
      await h.db.select().from(userTable).where(eq(userTable.email, email))
    )[0]!;
    const before = await h.db
      .select({ n: count() })
      .from(sessionTable)
      .where(eq(sessionTable.userId, userRow.id));
    expect(before[0]!.n).toBe(1);

    // getSession over the session cookie resolves the live session + user.
    const got = await auth.api.getSession({
      headers: new Headers({ cookie }),
    });
    expect(got?.user.email).toBe(email);
    expect(got?.session.userId).toBe(userRow.id);

    // signOut revokes it — the session row is DELETED (revocable, C-001).
    await auth.api.signOut({
      headers: new Headers({ cookie }),
    });
    const after = await h.db
      .select({ n: count() })
      .from(sessionTable)
      .where(eq(sessionTable.userId, userRow.id));
    expect(after[0]!.n).toBe(0);

    // And the now-deleted session no longer resolves.
    const gone = await auth.api.getSession({
      headers: new Headers({ cookie }),
    });
    expect(gone).toBeNull();
  });
});
