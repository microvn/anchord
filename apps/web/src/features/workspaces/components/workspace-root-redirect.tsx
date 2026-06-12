import { Navigate } from "react-router-dom";
import { useBootstrap } from "@/features/workspaces/hooks/use-bootstrap";
import { ErrorState } from "@/components/error-state";
import { EmptyState } from "@/components/empty-state";

// S-001: the app root `/` resolves the landing workspace from the bootstrap (the persisted
// active workspace, else the first I belong to — C-005) and redirects into its `/w/:id/` path.
// With no workspaces at all (shouldn't happen — signup auto-creates one), an empty surface.
export function WorkspaceRootRedirect() {
  const query = useBootstrap();

  if (query.isPending) {
    return (
      <p className="px-4 py-8 text-sm text-muted" data-testid="root-loading">
        Loading…
      </p>
    );
  }
  if (query.isError) {
    return <ErrorState message={query.error?.message} onRetry={() => void query.refetch()} />;
  }

  const target = query.data?.activeWorkspaceId ?? query.data?.workspaces[0]?.id ?? null;
  if (!target) {
    return <EmptyState title="No workspace yet" description="You don't belong to any workspace." />;
  }
  return <Navigate to={`/w/${target}/`} replace />;
}
