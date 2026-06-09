import { QueryClientProvider } from "@tanstack/react-query";
import { Navigate, Route, Routes } from "react-router-dom";
import { AuthGuard } from "./app/auth-guard";
import { AppShell } from "./app/app-shell";
import { SignInScreen } from "./features/auth/sign-in-screen";
import { createQueryClient } from "./app/query-client";
import { SessionExpiryListener } from "./app/session-expiry-listener";
import { ThemeProvider } from "./app/theme-provider";
import { WorkspaceRouteGuard } from "./features/workspaces/active-workspace";
import { WorkspaceSwitcher } from "./features/workspaces/workspace-switcher";
import { MembersScreen } from "./features/workspaces/members-screen";
import { WorkspaceHome } from "./features/workspaces/workspace-home";
import { WorkspaceRootRedirect } from "./features/workspaces/workspace-root-redirect";
import { WorkspaceInviteLanding } from "./features/workspaces/invite-landing";

// One shared QueryClient for the app's server-state layer (S-002). Its cache-level onError
// centralizes session-expiry handling: any query that comes back UNAUTHENTICATED bounces the
// user to /signin via SessionExpiryListener. Every feature `-ui` screen fetches through this
// same client (via useApiQuery), so the resilient behavior is consistent, not per-screen.
const queryClient = createQueryClient();

// The route table: /signin is public; everything under AuthGuard is protected (AS-004).
// The Router itself is provided in main.tsx so tests can supply MemoryRouter instead.
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/signin" element={<SignInScreen />} />
      <Route element={<AuthGuard />}>
        {/* workspaces-ui S-004: the invite accept/reject landing — a DISTINCT route from
            auth-ui's per-doc invite (GAP-002). Signed-in but OUTSIDE the workspace shell,
            since accepting is what grants membership. */}
        <Route path="/invite/workspace/:invitationId" element={<WorkspaceInviteLanding />} />

        <Route element={<AppShell workspaceSlot={<WorkspaceSwitcher />} />}>
          {/* workspaces-ui S-001: the active workspace is the URL path `/w/:workspaceId/…`
              (mirroring the backend's `/api/w/:workspaceId/…`). The root redirects into the
              bootstrap's active workspace; the guard re-scopes the subtree per route param. */}
          <Route index element={<WorkspaceRootRedirect />} />
          <Route path="/w/:workspaceId" element={<WorkspaceRouteGuard />}>
            <Route index element={<WorkspaceHome />} />
            <Route path="members" element={<MembersScreen />} />
          </Route>
          {/* Any unknown authenticated path falls back to the workspace root resolver. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
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
