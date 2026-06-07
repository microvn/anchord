import { test, expect } from "bun:test";
import {
  oauthEmailVerified,
  oauthCallbackOutcome,
  type GitHubProfile,
  type GoogleProfile,
} from "./oauth";
import { createAuth, mapOAuthProfile } from "./auth";
import type { DB } from "../db/client";

const stubDb = {} as unknown as DB;

// ---------------------------------------------------------------------------
// AS-003 — GitHub OAuth → account created/matched, email verified, session exists.
//
// better-auth owns the live OAuth exchange + DB session creation ([→E2E]). The unit
// contract: (1) the provider IS configured when its env creds are present, and (2) a
// provider-asserted-verified profile maps to emailVerified=true, so the matched/created
// account is treated as verified and the session that follows is on a verified account.
// ---------------------------------------------------------------------------
test("AS-003: GitHub provider is configured when creds present, and a provider-verified profile yields a verified account (→ session on a verified account)", () => {
  const auth = createAuth(stubDb, {
    secret: "x".repeat(32),
    baseURL: "http://localhost:3000",
    oauth: { github: { clientId: "gh-id", clientSecret: "gh-secret" } },
  });
  const social = auth.options.socialProviders as Record<string, unknown> | undefined;
  // Provider IS configured (so "Continue with GitHub" can complete OAuth → session).
  expect(social?.github).toBeDefined();
  expect(social?.google).toBeUndefined();
  // A GitHub primary-verified profile → the matched/created account is verified.
  const verifiedProfile: GitHubProfile = {
    emails: [{ email: "u@x.com", primary: true, verified: true }],
  };
  expect(mapOAuthProfile("github", verifiedProfile).emailVerified).toBe(true);
  // The live "account created/matched + DB session exists" round-trip is [→E2E].
});

test("AS-003.T1: Google provider is configured when creds present, and a Google-verified profile yields a verified account", () => {
  const auth = createAuth(stubDb, {
    secret: "x".repeat(32),
    oauth: { google: { clientId: "g-id", clientSecret: "g-secret" } },
  });
  const social = auth.options.socialProviders as Record<string, unknown> | undefined;
  expect(social?.google).toBeDefined();
  expect(social?.github).toBeUndefined();
  expect(mapOAuthProfile("google", { email: "u@x.com", email_verified: true }).emailVerified).toBe(true);
});

test("AS-003.T2: a provider with NO creds is not configured (missing provider simply absent)", () => {
  // Self-host: configure to enable. No oauth opts at all → no social providers.
  const auth = createAuth(stubDb, { secret: "x".repeat(32) });
  const social = (auth.options.socialProviders ?? {}) as Record<string, unknown>;
  expect(social.github).toBeUndefined();
  expect(social.google).toBeUndefined();
});

// ---------------------------------------------------------------------------
// AS-004 — Failed/denied OAuth callback creates no session; return to sign-in w/ error.
//
// better-auth returns an error and creates no session on a failed/denied callback. The
// unit contract: the result→outcome mapper has NO "create session on error" branch —
// an error in always maps to session:false + an error message. The live denied-callback
// round-trip (redirect → deny → app shows error, no cookie) is [→E2E].
// ---------------------------------------------------------------------------
test("AS-004: a denied/failed OAuth callback maps to no session + an error to show on sign-in [→E2E for the live round-trip]", () => {
  const denied = oauthCallbackOutcome({ error: "access_denied" });
  expect(denied.session).toBe(false);
  if (denied.session === false) expect(denied.error).toBe("access_denied");

  // A callback that fell through with neither error nor account also yields no session.
  const fellThrough = oauthCallbackOutcome({});
  expect(fellThrough.session).toBe(false);

  // Sanity: a successful exchange (account present, no error) is the ONLY session:true path.
  const ok = oauthCallbackOutcome({ account: { id: "acct_1" } });
  expect(ok.session).toBe(true);
});

// ---------------------------------------------------------------------------
// C-002 [harden H3] — an OAuth email is treated as verified ONLY when the provider
// EXPLICITLY asserts email_verified === true. Missing / false / string "true" / null /
// undefined → NOT verified. Hard-tested for both providers (default-deny).
// ---------------------------------------------------------------------------
test("C-002: OAuth email is verified ONLY when the provider explicitly asserts email_verified===true (true; not false/missing/\"true\"/null/undefined)", () => {
  // --- GitHub: only a PRIMARY email row with verified===true counts ---
  const ghVerified: GitHubProfile = { emails: [{ email: "u@x.com", primary: true, verified: true }] };
  expect(oauthEmailVerified("github", ghVerified)).toBe(true);

  // primary present but NOT verified → false
  expect(oauthEmailVerified("github", { emails: [{ email: "u@x.com", primary: true, verified: false }] })).toBe(false);
  // verified email exists but is NOT the primary → false (don't trust a non-primary)
  expect(oauthEmailVerified("github", { emails: [{ email: "u@x.com", primary: false, verified: true }] })).toBe(false);
  // verified as the string "true" on the primary → false (no truthy coercion)
  expect(oauthEmailVerified("github", { emails: [{ email: "u@x.com", primary: true, verified: "true" as unknown as boolean }] })).toBe(false);
  // empty emails / missing emails / null / undefined → false
  expect(oauthEmailVerified("github", { emails: [] })).toBe(false);
  expect(oauthEmailVerified("github", {})).toBe(false);
  expect(oauthEmailVerified("github", null)).toBe(false);
  expect(oauthEmailVerified("github", undefined)).toBe(false);

  // --- Google: only the boolean true counts ---
  const gVerified: GoogleProfile = { email: "u@x.com", email_verified: true };
  expect(oauthEmailVerified("google", gVerified)).toBe(true);

  expect(oauthEmailVerified("google", { email: "u@x.com", email_verified: false })).toBe(false);
  expect(oauthEmailVerified("google", { email: "u@x.com", email_verified: "true" })).toBe(false); // string, not boolean
  expect(oauthEmailVerified("google", { email: "u@x.com", email_verified: null })).toBe(false);
  expect(oauthEmailVerified("google", { email: "u@x.com" })).toBe(false); // missing claim
  expect(oauthEmailVerified("google", null)).toBe(false);
  expect(oauthEmailVerified("google", undefined)).toBe(false);

  // Unknown provider → default-deny.
  expect(oauthEmailVerified("gitlab" as never, gVerified)).toBe(false);
});
