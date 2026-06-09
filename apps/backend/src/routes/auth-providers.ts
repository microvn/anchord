// HTTP route mount for the enabled-OAuth-provider read (auth-ui GAP-002 — AS-007).
//
// The frontend needs to know WHICH OAuth providers the operator enabled (ENV creds
// present at boot) so it renders only those "Continue with …" buttons — a provider with
// no creds must never get a button (AS-007). This is the tiny read it calls.
//
// Contract:
//   GET /api/auth-providers → 200 { providers: ["github", ...] }
//
// TOP-LEVEL + PRE-SESSION: this is read BEFORE the user signs in (the sign-in/sign-up
// screens consume it), so it is NOT under /api/w/:workspaceId and is NOT session-gated.
// It is enveloped like the rest of anchord's /api/* (apiEnvelope), so the FE unwraps the
// payload at `.data` (same as /api/me et al.).
//
// SOURCE OF TRUTH: the list is derived from the SAME config.oauth gating output the
// backend already uses for socialProviders (enabledOAuthProviders → isProviderEnabled →
// config.oauth, built by config/env.ts oauthFrom from GITHUB_CLIENT_ID/SECRET and
// GOOGLE_CLIENT_ID/SECRET). No second place reads env keys (DRY / C-004).
//
// No secrets leak: only the provider NAMES are returned, never the client id/secret.

import { Elysia } from "elysia";
import { apiEnvelope } from "../http/envelope";
import { enabledOAuthProviders, type OAuthMethod } from "../auth/providers";
import type { Config } from "../config/env";

export interface AuthProvidersRoutesDeps {
  /** The config's oauth toggle (the gating output config/env.ts already built). */
  oauth: Config["oauth"];
}

/** Elysia plugin factory for `GET /api/auth-providers`. Enveloped, top-level, pre-session. */
export function authProvidersRoutes(deps: AuthProvidersRoutesDeps) {
  return apiEnvelope(new Elysia()).get("/api/auth-providers", () => {
    // enabledOAuthProviders only reads config.oauth; build the minimal Config slice it
    // needs from the injected toggle (the route does not need the rest of Config).
    const providers: OAuthMethod[] = enabledOAuthProviders({ oauth: deps.oauth } as Config);
    return { providers };
  });
}
