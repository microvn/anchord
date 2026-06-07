// Operator provider toggle (auth S-004).
//
// One self-host knob: which sign-in methods are live. email+password is always on
// (no creds to configure); each OAuth provider is on ONLY when the operator supplied
// its creds. That gating already happened once in config/env.ts (`oauthFrom` builds
// Config.oauth with a provider key present ONLY when both id+secret were set). We reuse
// that OUTPUT here instead of re-reading env keys — single source of truth for "enabled",
// so there is no second place to keep in sync (DRY; cf. the dispatched-design DRY note).
//
// Three consumers of the same toggle:
//   - enabledProviders(config)  → ordered list the sign-in UI renders buttons from (AS-007.T1).
//   - isProviderEnabled(config, p) → per-button predicate (same source as the list).
//   - assertProviderEnabled(config, p) → server-side callback guard: a forced callback to a
//     disabled provider is REJECTED, so hiding the button is not the only defense (AS-007.T2).
//
// The sign-in PAGE markup is [→MANUAL]/FE — it consumes enabledProviders(); this module is
// the testable logic behind it. C-004 ties all three to the one config toggle.

import type { Config } from "../config/env";

/** Every sign-in method anchord can offer. `email` = email+password (always available). */
export type AuthMethod = "email" | "github" | "google";

/** Stable render/iteration order for the sign-in card. email+pw first, then OAuth. */
const PROVIDER_ORDER: readonly AuthMethod[] = ["email", "github", "google"];

/**
 * Thrown by the callback guard when a (forced) callback targets a disabled provider.
 * A disabled provider must not authenticate even via a hand-crafted callback URL (AS-007.T2).
 */
export class ProviderDisabledError extends Error {
  constructor(public readonly provider: string) {
    super(`auth provider is not enabled: ${provider}`);
    this.name = "ProviderDisabledError";
  }
}

/**
 * Is this provider enabled for THIS config?
 * - email+password: always on (no creds toggle).
 * - github/google: on ONLY when config.oauth has its creds (the S-002 gating output).
 * - anything else (unknown name): off — default-deny.
 */
export function isProviderEnabled(config: Config, provider: AuthMethod): boolean {
  if (provider === "email") return true;
  if (provider === "github") return config.oauth.github !== undefined;
  if (provider === "google") return config.oauth.google !== undefined;
  return false;
}

/**
 * AS-007.T1 / C-004 — the ordered list of enabled sign-in methods the UI renders buttons
 * from. Derived purely from config: email always, each OAuth provider only when configured.
 * Filtering PROVIDER_ORDER keeps the order stable and deterministic for the sign-in card.
 */
export function enabledProviders(config: Config): AuthMethod[] {
  return PROVIDER_ORDER.filter((p) => isProviderEnabled(config, p));
}

/**
 * AS-007.T2 / C-004 — server-side callback guard. Call this at the top of an OAuth callback
 * route: if the provider is disabled (or unknown), it throws ProviderDisabledError so the
 * route denies and never authenticates. For an enabled provider it is a no-op (allow).
 */
export function assertProviderEnabled(config: Config, provider: AuthMethod): void {
  if (!isProviderEnabled(config, provider)) {
    throw new ProviderDisabledError(provider);
  }
}
