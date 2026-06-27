import { Navigate, Outlet, useSearchParams } from "react-router-dom";
import { useSession } from "@/lib/api/auth-client";

// GuestGuard: the mirror image of AuthGuard for the pre-session screens (/signin, /signup).
// An already-signed-in visitor has no business on the sign-in form — the common case is a
// verify-email link whose callbackURL lands on /signin, but the user already has a live
// session. Bounce them into the app instead of showing a pointless form.
// While the session resolves we render nothing (no flash of the auth form); once resolved,
// session → redirect, no session → render the outlet (the actual /signin or /signup screen).
export function GuestGuard() {
  const { data: session, isPending } = useSession();
  const [params] = useSearchParams();

  if (isPending) {
    return null;
  }

  if (session) {
    // Honor an internal ?redirect= (e.g. /signin?redirect=/d/<slug> from a "sign in to view
    // this doc" prompt) so an already-signed-in user lands where they were headed; otherwise
    // the app root. Same open-redirect guard as SignInScreen: a single leading "/", never
    // "//" or "/\" (browsers treat those as protocol-relative off-site).
    const raw = params.get("redirect");
    const to =
      raw && raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\") ? raw : "/";
    return <Navigate to={to} replace />;
  }

  return <Outlet />;
}
