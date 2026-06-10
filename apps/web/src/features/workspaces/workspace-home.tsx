import { Link } from "react-router-dom";
import { useActiveWorkspace } from "./active-workspace";
import { RenameField } from "./rename-field";
import { Icon } from "../../components/icon";

// S-001/S-002: the landing inside the active workspace, lightly skinned to Anchord-Design's
// `.page-head` (Fraunces page title + sub) + the calm "No docs yet" EmptyState (teal `+ New doc`)
// so signing in shows a dashboard surface, not a bare void. The real projects/docs Browser +
// DocGrid is a separate spec (workspace-project-ui) and a LATER batch — this is the minimal home
// that proves the workspace is scoped and hosts the admin-only rename control + a Members link.
// The switcher itself lives in the sidebar (C-005), never here.
export function WorkspaceHome() {
  const { workspace, isAdmin } = useActiveWorkspace();
  return (
    <section className="content-inner" data-testid="workspace-home">
      <div className="page-head">
        <div>
          <h1 className="page-title">{workspace.name}</h1>
          <p className="page-sub">Your active workspace.</p>
        </div>
        <div className="page-actions">
          {isAdmin && <RenameField />}
          <Link
            to={`/w/${workspace.id}/members`}
            className="flex min-h-[40px] items-center rounded-md border border-line bg-surface px-3 text-sm text-ink hover:border-accent"
          >
            Members
          </Link>
        </div>
      </div>

      {/* Calm empty surface — one teal create CTA, no decorative illustration (AS-020). The real
          DocGrid replaces this once workspace-project-ui ships. */}
      <div className="state-card">
        <div className="state">
          <div className="state-title">No docs yet</div>
          <p className="state-msg">
            Publish your first artifact to share it for review. Reviewers read the rendered doc and
            leave comments in the margin.
          </p>
          <div className="state-actions">
            <Link to={`/w/${workspace.id}/docs/new`} className="state-cta" data-testid="home-new-doc">
              <Icon name="plus" size={16} />
              New doc
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
