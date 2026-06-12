import { Navigate, Outlet } from "react-router-dom";
import { useSession } from "@/lib/auth-client";

// AuthGuard (S-001, C-001/AS-004): the protected-route gate. Identity comes from the
// server session (cookie) via better-auth's useSession — we never read a client token.
// While the session resolves we render nothing (no flash of protected content); once
// resolved, no session → redirect to /signin (AS-004), session → render the outlet (the
// authenticated shell, AS-002).
export function AuthGuard() {
  const { data: session, isPending } = useSession();

  if (isPending) {
    return null;
  }

  if (!session) {
    return <Navigate to="/signin" replace />;
  }

  return <Outlet />;
}
