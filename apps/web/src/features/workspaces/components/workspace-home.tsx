import { Link } from "react-router-dom";
import { useActiveWorkspace } from "./active-workspace";
import { useMembers } from "@/features/workspaces/hooks/use-bootstrap";
import { RenameField } from "./rename-field";
import { useWorkspaceDocs } from "@/features/docs/hooks/use-docs";
import { DocList } from "@/features/docs/components/doc-list";
import { NewDocButton } from "@/features/docs/components/new-doc-dialog";
import { Icon } from "@/components/icon";
import { Skeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { usePageMeta } from "@/hooks/use-page-meta";

// WorkspaceHome — the `/w/:id/` dashboard, 1:1 with Anchord-Design's Dashboard (screens.jsx).
// page-head (Workspace eyebrow + Fraunces workspace name + Rename/Members admin actions +
// teal New-doc) · a 4-card STAT ROW (Fraunces numbers + mono-uppercase labels) · a
// "Documents · Recent" section with "View all" → /docs and the recent doc rows.
//
// Wired to real data: useWorkspaceDocs (the union of access-filtered docs across the
// workspace's projects — no workspace-wide list endpoint exists) drives the DOCS + PROJECTS
// counts + the recent list. MEMBERS is read from the admin-only directory when the caller is
// an admin (else shown as "—"). ANNOTATIONS sums the per-doc active-annotation count the
// docs-list endpoint returns (S-007 / C-006). EmptyState only when the workspace has 0 docs.

const RECENT_LIMIT = 6;

export function WorkspaceHome() {
  const { workspace, isAdmin } = useActiveWorkspace();
  usePageMeta(workspace.name);
  const docsQuery = useWorkspaceDocs(workspace.id);
  // The members directory is admin-only on the backend; only fetch it when we can read it.
  const membersQuery = useMembers(workspace.id);

  // S-008: useWorkspaceDocs returns ONE server page (updated-desc) + workspace-wide counts.
  const docs = docsQuery.data?.docs ?? [];
  const projects = docsQuery.data?.projects ?? [];
  // The Docs count is the WHOLE-workspace accessible total (pagination.total), NOT docs.length —
  // which is now just one page. The Projects stat is projects.length (the active-project list);
  // this read carries no per-project doc count (AS-024).
  const totalDocs = docsQuery.data?.pagination?.total ?? docs.length;
  const memberCount = isAdmin ? membersQuery.data?.members?.length : undefined;

  const stats: { k: string; v: string }[] = [
    { k: "Docs", v: docsQuery.isPending ? "—" : String(totalDocs) },
    { k: "Projects", v: docsQuery.isPending ? "—" : String(projects.length) },
    { k: "Members", v: memberCount == null ? "—" : String(memberCount) },
    // Annotations sum the per-doc active-annotation count over the current page (the workspace
    // read returns active-annotation counts per doc, workspace-project-ui S-007 / C-006). Note:
    // with server-side paging this sums the loaded page, not the whole workspace — the endpoint
    // exposes no workspace-wide annotation total. The dashboard's recent view reads page 1.
    {
      k: "Annotations",
      v: docsQuery.isPending ? "—" : String(docs.reduce((a, d) => a + (d.annotationCount ?? 0), 0)),
    },
  ];

  const recent = docs.slice(0, RECENT_LIMIT);

  return (
    <section className="mx-auto max-w-[1080px] px-8 py-8" data-testid="workspace-home">
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
              className="inline-flex h-8 items-center gap-[7px] rounded-[8px] px-3 text-[12.5px] font-semibold text-muted transition-colors hover:bg-elev hover:text-ink"
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
            className="ml-auto inline-flex h-7 items-center rounded-[8px] px-2.5 text-[12.5px] font-semibold text-muted transition-colors hover:bg-elev hover:text-ink"
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
          <DocList docs={recent} workspaceId={workspace.id} />
        )}
      </div>
    </section>
  );
}
