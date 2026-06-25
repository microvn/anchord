import { QueryClientProvider } from "@tanstack/react-query";
import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { AuthGuard } from "./app/auth-guard";
import { AppShell } from "./app/app-shell";
import { WorkspaceSidebar } from "./app/workspace-sidebar";
import { createQueryClient } from "./app/query-client";
import { SessionExpiryListener } from "./app/session-expiry-listener";
import { ThemeProvider } from "./app/theme-provider";
import { SignInScreen } from "./features/auth/components/sign-in-screen";
import { SignUpScreen } from "./features/auth/components/sign-up-screen";
import { VerifyEmailLanding } from "./features/auth/components/verify-email-landing";
import { InviteAcceptLanding } from "./features/auth/components/invite-accept-landing";
import { WorkspaceInviteLanding } from "./features/workspaces/components/invite-landing";
import { WorkspaceRouteGuard } from "./features/workspaces/components/active-workspace";
import { WorkspaceRootRedirect } from "./features/workspaces/components/workspace-root-redirect";
import { WorkspaceHome } from "./features/workspaces/components/workspace-home";
import { MembersScreen } from "./features/workspaces/components/members-screen";
import { DocsScreen } from "./features/docs/components/docs-screen";
import { ProjectsScreen } from "./features/docs/components/projects-screen";
import { ProjectDocsScreen } from "./features/docs/components/project-docs-screen";
import { TrashScreen } from "./features/docs/components/trash-screen";
import { ActivityScreen } from "./features/activity/components/activity-screen";
import { ActivityDetailScreen } from "./features/activity/components/activity-detail-screen";
import { SearchScreen } from "./features/docs/components/search-screen";
import { ViewerScreen } from "./features/viewer/components/viewer-screen";
import { CapabilityRedeemScreen } from "./features/viewer/components/capability-redeem-screen";
import { SettingsPage } from "./features/settings/components/settings-page";
import { YourActivityPage } from "./features/your-activity/components/your-activity-page";
import { Toaster } from "./components/ui/sonner";

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

      {/* doc-access-routing S-003 (AS-013/AS-014): the PUBLIC doc viewer. Addressed by slug alone
          (C-002), OUTSIDE AuthGuard so a signed-out recipient of an anyone_with_link doc lands in
          the in-app viewer instead of being bounced to /signin. Access is decided by the doc read
          (anon-capable, existence-hiding); a no-access reply renders NoAccessView in place. */}
      <Route path="/d/:slug" element={<ViewerScreen />} />

      {/* capability-share-link S-002 (AS-004 / C-002 / C-009): the PUBLIC capability-link route.
          Addressed by an unguessable token (NOT the slug), OUTSIDE AuthGuard so a no-account guest
          lands here directly. It redeems the token (sets the admission cookie) then renders the
          viewer by the resolved slug WITHOUT navigating — the address bar keeps showing /s/<token>,
          the readable slug never appears (C-009). An unknown token → not-found (existence-hiding). */}
      <Route path="/s/:token" element={<CapabilityRedeemScreen />} />

      <Route element={<AuthGuard />}>
        {/* Workspace invite accept/reject landing — signed in, outside the shell. */}
        <Route path="/invite/workspace/:invitationId" element={<WorkspaceInviteLanding />} />
        {/* Per-doc invite accept-link landing — distinct from the workspace invite. */}
        <Route path="/invite/doc/:inviteId" element={<InviteAcceptLanding />} />

        {/* S-001: the app root resolves the landing workspace and redirects into its /w/:id/. */}
        <Route index element={<WorkspaceRootRedirect />} />

        {/* account-settings S-001 (C-001): the Settings area is ACCOUNT-level — a sibling of
            /w/:workspaceId, NOT workspace-scoped — and lives inside this AuthGuard block, so a
            signed-out visitor to /settings is redirected to sign-in (AS-003). Sections are
            deep-linkable by slug via /settings/:section; an unknown slug falls back to Account
            inside SettingsPage (C-002 / AS-004). It renders INSIDE the AppShell so the app chrome
            (workspace sidebar + header) is retained — there is no :workspaceId in the path and no
            WorkspaceRouteGuard; WorkspaceSidebar falls back to the session's active workspace and
            AppHeader shows the Account › Settings crumb. */}
        <Route element={<AppShell sidebarSlot={<WorkspaceSidebar />} />}>
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/:section" element={<SettingsPage />} />
          {/* your-activity-inbox S-001: the account-scoped "Your activity" page (For-you inbox),
              a sibling of /settings — account-level, NOT workspace-scoped, inside the AppShell. */}
          <Route path="/me/activity" element={<YourActivityPage />} />
        </Route>

        {/* doc-access-routing S-003: the old workspace-scoped viewer route is retired — the viewer
            is now the public slug-only `/d/:slug` above. Keep this as a thin redirect so any stale
            /w/:workspaceId/d/:slug link still resolves to the doc (slug carried through). */}
        <Route path="/w/:workspaceId/d/:slug" element={<LegacyViewerRedirect />} />

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
            {/* workspace-project-ui: the real dashboard/browser surfaces, wired to the API. */}
            <Route path="docs" element={<DocsScreen />} />
            {/* The New-doc flow is a dialog (opened from the sidebar/dashboard), not a page;
                the legacy /docs/new route lands on the All-docs grid where the dialog lives. */}
            <Route path="docs/new" element={<DocsScreen />} />
            <Route path="projects" element={<ProjectsScreen />} />
            {/* doc-delete-trash S-003: the workspace Trash (deleted docs + restore). */}
            <Route path="trash" element={<TrashScreen />} />
            {/* workspace-project-browse S-001: a project card opens its OWN doc browse (only that
                project's docs), not the workspace-wide union. */}
            <Route path="projects/:projectId" element={<ProjectDocsScreen />} />
            <Route path="activity" element={<ActivityScreen />} />
            {/* workspace-activity S-004: a feed row opens its detail page (metadata + publish diff +
                "More on this doc" + "Open doc" deep-link). */}
            <Route path="activity/:eventId" element={<ActivityDetailScreen />} />
            <Route path="search" element={<SearchScreen />} />
          </Route>
        </Route>

        {/* Any unknown authenticated path falls back to the root resolver. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

// doc-access-routing S-003: a stale `/w/:workspaceId/d/:slug` link redirects to the public
// slug-only `/d/:slug` viewer (the doc is addressed by slug alone — C-002).
function LegacyViewerRedirect() {
  const { slug = "" } = useParams<{ slug: string }>();
  return <Navigate to={`/d/${slug}`} replace />;
}

export function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        {/* Mounted inside the Router (main.tsx) so it can navigate on session expiry. */}
        <SessionExpiryListener />
        <AppRoutes />
        {/* Global toast host — publish/create success + error notices land here. */}
        <Toaster />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
