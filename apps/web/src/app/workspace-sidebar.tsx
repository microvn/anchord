import { useState } from "react";
import { useLocation } from "react-router-dom";
import { AppSidebar, navDestinations } from "./app-sidebar";
import { WorkspaceSwitcher } from "../features/workspaces/workspace-switcher";
import { useBootstrap } from "../features/workspaces/use-bootstrap";
import { useWorkspaceDocs } from "../features/docs/use-docs";
import { FORMAT_META } from "../features/docs/types";
import { NewDocDialog } from "../features/docs/new-doc-dialog";

const RECENT_LIMIT = 6;

// WorkspaceSidebar (web-core S-004): the CONNECTED sidebar AppShell mounts in the management
// context. It binds the presentational <AppSidebar /> to the live data:
//   - the workspace switcher (workspaces-ui — mounted, not rebuilt; C-005 single anchor),
//   - the active workspace's role from the /api/me bootstrap → admin-gates the Members entry,
//   - the nav + Members hrefs scoped to the active workspace path `/w/:id`,
//   - the RECENT group (workspace-project) — the most-recent N docs + a total-docs count badge
//     on the All-docs nav item (both from useWorkspaceDocs),
//   - the `+ New doc` button → opens the publish dialog in place (with the explicit workspace id,
//     since the sidebar is mounted ABOVE the WorkspaceRouteGuard provider).
export function WorkspaceSidebar({ dataTestId }: { dataTestId?: string }) {
  const query = useBootstrap();
  const { pathname } = useLocation();
  const [newDocOpen, setNewDocOpen] = useState(false);

  const workspaceId =
    pathname.match(/^\/w\/([^/]+)/)?.[1] ?? query.data?.activeWorkspaceId ?? undefined;
  const active = query.data?.workspaces.find((w) => w.id === workspaceId);
  const isAdmin = active?.role === "admin";
  const base = workspaceId ? `/w/${workspaceId}` : "/";

  // The RECENT group + total-docs badge. Only fetch once we know which workspace we're in.
  const docsQuery = useWorkspaceDocs(workspaceId ?? "");
  const allDocs = workspaceId ? (docsQuery.data?.docs ?? []) : [];
  const recentDocs = allDocs.slice(0, RECENT_LIMIT).map((d) => ({
    slug: d.slug,
    title: d.title,
    icon: (FORMAT_META[d.kind] ?? FORMAT_META.markdown).icon,
  }));
  const totalDocs = workspaceId && !docsQuery.isPending ? allDocs.length : undefined;

  return (
    <>
      <AppSidebar
        switcherSlot={<WorkspaceSwitcher />}
        isAdmin={isAdmin}
        newDocHref={`${base}/docs/new`}
        membersHref={`${base}/members`}
        nav={navDestinations(base)}
        recentDocs={recentDocs}
        totalDocs={totalDocs}
        docsHref={`${base}/docs`}
        docHrefBase={workspaceId ? base : undefined}
        onNewDoc={workspaceId ? () => setNewDocOpen(true) : undefined}
        dataTestId={dataTestId}
      />
      {workspaceId && (
        <NewDocDialog open={newDocOpen} onOpenChange={setNewDocOpen} workspaceId={workspaceId} />
      )}
    </>
  );
}
