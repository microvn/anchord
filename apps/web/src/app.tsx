import { QueryClientProvider } from "@tanstack/react-query";
import { Navigate, Route, Routes } from "react-router-dom";
import { AuthGuard } from "./app/auth-guard";
import { AppShell } from "./app/app-shell";
import { NavPlaceholder } from "./app/nav-placeholder";
import { WorkspaceSidebar } from "./app/workspace-sidebar";
import { createQueryClient } from "./app/query-client";
import { SessionExpiryListener } from "./app/session-expiry-listener";
import { ThemeProvider } from "./app/theme-provider";
import { SignInScreen } from "./features/auth/sign-in-screen";
import { SignUpScreen } from "./features/auth/sign-up-screen";
import { VerifyEmailLanding } from "./features/auth/verify-email-landing";
import { InviteAcceptLanding } from "./features/auth/invite-accept-landing";
import { WorkspaceInviteLanding } from "./features/workspaces/invite-landing";
import { WorkspaceRouteGuard } from "./features/workspaces/active-workspace";
import { WorkspaceRootRedirect } from "./features/workspaces/workspace-root-redirect";
import { WorkspaceHome } from "./features/workspaces/workspace-home";
import { MembersScreen } from "./features/workspaces/members-screen";

// One shared QueryClient for the app's server-state layer (S-002). Its cache-level onError
// centralizes session-expiry handling: any query that comes back UNAUTHENTICATED bounces the
// user to /signin via SessionExpiryListener. Feature screens fetch through this same client
// (via useApiQuery), so the resilient behavior is consistent, not per-screen.
const queryClient = createQueryClient();

// The route table. /signin, /signup, /verify-email are public; everything under AuthGuard
// is protected (unauthenticated → /signin). The Router itself is provided in main.tsx so
// tests can supply MemoryRouter instead.
export function AppRoutes() {
  return (
    <Routes>
      {/* Public pre-session screens (outside AuthGuard). */}
      <Route path="/signin" element={<SignInScreen />} />
      <Route path="/signup" element={<SignUpScreen />} />
      <Route path="/verify-email" element={<VerifyEmailLanding />} />

      <Route element={<AuthGuard />}>
        {/* Workspace invite accept/reject landing — signed in, outside the shell. */}
        <Route path="/invite/workspace/:invitationId" element={<WorkspaceInviteLanding />} />
        {/* Per-doc invite accept-link landing — distinct from the workspace invite. */}
        <Route path="/invite/doc/:inviteId" element={<InviteAcceptLanding />} />

        {/* S-001: the app root resolves the landing workspace and redirects into its /w/:id/. */}
        <Route index element={<WorkspaceRootRedirect />} />

        {/* Tenancy is scoped by URL path /w/:workspaceId/… (mirrors /api/w/:workspaceId/…). The
            AppShell (sidebar + header) wraps the WorkspaceRouteGuard, which resolves the active
            workspace from the route param and renders the matched screen at its outlet. */}
        <Route
          path="/w/:workspaceId"
          element={<AppShell sidebarSlot={<WorkspaceSidebar />} />}
        >
          <Route element={<WorkspaceRouteGuard />}>
            <Route index element={<WorkspaceHome />} />
            <Route path="members" element={<MembersScreen />} />
            {/* GAP-002: destinations owned by workspace-project-ui (not built yet) → clean
                placeholders, never a blank/crashed page. */}
            <Route path="docs" element={<NavPlaceholder title="All docs" />} />
            <Route path="docs/new" element={<NavPlaceholder title="New doc" />} />
            <Route path="projects" element={<NavPlaceholder title="Projects" />} />
            <Route path="activity" element={<NavPlaceholder title="Activity" />} />
          </Route>
        </Route>

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
