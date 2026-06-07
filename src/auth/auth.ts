// better-auth instance/factory (auth S-001).
//
// Why a factory: createAuth(db, opts) lets tests build the instance against an
// injected DB (the project's "injectable ports" pattern, cf. publish/service.ts)
// and lets src/index.ts wire the real Postgres DB at boot.
//
// Locked decisions (CLAUDE.md + spec auth.md):
//  - email+password ENABLED, requireEmailVerification, minPasswordLength=8 (C-006).
//  - DB-backed sessions, NOT JWT — revocable for logout/session-ban (C-001). We do
//    NOT add the JWT plugin and do NOT disable DB session storage, so better-auth's
//    default DB-session strategy stands; `auth.api.revokeSession` is the revoke path.
//  - sign-in rate limiting ENABLED against brute force (C-007).
//  - APP_SECRET signs the session cookie (httpOnly by better-auth default).
//
// The user/session/account/verification tables live in src/db/schema.ts; the
// drizzle adapter maps to them. The live sign-up/sign-in/cookie flow needs a real
// DB + HTTP and is integration-verified-later ([→E2E]); the UNIT contract here is
// the config object the app actually runs with.

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { DB } from "../db/client";
import * as schema from "../db/schema";
import { MIN_PASSWORD_LENGTH } from "./password";
import { activatePendingInvites, type PendingInviteRepo } from "./invite";

// auth S-005 (AS-008/C-005): after a user's email is verified, activate any pending
// invite issued to that exact email so they get the invited role. This is the thin
// glue that the post-verify hook calls; the activation algorithm is unit-tested in
// invite.ts against a fake repo. Wiring this into better-auth's verification
// callback (and supplying the concrete PendingInviteRepo from sharing-permissions)
// is integration-verified-later — better-auth fires the hook, this fn does the work.
export async function onEmailVerified(
  email: string,
  userId: string,
  repo: PendingInviteRepo,
) {
  // isVerified is true here by definition: this runs only after better-auth confirms
  // the verification. The activation fn still gates on it (C-005) as defense in depth.
  return activatePendingInvites(email, userId, true, repo);
}

// GAP-002 (deferred): sign-in rate-limit threshold/window were left to build time.
// Sane default: 5 attempts per 15 minutes. Named so it is one place to tune and so
// the C-007 test can assert against it rather than a magic number.
export const SIGNIN_RATE_LIMIT_MAX = 5;
export const SIGNIN_RATE_LIMIT_WINDOW_SECONDS = 15 * 60; // 900s

export type CreateAuthOptions = {
  /** Signs the session cookie + tokens — APP_SECRET from env (≥16 chars). */
  secret: string;
  /** Public base URL of the app; better-auth needs it for callbacks/cookies. */
  baseURL?: string;
};

/**
 * Build the better-auth instance bound to the given Drizzle DB.
 *
 * Returns the full better-auth instance: `.handler` (mount on Elysia at
 * /api/auth/*), `.api` (server-side calls incl. revokeSession for logout — C-001),
 * and `.options` (the config contract the unit tests assert).
 */
export function createAuth(db: DB, opts: CreateAuthOptions) {
  return betterAuth({
    secret: opts.secret,
    baseURL: opts.baseURL,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: {
      enabled: true,
      // C-008 makes SMTP mandatory at boot, so email verification always works.
      requireEmailVerification: true,
      // C-006: minimum 8 chars; better-auth hashes the password.
      minPasswordLength: MIN_PASSWORD_LENGTH,
    },
    // C-007: rate-limit sign-in against brute force. Default window/threshold per GAP-002.
    rateLimit: {
      enabled: true,
      window: SIGNIN_RATE_LIMIT_WINDOW_SECONDS,
      max: SIGNIN_RATE_LIMIT_MAX,
    },
    // No JWT plugin + DB storage left on => sessions are DB-backed and revocable (C-001).
  });
}

export type Auth = ReturnType<typeof createAuth>;
