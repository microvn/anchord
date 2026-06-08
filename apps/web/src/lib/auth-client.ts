import { createAuthClient } from "better-auth/react";

// The auth client talks to the backend's better-auth handler mounted at /api/auth/*
// (same origin — dev proxied, prod served by the backend). better-auth manages the
// session as an httpOnly cookie; this client stores NO token client-side (C-001).
//
// We expose the three things web-core needs: signIn (email+password), signOut, and the
// reactive useSession hook the AuthGuard reads on load.
export const authClient = createAuthClient({
  baseURL:
    typeof window !== "undefined"
      ? `${window.location.origin}/api/auth`
      : "http://localhost:3000/api/auth",
});

export const { signIn, signOut, useSession } = authClient;
