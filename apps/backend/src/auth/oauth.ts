// OAuth profile/callback helpers (auth S-002).
//
// These are the PURE seams of the OAuth flow. The live OAuth exchange (redirect →
// provider → callback → account/session) is owned by better-auth and is
// integration-verified-later ([→E2E]). What is unit-testable — and security-critical —
// is two contracts:
//
//  1. C-002 [harden H3] — oauthEmailVerified(): an OAuth email is treated as verified
//     ONLY when the provider EXPLICITLY asserts verification. Missing / false / the
//     string "true" / null / undefined all mean NOT verified. This story OWNS the
//     CAPTURE of email-verified from the profile; the auto-link DECISION that consumes
//     it is S-003. Getting this wrong is an account-takeover surface, so it is gated hard.
//
//  2. AS-004 — oauthCallbackOutcome(): a denied/failed callback must yield no session,
//     and the app returns the user to sign-in with an error. The live round-trip is
//     [→E2E]; the unit contract is the mapping result-shape → {session: false, error}.

export type OAuthProvider = "github" | "google";

/**
 * GitHub's email API shape (the `GET /user/emails` rows). GitHub does NOT put
 * email_verified in the OAuth userinfo — verification lives on the email row's
 * `verified` flag, and only the PRIMARY verified email counts.
 */
export type GitHubEmail = { email?: string; primary?: boolean; verified?: boolean };
export type GitHubProfile = { emails?: GitHubEmail[] } | null | undefined;

/**
 * Google's id_token / userinfo claims. `email_verified` SHOULD be a real boolean;
 * some serializations leak it as the string "true" — that must NOT count as verified.
 */
export type GoogleProfile =
  | { email?: string; email_verified?: unknown }
  | null
  | undefined;

export type OAuthProfile = GitHubProfile | GoogleProfile;

/**
 * C-002 — return true ONLY when the provider EXPLICITLY asserts the email is verified.
 *
 * - GitHub: there is a PRIMARY email row with `verified === true`. No emails, no primary,
 *   or primary not verified → false. We do not trust a non-primary verified email as the
 *   account email.
 * - Google: the profile claim `email_verified` is the boolean `true` (strict). The string
 *   "true", false, null, undefined, missing → false.
 *
 * Anything else (unknown provider, null/garbage profile) → false. Default-deny.
 */
export function oauthEmailVerified(provider: OAuthProvider, profile: OAuthProfile): boolean {
  if (provider === "github") {
    const emails = (profile as GitHubProfile)?.emails;
    if (!Array.isArray(emails)) return false;
    const primary = emails.find((e) => e?.primary === true);
    // Strict boolean true on the PRIMARY email row.
    return primary?.verified === true;
  }
  if (provider === "google") {
    // Strict: the boolean true, never the string "true", never truthy coercion.
    return (profile as { email_verified?: unknown })?.email_verified === true;
  }
  return false;
}

/**
 * Shape better-auth (or our route) hands back after a social callback round-trip.
 * `error` set (denied grant, state mismatch, token exchange failure) → failure.
 */
export type OAuthCallbackResult = {
  error?: string | null;
  /** Present only on a successful exchange. */
  account?: unknown;
};

export type OAuthCallbackOutcome =
  | { session: true }
  | { session: false; error: string };

/**
 * AS-004 — map a callback result to whether a session may be created. A failed/denied
 * callback creates NO session and carries an error to show on the sign-in screen. There
 * is deliberately NO "create session on error" branch — that is the whole point of the
 * test: error in → session:false out, always.
 */
export function oauthCallbackOutcome(result: OAuthCallbackResult): OAuthCallbackOutcome {
  if (result.error) {
    return { session: false, error: result.error };
  }
  if (!result.account) {
    // No error but no account either (e.g. callback fell through) → still no session.
    return { session: false, error: "oauth_no_account" };
  }
  return { session: true };
}
