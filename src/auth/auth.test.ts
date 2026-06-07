import { test, expect } from "bun:test";
import {
  createAuth,
  SIGNIN_RATE_LIMIT_MAX,
  SIGNIN_RATE_LIMIT_WINDOW_SECONDS,
} from "./auth";
import type { DB } from "../db/client";

// The live sign up / sign in / cookie flow needs a real Postgres + HTTP → that is
// integration-verified-later ([→E2E]). The UNIT contract asserted here is the
// better-auth CONFIG the app actually runs with, plus the API surface the flow
// depends on (sign-in, logout/revoke). Asserting the real config object is a
// meaningful, falsifiable contract test: flip any of these in auth.ts and a test
// below turns red.
//
// Building the instance does not touch the DB (the adapter is lazy), so a minimal
// stub stands in for the Drizzle client.
const stubDb = {} as unknown as DB;
const auth = createAuth(stubDb, { secret: "x".repeat(32), baseURL: "http://localhost:3000" });

test("AS-001: email+password provider is enabled with email verification required", () => {
  // Given the email+password provider is enabled + verification required (AS-001 Given).
  const ep = auth.options.emailAndPassword;
  expect(ep?.enabled).toBe(true);
  expect(ep?.requireEmailVerification).toBe(true);
});

test("AS-001.T1: instance exposes email sign-up + sign-in (active account + session on sign-in)", () => {
  // The configured flow yields an active account + a DB session on sign-in. The live
  // round-trip is [→E2E]; at the unit layer we assert the API the flow calls exists.
  expect(typeof auth.api.signUpEmail).toBe("function");
  expect(typeof auth.api.signInEmail).toBe("function");
  expect(typeof auth.api.getSession).toBe("function");
});

test("AS-001.T2: instance exposes logout/revoke so a session can be deleted", () => {
  // Logout deletes/revokes the session (AS-001.T2). signOut + revokeSession are the
  // server-side revoke paths; their presence is the unit contract, live delete is [→E2E].
  expect(typeof auth.api.signOut).toBe("function");
  expect(typeof auth.api.revokeSession).toBe("function");
});

test("AS-002.T1: wrong password is rejected — sign-in path requires email verification + a password credential", () => {
  // Wrong password yields no session (AS-002.T1). better-auth owns the credential
  // check; the contract that makes a wrong password rejectable is: email+pw enabled
  // (so a password credential is stored) AND verification required. The live "wrong
  // pw → 401, no session" assertion is [→E2E].
  expect(auth.options.emailAndPassword?.enabled).toBe(true);
  expect(auth.options.emailAndPassword?.requireEmailVerification).toBe(true);
  expect(typeof auth.api.signInEmail).toBe("function");
});

test("AS-002.T2: rate limiting is enabled with the chosen threshold/window (brute-force limit)", () => {
  // Past the failure threshold → retries temporarily limited (AS-002.T2 / C-007).
  // GAP-002 default: 5 attempts / 15 min.
  expect(auth.options.rateLimit?.enabled).toBe(true);
  expect(auth.options.rateLimit?.max).toBe(SIGNIN_RATE_LIMIT_MAX);
  expect(auth.options.rateLimit?.window).toBe(SIGNIN_RATE_LIMIT_WINDOW_SECONDS);
  expect(SIGNIN_RATE_LIMIT_MAX).toBe(5);
  expect(SIGNIN_RATE_LIMIT_WINDOW_SECONDS).toBe(900);
});

test("C-001: sessions are DB-backed (not JWT) and revocable", () => {
  // No JWT plugin is configured and DB session storage is not disabled, so better-auth's
  // default DB-backed session strategy stands → sessions are revocable. revokeSession +
  // revokeSessions (revoke all) are the DB-session revoke paths a JWT-only setup lacks.
  // Widened view: the config was built without `plugins`/`session`, so the literal
  // type omits them — read through a record to assert that absence at runtime.
  const opts = auth.options as Record<string, unknown>;
  const plugins = (opts.plugins as Array<{ id?: string }> | undefined) ?? [];
  const ids = plugins.map((p) => p?.id).filter(Boolean);
  expect(ids).not.toContain("jwt"); // not JWT-backed
  // DB session storage must not be turned off (would push sessions out of the DB).
  const session = opts.session as { storeSessionInDatabase?: boolean } | undefined;
  expect(session?.storeSessionInDatabase).not.toBe(false);
  expect(typeof auth.api.revokeSession).toBe("function");
  expect(typeof auth.api.revokeSessions).toBe("function");
});

test("C-006: minimum password length is enforced at the config (== 8)", () => {
  expect(auth.options.emailAndPassword?.minPasswordLength).toBe(8);
});

test("C-007: sign-in is rate-limited against brute-force (rate limiting enabled)", () => {
  expect(auth.options.rateLimit?.enabled).toBe(true);
  expect(auth.options.rateLimit?.max).toBeGreaterThan(0);
});

test("AS-001: a session-signing secret is wired (APP_SECRET → cookie signing)", () => {
  // The httpOnly session cookie is signed with APP_SECRET (C-001 / spec). The secret
  // passed to createAuth must be the one the instance uses.
  expect(auth.options.secret).toBe("x".repeat(32));
});
