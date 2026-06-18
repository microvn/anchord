import { createAuthClient } from "better-auth/react";

// The auth client talks to the backend's better-auth handler mounted at /api/auth/*
// (same origin — dev proxied, prod served by the backend). better-auth manages the
// session as an httpOnly cookie; this client stores NO token client-side (C-001).
//
// web-core exposes signIn (email+password), signOut, and the reactive useSession hook the
// AuthGuard reads on load. auth-ui ADDS the rest of the pre-session surface:
//  - signUp.email          → sign-up (S-001 AS-001/AS-005)
//  - sendVerificationEmail → "resend" on the verify-sent / expired-link states (AS-001/AS-004)
//  - verifyEmail           → consume a verification link (S-001 AS-003/AS-004)
//  - signIn.social         → OAuth sign-in; on a denied/failed callback better-auth
//                            redirects to the per-flow `errorCallbackURL` with ?error=…
//                            so the sign-in screen can render OAuthErrorBanner (S-002 AS-006/AS-008)
export const authClient = createAuthClient({
  baseURL:
    typeof window !== "undefined"
      ? `${window.location.origin}/api/auth`
      : "http://localhost:3000/api/auth",
});

export const {
  signIn,
  signUp,
  signOut,
  sendVerificationEmail,
  verifyEmail,
  useSession,
  getSession,
  // account-settings S-002: edit the signed-in user's display name; read the linked
  // sign-in provider from the better-auth `account` record (no new backend endpoint).
  updateUser,
  listAccounts,
} = authClient;
