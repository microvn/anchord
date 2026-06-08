import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { onSessionExpired } from "../lib/session-expiry";
import { signOut } from "../lib/auth-client";

// S-002 / AS-008: the in-tree half of session-expiry handling. The QueryClient's cache
// onError (outside the React tree) publishes a "session expired" signal; this component
// subscribes and does the two things that need router + auth context: clear the client-side
// session view (signOut) and route to /signin. Distinct from AS-004 (no session at NAV
// time): here a session was valid, then a mid-use request was rejected as unauthenticated.
//
// Mounted once under the Router (in App), so a single subscription serves the whole app.
export function SessionExpiryListener() {
  const navigate = useNavigate();

  useEffect(() => {
    return onSessionExpired(() => {
      // Clear the better-auth session view, then bounce. signOut is best-effort: even if the
      // network call fails (the session is already gone), we still navigate so the user is
      // never stranded on a broken page.
      void Promise.resolve(signOut()).catch(() => {});
      navigate("/signin", { replace: true });
    });
  }, [navigate]);

  return null;
}
