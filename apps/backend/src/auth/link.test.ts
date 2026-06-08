import { test, expect } from "bun:test";
import {
  decideAccountLink,
  incomingFromOAuth,
  normalizeEmail,
  type ExistingAccount,
  type IncomingSignIn,
} from "./link";
import type { GitHubProfile, GoogleProfile } from "./oauth";

// Shared fixtures (setup only — each test asserts its own outcome).
const verifiedAccount: ExistingAccount = {
  userId: "user_1",
  email: "victim@x.com",
  emailVerified: true,
};
const unverifiedAccount: ExistingAccount = {
  userId: "user_1",
  email: "victim@x.com",
  emailVerified: false,
};
const verifiedIncoming: IncomingSignIn = {
  method: "google",
  email: "victim@x.com",
  emailVerified: true,
};

// ---------------------------------------------------------------------------
// AS-005 — Auto-link when email is verified (no duplicate account created).
// Given a verified account (via GitHub), When Google signs in with the SAME verified
// email, Then merge into the same account.
// ---------------------------------------------------------------------------
test("AS-005: both sides verified + same email → auto_link into the existing account (no duplicate)", () => {
  const decision = decideAccountLink({
    existingAccount: verifiedAccount,
    incoming: verifiedIncoming,
  });
  expect(decision.action).toBe("auto_link");
  expect(decision.userId).toBe("user_1"); // merges into the existing account, not a new one

  // Edge: exact-match is case/whitespace-insensitive normalize, NOT fuzzy — a same-email
  // sign-in whose casing differs still auto-links (special-chars/normalize boundary).
  expect(
    decideAccountLink({
      existingAccount: verifiedAccount,
      incoming: { ...verifiedIncoming, email: "  VICTIM@X.com " },
    }).action,
  ).toBe("auto_link");

  // Falsifiability guard: a DIFFERENT email (no existing account match) must NOT auto-link
  // even when both are verified → create_new, never merge into someone else's account.
  expect(
    decideAccountLink({
      existingAccount: verifiedAccount,
      incoming: { ...verifiedIncoming, email: "other@x.com" },
    }).action,
  ).toBe("create_new");
});

// ---------------------------------------------------------------------------
// AS-006 — Do NOT auto-link when email is unverified. Existing account is unverified →
// keep accounts separate until verified (account-takeover protection).
// ---------------------------------------------------------------------------
test("AS-006: existing account unverified → do NOT auto_link, require_confirmation instead (keep separate until verified)", () => {
  const decision = decideAccountLink({
    existingAccount: unverifiedAccount,
    incoming: verifiedIncoming, // incoming verified, but EXISTING is not → still no auto-link
  });
  expect(decision.action).toBe("require_confirmation");
  expect(decision.action).not.toBe("auto_link");
  expect(decision.userId).toBe("user_1"); // routes to confirm against the existing account

  // Boundary/falsifiability: flipping the EXISTING flag to verified (both now verified)
  // moves the outcome to auto_link — proving the existing-verified flag is load-bearing.
  expect(
    decideAccountLink({
      existingAccount: { ...unverifiedAccount, emailVerified: true },
      incoming: verifiedIncoming,
    }).action,
  ).toBe("auto_link");
});

// ---------------------------------------------------------------------------
// AS-010 [harden H3] — OAuth returning email_verified != true does NOT auto-link.
// Verified account exists for victim@x.com; an OAuth sign-in returns the same email but
// the provider does NOT assert email_verified===true → route to link-confirm.
// ---------------------------------------------------------------------------
test("AS-010: OAuth incoming whose provider did NOT assert email_verified===true → no auto_link, require_confirmation (prove ownership)", () => {
  // Google profile WITHOUT a true email_verified claim → incoming.emailVerified=false
  // (via oauthEmailVerified), so even against a verified existing account: no merge.
  const incomingUnverifiedOAuth = incomingFromOAuth("google", "victim@x.com", {
    email: "victim@x.com",
    email_verified: false,
  } as GoogleProfile);
  expect(incomingUnverifiedOAuth.emailVerified).toBe(false);

  const decision = decideAccountLink({
    existingAccount: verifiedAccount,
    incoming: incomingUnverifiedOAuth,
  });
  expect(decision.action).toBe("require_confirmation");
  expect(decision.action).not.toBe("auto_link");
  expect(decision.userId).toBe("user_1"); // link-confirm targets the existing account

  // Error/edge paths: missing claim, null profile, and the string "true" all yield an
  // UNVERIFIED incoming → require_confirmation, never auto_link (account-takeover guard).
  for (const profile of [
    { email: "victim@x.com" } as GoogleProfile, // missing claim
    null as GoogleProfile, // null profile
    { email: "victim@x.com", email_verified: "true" } as unknown as GoogleProfile, // string, not bool
  ]) {
    const incoming = incomingFromOAuth("google", "victim@x.com", profile);
    expect(incoming.emailVerified).toBe(false);
    expect(
      decideAccountLink({ existingAccount: verifiedAccount, incoming }).action,
    ).toBe("require_confirmation");
  }

  // No existing account at all (null) → create_new, regardless of incoming verified state.
  expect(
    decideAccountLink({
      existingAccount: null,
      incoming: incomingFromOAuth("github", "fresh@x.com", {
        emails: [{ email: "fresh@x.com", primary: true, verified: true }],
      } as GitHubProfile),
    }).action,
  ).toBe("create_new");
});

