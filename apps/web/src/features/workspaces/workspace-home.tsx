import { Link } from "react-router-dom";
import { useActiveWorkspace } from "./active-workspace";
import { useMembers } from "./use-bootstrap";
import { RenameField } from "./rename-field";
import { useWorkspaceDocs } from "../docs/use-docs";
import { DocList } from "../docs/doc-list";
import { NewDocButton } from "../docs/new-doc-dialog";
import { Icon } from "../../components/icon";
import { Skeleton } from "../../components/skeleton";
import { EmptyState } from "../../components/empty-state";
import { ErrorState } from "../../components/error-state";

// WorkspaceHome — the `/w/:id/` dashboard, 1:1 with Anchord-Design's Dashboard (screens.jsx).
// page-head (Workspace eyebrow + Fraunces workspace name + Rename/Members admin actions +
// teal New-doc) · a 4-card STAT ROW (Fraunces numbers + mono-uppercase labels) · a
// "Documents · Recent" section with "View all" → /docs and the recent doc rows.
//
// Wired to real data: useWorkspaceDocs (the union of access-filtered docs across the
// workspace's projects — no workspace-wide list endpoint exists) drives the DOCS + PROJECTS
// counts + the recent list. MEMBERS is read from the admin-only directory when the caller is
// an admin (else shown as "—"). COMMENTS has NO mounted aggregate or per-doc-count endpoint,
// so it is shown as "—" rather than faked. EmptyState only when the workspace has 0 docs.

const RECENT_LIMIT = 6;

export function WorkspaceHome() {
  const { workspace, isAdmin } = useActiveWorkspace();
  const docsQuery = useWorkspaceDocs(workspace.id);
  // The members directory is admin-only on the backend; only fetch it when we can read it.
  const membersQuery = useMembers(workspace.id);

  const docs = docsQuery.data?.docs ?? [];
  const projects = docsQuery.data?.projects ?? [];
  const memberCount = isAdmin ? membersQuery.data?.members?.length : undefined;

  const stats: { k: string; v: string }[] = [
    { k: "Docs", v: docsQuery.isPending ? "—" : String(docs.length) },
    { k: "Projects", v: docsQuery.isPending ? "—" : String(projects.length) },
    { k: "Members", v: memberCount == null ? "—" : String(memberCount) },
    // Comments now sum the per-doc commentCount the docs-list endpoint returns.
    {
      k: "Comments",
      v: docsQuery.isPending ? "—" : String(docs.reduce((a, d) => a + (d.commentCount ?? 0), 0)),
    },
  ];

  const recent = docs.slice(0, RECENT_LIMIT);

  return (
    <section className="mx-auto max-w-[1100px] px-6 py-8" data-testid="workspace-home">
      {/* page-head — Workspace eyebrow + Fraunces title, admin actions + New-doc pinned right. */}
      <div className="mb-[22px] flex items-end gap-4">
        <div>
          <div className="mb-2 font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-subtle">
            Workspace
          </div>
          <h1 className="font-serif text-[30px] font-medium leading-[1.05] tracking-[-0.02em] text-ink">
            {workspace.name}
          </h1>
        </div>
        <div className="ml-auto flex flex-none items-center gap-2">
          {isAdmin && <RenameField />}
          {isAdmin && (
            <Link
              to={`/w/${workspace.id}/members`}
              className="inline-flex h-8 items-center gap-[7px] rounded-md border border-line bg-surface px-3 text-[12.5px] font-semibold text-ink hover:border-subtle hover:bg-elev"
            >
              <Icon name="members" size={15} />
              Members
            </Link>
          )}
          <NewDocButton testid="home-new-doc" />
        </div>
      </div>

      {/* STAT ROW — 4 cards, Fraunces numbers + mono-uppercase labels (4→2 cols on narrow). */}
      <div className="mb-[22px] grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="stat-row">
        {stats.map((s) => (
          <div
            key={s.k}
            data-testid={`stat-${s.k.toLowerCase()}`}
            className="rounded-md border border-line bg-surface px-[14px] py-[13px]"
          >
            <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-subtle">
              {s.k}
            </div>
            <div className="mt-1.5 font-serif text-[25px] font-medium tabular-nums leading-[37.5px] tracking-[-0.03em] text-ink">
              {s.v}
            </div>
          </div>
        ))}
      </div>

      {/* Documents · Recent section. */}
      <div className="mt-[26px]" data-testid="recent-section">
        <div className="mb-3 flex items-center gap-[10px]">
          <span className="text-[15px] font-semibold text-ink">Documents</span>
          <span className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-subtle">
            Recent
          </span>
          <Link
            to={`/w/${workspace.id}/docs`}
            data-testid="view-all-docs"
            className="ml-auto text-[13.5px] text-muted hover:text-ink"
          >
            View all
          </Link>
        </div>

        {docsQuery.isPending ? (
          <Skeleton rows={4} />
        ) : docsQuery.isError ? (
          <ErrorState
            message={docsQuery.error?.message}
            onRetry={() => void docsQuery.refetch()}
          />
        ) : recent.length === 0 ? (
          <div className="rounded-[11px] border border-line bg-surface">
            <EmptyState
              title="No docs yet"
              description="Docs arrive when you publish from the CLI or MCP. Start one here to get going."
              action={<NewDocButton testid="empty-new-doc" />}
            />
          </div>
        ) : (
          <DocList docs={recent} />
        )}
      </div>
    </section>
  );
}
