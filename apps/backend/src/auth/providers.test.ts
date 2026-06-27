import { test, expect } from "bun:test";
import {
  enabledProviders,
  isProviderEnabled,
  assertProviderEnabled,
  ProviderDisabledError,
} from "./providers";
import type { Config } from "../config/env";

// A minimal Config the provider logic actually reads. enabledProviders/isProviderEnabled
// only consult `config.oauth` (the S-002 gating OUTPUT — a provider key is present ONLY
// when the operator supplied both creds, see config/env.ts oauthFrom). We reuse that gating
// result rather than re-checking env keys, so there is one source of truth for "configured".
function cfg(oauth: Config["oauth"]): Config {
  return {
    NODE_ENV: "test",
    PORT: 3000,
    APP_SECRET: "x".repeat(16),
    DATABASE_URL: "postgres://x",
    APP_URL: "https://anchord.example.com",
    MAX_REQUEST_BODY_BYTES: 40 * 1024 * 1024,
    email: { kind: "smtp", host: "h", port: 587, user: "u", pass: "p" },
    SMTP: { host: "h", port: 587, user: "u", pass: "p" },
    ASSETS_DIR: "/data/assets",
    CORS_ORIGIN: "*",
    oauth,
  };
}

// ---------------------------------------------------------------------------
// AS-007.T1 — the enabled-providers list the sign-in UI consumes EXCLUDES a provider
// whose creds are absent/disabled (Google off), and INCLUDES the enabled ones
// (email+pw always; GitHub when its creds are present). The page renders only these
// buttons; the markup itself is [→MANUAL]/FE — we assert the list logic it consumes.
// ---------------------------------------------------------------------------
test("AS-007.T1: enabledProviders excludes Google when its creds are absent, includes email + GitHub when enabled", () => {
  // Operator: GitHub on, Google off (the AS-007 data: Google off, GitHub on).
  const list = enabledProviders(cfg({ github: { clientId: "gh", clientSecret: "s" } }));
  expect(list).toContain("email");
  expect(list).toContain("github");
  expect(list).not.toContain("google"); // disabled provider is NOT shown
  // Stable, documented order so the sign-in card renders deterministically.
  expect(list).toEqual(["email", "github"]);

  // email+password is always on (it has no creds toggle) even with zero OAuth configured.
  expect(enabledProviders(cfg({}))).toEqual(["email"]);

  // Both OAuth providers on → all three, email first, stable order.
  const all = enabledProviders(
    cfg({
      github: { clientId: "gh", clientSecret: "s" },
      google: { clientId: "g", clientSecret: "s" },
    }),
  );
  expect(all).toEqual(["email", "github", "google"]);

  // isProviderEnabled mirrors the list (the predicate the page uses per-button).
  const c = cfg({ github: { clientId: "gh", clientSecret: "s" } });
  expect(isProviderEnabled(c, "email")).toBe(true);
  expect(isProviderEnabled(c, "github")).toBe(true);
  expect(isProviderEnabled(c, "google")).toBe(false); // Google off → not enabled
  // Unknown / garbage provider name → not enabled (default-deny).
  expect(isProviderEnabled(c, "gitlab" as never)).toBe(false);
});

// ---------------------------------------------------------------------------
// AS-007.T2 — a FORCED callback to a disabled provider is REJECTED server-side. Hiding
// the button (T1) is not enough: a hand-crafted callback URL must not authenticate.
// assertProviderEnabled is the guard the callback route calls; for a disabled provider
// it throws ProviderDisabledError (denial), for an enabled one it is a no-op (allow).
// ---------------------------------------------------------------------------
test("AS-007.T2: a forced callback for a disabled provider is rejected (guard throws), enabled provider passes", () => {
  const c = cfg({ github: { clientId: "gh", clientSecret: "s" } }); // Google disabled

  // Forced Google callback → guard denies (the route must not authenticate).
  expect(() => assertProviderEnabled(c, "google")).toThrow(ProviderDisabledError);
  // The denial names the provider so the rejection is auditable.
  try {
    assertProviderEnabled(c, "google");
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderDisabledError);
    expect((e as Error).message).toContain("google");
  }

  // Enabled providers pass the guard (no throw) so legit callbacks still work.
  expect(() => assertProviderEnabled(c, "github")).not.toThrow();
  expect(() => assertProviderEnabled(c, "email")).not.toThrow();

  // Unknown provider name forced into the callback → rejected (default-deny).
  expect(() => assertProviderEnabled(c, "gitlab" as never)).toThrow(ProviderDisabledError);
});

// ---------------------------------------------------------------------------
// C-004 — providers are toggled via config; the UI shows ONLY enabled providers; a
// disabled provider rejects callbacks. This binds the three pieces (list shown +
// per-button predicate + callback guard) to the single config toggle as one invariant.
// ---------------------------------------------------------------------------
test("C-004: providers are toggled via config — UI shows only enabled providers and a disabled provider rejects callbacks", () => {
  // Toggle Google OFF in config.
  const off = cfg({ github: { clientId: "gh", clientSecret: "s" } });
  expect(enabledProviders(off)).not.toContain("google"); // not shown
  expect(isProviderEnabled(off, "google")).toBe(false);
  expect(() => assertProviderEnabled(off, "google")).toThrow(ProviderDisabledError); // rejects callback

  // Toggle Google ON in config (operator supplies creds) → now shown AND callback allowed.
  const on = cfg({
    github: { clientId: "gh", clientSecret: "s" },
    google: { clientId: "g", clientSecret: "s" },
  });
  expect(enabledProviders(on)).toContain("google"); // shown
  expect(isProviderEnabled(on, "google")).toBe(true);
  expect(() => assertProviderEnabled(on, "google")).not.toThrow(); // callback allowed
});