// ---------------------------------------------------------------------------
// C-002 [harden H3] — an OAuth email is verified ONLY when the provider explicitly asserts
// email_verified===true. Reuse oauthEmailVerified via incomingFromOAuth so the string
// "true" does NOT count, and a real verified profile DOES → drives the auto_link decision.
// ---------------------------------------------------------------------------
test("C-002: incomingFromOAuth derives verified STRICTLY (reuses oauthEmailVerified) — only provider-asserted true counts toward auto_link", () => {
  // GitHub primary verified → incoming verified → auto_link against a verified account.
  const ghVerified = incomingFromOAuth("github", "victim@x.com", {
    emails: [{ email: "victim@x.com", primary: true, verified: true }],
  } as GitHubProfile);
  expect(ghVerified.emailVerified).toBe(true);
  expect(
    decideAccountLink({ existingAccount: verifiedAccount, incoming: ghVerified }).action,
  ).toBe("auto_link");

  // The string "true" must NOT count (no truthy coercion) → incoming stays unverified →
  // require_confirmation, NOT auto_link. This is the H3 leak the strict check closes.
  const ghStringTrue = incomingFromOAuth("github", "victim@x.com", {
    emails: [{ email: "victim@x.com", primary: true, verified: "true" as unknown as boolean }],
  } as GitHubProfile);
  expect(ghStringTrue.emailVerified).toBe(false);
  expect(
    decideAccountLink({ existingAccount: verifiedAccount, incoming: ghStringTrue }).action,
  ).toBe("require_confirmation");

  // A non-primary verified GitHub email also does NOT count (oauthEmailVerified rule).
  const ghNonPrimary = incomingFromOAuth("github", "victim@x.com", {
    emails: [{ email: "victim@x.com", primary: false, verified: true }],
  } as GitHubProfile);
  expect(ghNonPrimary.emailVerified).toBe(false);
});

// ---------------------------------------------------------------------------
// C-003 — Auto-link ONLY when the email is verified (account-takeover protection).
// The falsifiability matrix: both verified → auto_link; ANY side unverified → not auto_link.
// email+password incoming must be verified before it can auto-link too.
// ---------------------------------------------------------------------------
test("C-003: auto_link requires BOTH sides verified — flipping either flag to false drops out of auto_link (account-takeover protection)", () => {
  const base = { existingAccount: verifiedAccount } as const;

  // both verified → auto_link
  expect(
    decideAccountLink({ ...base, incoming: { method: "email", email: "victim@x.com", emailVerified: true } }).action,
  ).toBe("auto_link");

  // incoming email+pw UNVERIFIED → not auto_link (email+pw must be verified before auto-link)
  expect(
    decideAccountLink({ ...base, incoming: { method: "email", email: "victim@x.com", emailVerified: false } }).action,
  ).toBe("require_confirmation");

  // existing UNVERIFIED, incoming verified → not auto_link
  expect(
    decideAccountLink({
      existingAccount: { ...verifiedAccount, emailVerified: false },
      incoming: { method: "email", email: "victim@x.com", emailVerified: true },
    }).action,
  ).toBe("require_confirmation");

  // BOTH unverified → not auto_link
  expect(
    decideAccountLink({
      existingAccount: { ...verifiedAccount, emailVerified: false },
      incoming: { method: "email", email: "victim@x.com", emailVerified: false },
    }).action,
  ).toBe("require_confirmation");

  // normalizeEmail is exact lowercase+trim — never fuzzy (no substring/alias matching).
  expect(normalizeEmail("  VICTIM@X.com ")).toBe("victim@x.com");
  expect(normalizeEmail("victim+tag@x.com")).toBe("victim+tag@x.com"); // +tag NOT stripped — exact
});
