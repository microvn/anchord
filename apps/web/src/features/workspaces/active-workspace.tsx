import { createContext, useContext } from "react";
import { Navigate, Outlet, useParams } from "react-router-dom";
import { useBootstrap } from "./use-bootstrap";
import { ErrorState } from "../../components/error-state";
import type { WorkspaceListItem } from "./types";

// S-001 / C-001: the active workspace is the URL path `/w/:workspaceId/…` (mirroring the
// backend's `/api/w/:workspaceId/…`), NOT a hidden global. This context resolves the active
// workspace from the route param against the bootstrap list and exposes it to the subtree.
// Switching = navigating to another `/w/:id/` path, which re-reads this context and re-scopes
// every workspace-keyed query (GAP-001).

export interface ActiveWorkspace {
  workspace: WorkspaceListItem;
  /** Convenience: am I an admin of the active workspace? Drives admin-only affordances (C-002). */
  isAdmin: boolean;
}

const ActiveWorkspaceContext = createContext<ActiveWorkspace | null>(null);

/** The active workspace for the current route. Throws if read outside the guard (a bug). */
export function useActiveWorkspace(): ActiveWorkspace {
  const ctx = useContext(ActiveWorkspaceContext);
  if (!ctx) throw new Error("useActiveWorkspace must be used within WorkspaceRouteGuard");
  return ctx;
}

/**
 * S-001 route guard for `/w/:workspaceId/*`. Resolves the param against my workspaces:
 * - member → render the subtree with the active workspace in context (AS-002).
 * - NOT a member (stale link / typo) → redirect to a workspace I DO belong to, never a blank
 *   or broken app (AS-003). With no workspaces at all, show a recoverable error surface.
 * The active workspace is purely the route param here — no global state to fall out of sync.
 */
export function WorkspaceRouteGuard() {
  const { workspaceId } = useParams();
  const query = useBootstrap();

  if (query.isPending) {
    return (
      <p className="px-4 py-8 text-sm text-muted" data-testid="workspace-loading">
        Loading…
      </p>
    );
  }

  if (query.isError) {
    return <ErrorState message={query.error?.message} onRetry={() => void query.refetch()} />;
  }

  const workspaces = query.data?.workspaces ?? [];
  const match = workspaces.find((w) => w.id === workspaceId);

  // AS-003: a workspace id I'm not a member of must not load. Redirect into one I belong to
  // (prefer the bootstrap's active, else the first), replacing history so Back doesn't loop.
  if (!match) {
    const fallback = query.data?.activeWorkspaceId ?? workspaces[0]?.id ?? null;
    if (fallback && fallback !== workspaceId) {
      return <Navigate to={`/w/${fallback}/`} replace />;
    }
    // No workspace to fall back to — an explicit no-access surface, never a blank app.
    return (
      <div className="px-4 py-10" data-testid="no-workspace-access">
        <ErrorState message="You don't have access to this workspace." />
      </div>
    );
  }

  const value: ActiveWorkspace = { workspace: match, isAdmin: match.role === "admin" };
  return (
    <ActiveWorkspaceContext.Provider value={value}>
      <Outlet />
    </ActiveWorkspaceContext.Provider>
  );
}
