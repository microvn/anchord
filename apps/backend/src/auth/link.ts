// Account auto-linking DECISION (auth S-003).
//
// This is the single highest account-takeover risk in auth, so the rule is STRICT
// default-deny. better-auth owns the live merge (its `account.accountLinking` config
// actually wires/merges the accounts) and is integration-verified-later ([→E2E]); the
// SECURITY CONTRACT that is unit-tested here is the pure decision function below.
//
// The story splits cleanly from S-002:
//   - S-002 (oauth.ts) CAPTURES the verified flag from a provider profile
//     (`oauthEmailVerified` — true ONLY when the provider explicitly asserts
//     email_verified===true; the string "true"/false/missing/null all = NOT verified).
//   - S-003 (here) CONSUMES that flag to DECIDE whether to auto-link.
//
// Rules (STRICT — default deny; C-003, AS-005/006/010):
//   - auto_link            ONLY when an existing account with the SAME exact normalized
//                          email exists AND BOTH sides' emails are verified.
//   - require_confirmation existing account exists but EITHER side is unverified → do NOT
//                          auto-link; route to a "link account" confirm that proves
//                          ownership of the existing account.
//   - create_new          no existing account for that email.
//
// FALSIFIABILITY: flipping any verified flag to false must move the outcome away from
// auto_link. Email match is EXACT after normalize (lowercase + trim) — never fuzzy.

import { oauthEmailVerified, type OAuthProvider } from "./oauth";

/** Where a sign-in came from. `email` = email+password; the rest are OAuth providers. */
export type IncomingMethod = "email" | OAuthProvider;

/**
 * An account already on file, matched by EXACT normalized email. `null` when no account
 * exists for the incoming email (→ create_new).
 */
export type ExistingAccount = {
  userId: string;
  email: string;
  /** Whether the existing account's email is verified (email+pw verification, or a prior OAuth verify). */
  emailVerified: boolean;
} | null;

/**
 * The sign-in attempting to link. `emailVerified` is the already-resolved verified flag —
 * for OAuth it MUST come from `oauthEmailVerified` (see `incomingFromOAuth`); for email+pw
 * it is the account's verification state.
 */
export type IncomingSignIn = {
  method: IncomingMethod;
  email: string;
  emailVerified: boolean;
};

export type LinkAction = "auto_link" | "create_new" | "require_confirmation";

export type LinkDecision = {
  action: LinkAction;
  /** Present on auto_link / require_confirmation: the existing account this concerns. */
  userId?: string;
};

/** Exact-match normalize: lowercase + trim. Never fuzzy. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Build the `IncomingSignIn` for an OAuth sign-in, deriving `emailVerified` STRICTLY from
 * the provider profile via `oauthEmailVerified` (C-002). This is the only sanctioned way
 * to set the OAuth verified flag — it guarantees the string "true"/missing/false/null do
 * NOT count, so they cannot leak into an auto_link decision.
 */
export function incomingFromOAuth(
  provider: OAuthProvider,
  email: string,
  profile: unknown,
): IncomingSignIn {
  return {
    method: provider,
    email,
    emailVerified: oauthEmailVerified(provider, profile as never),
  };
}

/**
 * AS-005 / AS-006 / AS-010 / C-003 — decide whether to auto-link a new sign-in into an
 * existing account.
 *
 * STRICT default-deny:
 *  - No existing account for that exact email           → create_new.
 *  - Existing account AND both sides verified           → auto_link (AS-005, C-003).
 *  - Existing account but EITHER side unverified        → require_confirmation
 *      (AS-006 existing unverified; AS-010 incoming OAuth not asserted verified).
 *
 * Email match is exact after normalize; a mismatch is treated as "no existing account".
 */
export function decideAccountLink(input: {
  existingAccount: ExistingAccount;
  incoming: IncomingSignIn;
}): LinkDecision {
  const { existingAccount, incoming } = input;

  // No account on file for this email → brand new account, nothing to link.
  if (!existingAccount) {
    return { action: "create_new" };
  }

  // Defense in depth: the caller matches by email, but re-assert EXACT normalized equality
  // here so a fuzzy/unnormalized match upstream can never reach auto_link. A mismatch means
  // this is not actually the same email → treat as no existing account.
  if (normalizeEmail(existingAccount.email) !== normalizeEmail(incoming.email)) {
    return { action: "create_new" };
  }

  // Auto-link ONLY when BOTH the existing account AND the incoming sign-in are verified.
  // Flipping either flag to false drops out of this branch (falsifiability / C-003).
  if (existingAccount.emailVerified && incoming.emailVerified) {
    return { action: "auto_link", userId: existingAccount.userId };
  }

  // Same email, but at least one side is unverified → never silently merge. Route to a
  // confirmation that proves ownership of the existing account (AS-006, AS-010).
  return { action: "require_confirmation", userId: existingAccount.userId };
}
