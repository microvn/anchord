import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useActiveWorkspace } from "@/features/workspaces/components/active-workspace";
import { useProjectDocs, DOCS_PAGE_SIZE } from "@/features/docs/hooks/use-docs";
import { useDocBrowse } from "@/features/docs/hooks/use-doc-browse";
import { DocCard } from "./doc-card";
import { DocList } from "./doc-list";
import { DocFilterBar } from "./doc-filter-bar";
import { Pagination } from "@/components/pagination";
import { Icon } from "@/components/icon";
import { Skeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { NoResultsState } from "@/components/no-results-state";
import { usePageMeta } from "@/hooks/use-page-meta";

// `/w/:workspaceId/projects/:projectId` — the per-project doc browse (workspace-project-browse
// S-001). Clicking a project card on the Projects screen lands here: ONLY that project's docs
// (its own grid + numbered pagination + per-doc AccessIndicator, reused from All-docs), the
// project name as the view title, and a back-to-Projects control (AS-001/AS-002/AS-003). An
// empty project shows a named empty state, not a blank grid (AS-004). The SAME faceted filter +
// sort bar as All-docs mounts here (S-002/S-003, C-005).

export function ProjectDocsScreen() {
  const { workspace } = useActiveWorkspace();
  const { projectId = "" } = useParams();
  const query = useProjectDocs(workspace.id, projectId);
  const [page, setPage] = useState(1);

  const docs = query.data?.docs ?? [];
  const project = query.data?.project;
  // The project may not be in the active list (archived, or no longer present); fall back to a
  // neutral title so the view never renders nameless.
  const projectName = project?.name ?? "Project";
  usePageMeta(projectName);

  // S-002/S-003: the SAME faceted filter + sort engine as All-docs (C-005).
  const browse = useDocBrowse(docs);
  const visible = browse.visible;
  const totalPages = Math.ceil(visible.length / DOCS_PAGE_SIZE);
  useEffect(() => {
    if (page > totalPages && totalPages >= 1) setPage(totalPages);
  }, [page, totalPages]);
  // A new project id, or a filter/sort change, resets paging to the first page.
  useEffect(() => {
    setPage(1);
  }, [projectId, visible.length, browse.sort]);
  const safePage = Math.min(page, Math.max(1, totalPages));
  const pageDocs = visible.slice((safePage - 1) * DOCS_PAGE_SIZE, safePage * DOCS_PAGE_SIZE);

  return (
    <section className="mx-auto max-w-[1100px] px-6 py-8" data-testid="project-docs-screen">
      <div className="mb-[22px] flex items-end gap-4">
        <div className="min-w-0">
          <Link
            to={`/w/${workspace.id}/projects`}
            data-testid="back-to-projects"
            className="mb-2 inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-[0.12em] text-subtle transition-colors hover:text-ink"
          >
            <Icon name="chevLeft" size={13} />
            Projects
          </Link>
          <h1
            data-testid="project-docs-title"
            className="truncate font-serif text-[30px] font-medium leading-[1.05] tracking-[-0.02em] text-ink"
          >
            {projectName}
          </h1>
        </div>
      </div>

      {query.isPending ? (
        <Skeleton rows={5} />
      ) : query.isError ? (
        <ErrorState message={query.error?.message} onRetry={() => void query.refetch()} />
      ) : docs.length === 0 ? (
        <div data-testid="project-docs-empty">
          <EmptyState
            title="No docs in this project"
            description="Docs arrive when you publish into this project from the CLI or MCP, or move one here."
          />
        </div>
      ) : (
        <>
          <DocFilterBar browse={browse} showing={visible.length} />
          {visible.length === 0 ? (
            <NoResultsState query="this filter" onClear={() => browse.filter.reset()} />
          ) : browse.view === "grid" ? (
            <div
              data-testid="doc-grid"
              className="grid grid-cols-1 gap-[14px] sm:grid-cols-2 lg:grid-cols-3"
            >
              {pageDocs.map((d) => (
                <DocCard key={d.id} doc={d} workspaceId={workspace.id} projects={project ? [project] : []} />
              ))}
            </div>
          ) : (
            <DocList docs={pageDocs} workspaceId={workspace.id} projects={project ? [project] : []} />
          )}
          {visible.length > 0 && (
            <Pagination page={safePage} totalPages={totalPages} onPageChange={setPage} />
          )}
        </>
      )}
    </section>
  );
}
