import { Link } from "react-router-dom";
import { useActiveWorkspace } from "./active-workspace";
import { RenameField } from "./rename-field";

// S-001/S-002: the landing inside the active workspace. The real projects/docs browser is a
// separate spec (workspace-project-ui); this is the minimal home that proves the workspace is
// scoped and hosts the admin-only rename control + a link to the members screen. The switcher
// itself lives in the AppShell top bar (workspace-name slot).
export function WorkspaceHome() {
  const { workspace, isAdmin } = useActiveWorkspace();
  return (
    <section className="px-4 py-8" data-testid="workspace-home">
      <h1 className="font-serif text-2xl text-ink">{workspace.name}</h1>
      <p className="mt-1 text-sm text-muted">Your active workspace.</p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {isAdmin && <RenameField />}
        <Link
          to={`/w/${workspace.id}/members`}
          className="flex min-h-[40px] items-center rounded-md border border-line bg-surface px-3 text-sm text-ink hover:border-accent"
        >
          Members
        </Link>
      </div>
    </section>
  );
}
