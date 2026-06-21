import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useSession } from "@/lib/api/auth-client";

// AuthGuard (S-001, C-001/AS-004): the protected-route gate. Identity comes from the
// server session (cookie) via better-auth's useSession — we never read a client token.
// While the session resolves we render nothing (no flash of protected content); once
// resolved, no session → redirect to /signin (AS-004), session → render the outlet (the
// authenticated shell, AS-002).
export function AuthGuard() {
  const { data: session, isPending } = useSession();
  const location = useLocation();

  if (isPending) {
    return null;
  }

  if (!session) {
    // Carry the attempted target (path + query) as ?redirect= so /signin returns the user
    // here after login — otherwise a deep link (e.g. a workspace invite carrying ?token=…
    // &email=…) is lost on the bounce and the invitee dead-ends at the sign-in form. /signin
    // honors only internal paths (open-redirect-safe). The bare "/" needs no redirect param.
    const target = `${location.pathname}${location.search}`;
    const to = target === "/" ? "/signin" : `/signin?redirect=${encodeURIComponent(target)}`;
    return <Navigate to={to} replace />;
  }

  return <Outlet />;
}
