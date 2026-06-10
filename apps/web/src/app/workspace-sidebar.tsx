import { useLocation } from "react-router-dom";
import { AppSidebar, navDestinations } from "./app-sidebar";
import { WorkspaceSwitcher } from "../features/workspaces/workspace-switcher";
import { useBootstrap } from "../features/workspaces/use-bootstrap";

// WorkspaceSidebar (web-core S-004): the CONNECTED sidebar AppShell mounts in the management
// context. It binds the presentational <AppSidebar /> to the live data:
//   - the workspace switcher (workspaces-ui — mounted, not rebuilt; C-005 single anchor),
//   - the active workspace's role from the /api/me bootstrap → admin-gates the Members entry
//     (AS-014, C-006 / workspaces-ui C-002),
//   - the nav + Members + New-doc hrefs scoped to the active workspace path `/w/:id`.
//
// Keeping the data binding here (not inside AppSidebar) lets the bare AppShell render the
// presentational sidebar without the workspaces query layer (web-core S-003 shell tests).
// Collapse↔rail + the mobile drawer are now owned by the shadcn Sidebar primitive (via the
// shared SidebarProvider), so this no longer threads collapse props.
export function WorkspaceSidebar({ dataTestId }: { dataTestId?: string }) {
  const query = useBootstrap();

  // The shell (hence this sidebar) is mounted ABOVE the `/w/:workspaceId` route, so `useParams`
  // can't see the id here — read it from the pathname (`/w/<id>/…`) instead, falling back to the
  // bootstrap's active workspace. Its `role` drives the admin-only Members entry (AS-014).
  // Unknown/loading → treat as non-admin (hide Members).
  const { pathname } = useLocation();
  const workspaceId = pathname.match(/^\/w\/([^/]+)/)?.[1] ?? query.data?.activeWorkspaceId ?? undefined;
  const active = query.data?.workspaces.find((w) => w.id === workspaceId);
  const isAdmin = active?.role === "admin";
  const base = workspaceId ? `/w/${workspaceId}` : "/";

  return (
    <AppSidebar
      switcherSlot={<WorkspaceSwitcher />}
      isAdmin={isAdmin}
      newDocHref={`${base}/docs/new`}
      membersHref={`${base}/members`}
      nav={navDestinations(base)}
      dataTestId={dataTestId}
    />
  );
}
