import { QueryClientProvider } from "@tanstack/react-query";
import { Navigate, Route, Routes } from "react-router-dom";
import { AuthGuard } from "./app/auth-guard";
import { createQueryClient } from "./app/query-client";
import { SessionExpiryListener } from "./app/session-expiry-listener";
import { ThemeProvider } from "./app/theme-provider";
import { Brandmark } from "./components/icon";

// One shared QueryClient for the app's server-state layer (S-002). Its cache-level onError
// centralizes session-expiry handling: any query that comes back UNAUTHENTICATED bounces the
// user to /signin via SessionExpiryListener. Feature screens (later phases) fetch through this
// same client (via useApiQuery), so the resilient behavior is consistent, not per-screen.
const queryClient = createQueryClient();

// Phase 0 placeholder: a centered anchord wordmark standing in for a real screen. Every
// route below points here for now; later phases replace each with its real screen WITHOUT
// touching the route table or the guard (both are already real).
function Placeholder({ label }: { label: string }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-paper text-ink">
      <div className="flex items-center gap-2">
        <Brandmark size={28} />
        <span className="font-serif text-2xl tracking-tight">anchord</span>
      </div>
      <p className="text-sm text-muted" data-testid="route-label">
        {label}
      </p>
    </div>
  );
}

// The route table. /signin, /signup, /verify-email are public; everything under AuthGuard
// is protected (unauthenticated → /signin). The Router itself is provided in main.tsx so
// tests can supply MemoryRouter instead.
export function AppRoutes() {
  return (
    <Routes>
      {/* Public pre-session screens (outside AuthGuard). */}
      <Route path="/signin" element={<Placeholder label="signin" />} />
      <Route path="/signup" element={<Placeholder label="signup" />} />
      <Route path="/verify-email" element={<Placeholder label="verify-email" />} />

      <Route element={<AuthGuard />}>
        {/* Workspace invite accept/reject landing — signed in, outside the shell. */}
        <Route
          path="/invite/workspace/:invitationId"
          element={<Placeholder label="invite-workspace" />}
        />
        {/* Per-doc invite accept-link landing — distinct from the workspace invite. */}
        <Route path="/invite/doc/:inviteId" element={<Placeholder label="invite-doc" />} />

        {/* Tenancy is scoped by URL path /w/:workspaceId/… (mirrors /api/w/:workspaceId/…). */}
        <Route index element={<Placeholder label="root-redirect" />} />
        <Route path="/w/:workspaceId/*" element={<Placeholder label="workspace-shell" />} />

        {/* Any unknown authenticated path falls back to the root resolver. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        {/* Mounted inside the Router (main.tsx) so it can navigate on session expiry. */}
        <SessionExpiryListener />
        <AppRoutes />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
