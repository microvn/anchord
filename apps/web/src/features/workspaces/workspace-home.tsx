import { Link } from "react-router-dom";
import { useActiveWorkspace } from "./active-workspace";
import { RenameField } from "./rename-field";
import { Icon } from "../../components/icon";

// S-001/S-002: the landing inside the active workspace. Anchord-Design's `.page-head` (Fraunces
// page title + muted sub) + a calm "No docs yet" EmptyState (teal `+ New doc`), re-expressed in
// Tailwind utilities reading the @theme tokens (NO screens.css pile). The real projects/docs
// Browser + DocGrid is a separate spec (workspace-project-ui) and a LATER batch — this is the
// minimal home that proves the workspace is scoped + hosts the admin-only rename + a Members link.
// The switcher itself lives in the sidebar (C-005), never here.
export function WorkspaceHome() {
  const { workspace, isAdmin } = useActiveWorkspace();
  return (
    <section className="mx-auto max-w-[1100px] px-6 py-8" data-testid="workspace-home">
      {/* .page-head — title + sub on the left, quiet admin actions pinned right (flex-end). */}
      <div className="mb-[22px] flex items-end gap-4">
        <div>
          <h1 className="font-serif text-[30px] font-medium leading-[1.05] tracking-[-0.02em] text-ink">
            {workspace.name}
          </h1>
          <p className="mt-[5px] text-[13.5px] text-muted">Your active workspace.</p>
        </div>
        <div className="ml-auto flex flex-none items-center gap-2">
          {isAdmin && <RenameField />}
          <Link
            to={`/w/${workspace.id}/members`}
            className="flex min-h-[40px] items-center rounded-md border border-line bg-surface px-3 text-sm text-ink hover:border-accent"
          >
            Members
          </Link>
        </div>
      </div>

      {/* Calm empty surface inside a `.state-card` — one teal create CTA, no decorative
          illustration (AS-020). The real DocGrid replaces this once workspace-project-ui ships. */}
      <div className="rounded-[11px] border border-line bg-surface">
        <div className="mx-auto flex max-w-[380px] flex-col items-center px-6 py-14 text-center">
          <div className="text-[15px] font-semibold text-ink">No docs yet</div>
          <p className="mt-1.5 text-[12.5px] leading-[1.55] text-muted">
            Publish your first artifact to share it for review. Reviewers read the rendered doc and
            leave comments in the margin.
          </p>
          <div className="mt-[18px] flex items-center gap-2.5">
            <Link
              to={`/w/${workspace.id}/docs/new`}
              data-testid="home-new-doc"
              className="inline-flex min-h-[40px] items-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-on-accent hover:bg-accent-strong"
            >
              <Icon name="plus" size={16} />
              New doc
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
