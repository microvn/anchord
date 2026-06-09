import { QueryClientProvider } from "@tanstack/react-query";
import { Navigate, Route, Routes } from "react-router-dom";
import { AuthGuard } from "./app/auth-guard";
import { AppShell } from "./app/app-shell";
import { SignInScreen } from "./features/auth/sign-in-screen";
import { SignUpScreen } from "./features/auth/sign-up-screen";
import { VerifyEmailLanding } from "./features/auth/verify-email-landing";
import { InviteAcceptLanding } from "./features/auth/invite-accept-landing";
import { createQueryClient } from "./app/query-client";
import { SessionExpiryListener } from "./app/session-expiry-listener";
import { ThemeProvider } from "./app/theme-provider";
import { WorkspaceRouteGuard } from "./features/workspaces/active-workspace";
import { WorkspaceSidebar } from "./app/workspace-sidebar";
import { NavPlaceholder } from "./app/nav-placeholder";
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
      {/* auth-ui S-001/S-002: pre-session screens (public, outside AuthGuard). */}
      <Route path="/signin" element={<SignInScreen />} />
      <Route path="/signup" element={<SignUpScreen />} />
      {/* auth-ui S-001 AS-003/AS-004: the verification-link landing. Public — the link is
          opened before any session exists. */}
      <Route path="/verify-email" element={<VerifyEmailLanding />} />
      <Route element={<AuthGuard />}>
        {/* workspaces-ui S-004: the WORKSPACE invite accept/reject landing. */}
        <Route path="/invite/workspace/:invitationId" element={<WorkspaceInviteLanding />} />
        {/* auth-ui S-003: the PER-DOC invite accept-link landing — DISTINCT from the
            workspace invite above. Signed-in (needs the session actor's verified email to
            match), but OUTSIDE the workspace shell, since accepting grants a doc role. */}
        <Route path="/invite/doc/:inviteId" element={<InviteAcceptLanding />} />

        <Route element={<AppShell sidebarSlot={<WorkspaceSidebar />} />}>
          {/* workspaces-ui S-001: the active workspace is the URL path `/w/:workspaceId/…`
              (mirroring the backend's `/api/w/:workspaceId/…`). The root redirects into the
              bootstrap's active workspace; the guard re-scopes the subtree per route param. */}
          <Route index element={<WorkspaceRootRedirect />} />
          <Route path="/w/:workspaceId" element={<WorkspaceRouteGuard />}>
            <Route index element={<WorkspaceHome />} />
            <Route path="members" element={<MembersScreen />} />
            {/* web-core S-004 / GAP-002: the sidebar nav destinations (All docs · Projects ·
                Activity + New doc) are owned by workspace-project-ui and not built here. The
                shell ROUTES to them regardless; until that ships they land on a placeholder. */}
            <Route path="docs" element={<NavPlaceholder title="All docs" />} />
            <Route path="docs/new" element={<NavPlaceholder title="New doc" />} />
            <Route path="projects" element={<NavPlaceholder title="Projects" />} />
            <Route path="activity" element={<NavPlaceholder title="Activity" />} />
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
