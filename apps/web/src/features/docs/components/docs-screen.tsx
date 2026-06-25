import { useEffect, useState } from "react";
import { useActiveWorkspace } from "@/features/workspaces/components/active-workspace";
import { useWorkspaceDocs, DOCS_PAGE_SIZE } from "@/features/docs/hooks/use-docs";
import { useDocBrowse } from "@/features/docs/hooks/use-doc-browse";
import { DocCard } from "./doc-card";
import { DocList } from "./doc-list";
import { DocFilterBar } from "./doc-filter-bar";
import { NewDocButton } from "./new-doc-dialog";
import { Pagination } from "@/components/pagination";
import { Skeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { NoResultsState } from "@/components/no-results-state";
import { usePageMeta } from "@/hooks/use-page-meta";

// `/w/:id/docs` — the All-docs browser, 1:1 with Anchord-Design's ProjectBrowser
// (browser.jsx). page-head (Workspace eyebrow + Fraunces title + New-doc) · a shared DocFilterBar
// (faceted Filter popover + "showing X of N" + Sort + grid/list toggle, S-002/S-003) · a DocGrid of
// DocCards or a DocList. Wired to the REAL data: useWorkspaceDocs = the union of access-filtered docs
// across the workspace's projects (no workspace-wide list endpoint exists). 3→2→1 cols via the grid
// utilities. Loading=Skeleton, error=ErrorState (retry), empty=EmptyState, a filter that matches
// nothing=NoResultsState (distinct from the empty-data state). The dead 3-tab All/Shared/Has-detached
// strip is gone (replaced by the faceted filter — workspace-project-browse C-005).

export function DocsScreen() {
  usePageMeta("Documents");
  const { workspace } = useActiveWorkspace();
  const [page, setPage] = useState(1);
  // S-008: the grid pages SERVER-SIDE — one workspace-docs read per page (the server `limit` is
  // DOCS_PAGE_SIZE, so one server page fills one grid page exactly). The screen's `page` drives
  // the read; total pages come from the server `pagination`, not a client-side slice.
  const query = useWorkspaceDocs(workspace.id, page);

  const pageDocsRaw = query.data?.docs ?? [];
  const projects = query.data?.projects ?? [];
  const total = query.data?.pagination?.total ?? pageDocsRaw.length;
  const totalPages = query.data?.pagination?.totalPages ?? Math.ceil(total / DOCS_PAGE_SIZE);

  // S-002/S-003: the shared faceted filter + sort engine, applied to the SERVER page (the filter
  // narrows/sorts within the current page; the numbered nav pages the whole accessible union).
  const browse = useDocBrowse(pageDocsRaw);
  const filtered = browse.visible;
  // Clamp the page when the set shrinks (deletions) so a stale page never strands the user.
  useEffect(() => {
    if (page > totalPages && totalPages >= 1) setPage(totalPages);
  }, [page, totalPages]);
  const safePage = Math.min(page, Math.max(1, totalPages));
  const pageDocs = filtered;

  return (
    <section className="mx-auto max-w-[1100px] px-6 py-8" data-testid="docs-screen">
      <div className="mb-[22px] flex items-end gap-4">
        <div>
          <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.12em] text-subtle">
            Workspace
          </div>
          <h1 className="font-serif text-[30px] font-medium leading-[1.05] tracking-[-0.02em] text-ink">
            All docs
          </h1>
        </div>
        <div className="ml-auto flex flex-none items-center gap-2">
          <NewDocButton />
        </div>
      </div>

      {query.isPending ? (
        <Skeleton rows={5} />
      ) : query.isError ? (
        <ErrorState message={query.error?.message} onRetry={() => void query.refetch()} />
      ) : total === 0 ? (
        <EmptyState
          title="No docs yet"
          description="Docs arrive when you publish from the CLI or MCP. Start one here to get going."
          action={<NewDocButton />}
        />
      ) : (
        <>
          <DocFilterBar browse={browse} showing={filtered.length} />

          {filtered.length === 0 ? (
            <NoResultsState query="this filter" onClear={() => browse.filter.reset()} />
          ) : (
            <>
              {browse.view === "grid" ? (
                <div
                  data-testid="doc-grid"
                  className="grid grid-cols-1 gap-[14px] sm:grid-cols-2 lg:grid-cols-3"
                >
                  {pageDocs.map((d) => (
                    <DocCard key={d.id} doc={d} workspaceId={workspace.id} projects={projects} />
                  ))}
                </div>
              ) : (
                <DocList docs={pageDocs} workspaceId={workspace.id} projects={projects} />
              )}
              <Pagination page={safePage} totalPages={totalPages} onPageChange={setPage} />
            </>
          )}
        </>
      )}
    </section>
  );
}
