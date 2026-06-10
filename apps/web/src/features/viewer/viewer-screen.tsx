import { useParams } from "react-router-dom";
import { useApiQuery } from "../../lib/use-api-query";
import { EmptyState } from "../../components/empty-state";
import { ErrorState } from "../../components/error-state";
import { Skeleton } from "../../components/skeleton";
import { DocPane } from "./doc-pane";
import { fetchViewerDoc, type ViewerDocResponse } from "./client";

// ViewerScreen (S-001): the React route `/w/:workspaceId/d/:slug`. It fetches the doc via the
// workspace-scoped read, then renders it inside the 3-pane viewer shell — only the DocPane is
// built here (S-001); the TOC sidebar (S-002) and the annotations rail (S-003) are later stories,
// left as slots/placeholders so the layout already reserves their columns.
//
// C-002 (existence-hiding): a 404 — a missing slug OR a doc this session can't access — renders a
// not-found / no-access state, NEVER an empty viewer or a "0 comments" shell that would leak the
// doc's existence. Not-found and no-access are deliberately the same surface.

export function ViewerScreen() {
  const { workspaceId = "", slug = "" } = useParams<{ workspaceId: string; slug: string }>();

  const query = useApiQuery<ViewerDocResponse>(["viewer-doc", workspaceId, slug], () =>
    fetchViewerDoc(workspaceId, slug),
  );

  if (query.isPending) {
    return (
      <ViewerShell title="">
        <div className="px-5 pt-[14px]">
          <div className="mx-auto max-w-[760px]">
            <Skeleton rows={4} delayMs={0} />
          </div>
        </div>
      </ViewerShell>
    );
  }

  if (query.isError) {
    // C-002: a 404 (missing OR no-access) collapses to one not-found state — never the content,
    // never an empty render. Any other failure shows the retryable error surface.
    const notFound = query.error.status === 404 || query.error.code === "NOT_FOUND";
    if (notFound) {
      return (
        <ViewerShell title="Not found">
          <div data-testid="viewer-not-found" className="px-5 pt-10">
            <EmptyState
              title="Document not found"
              description="This document doesn't exist, or you don't have access to it."
            />
          </div>
        </ViewerShell>
      );
    }
    return (
      <ViewerShell title="">
        <div className="px-5 pt-10">
          <ErrorState
            message={query.error.message}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        </div>
      </ViewerShell>
    );
  }

  const doc = query.data;
  return (
    <ViewerShell title={doc.doc.title}>
      <DocPane doc={doc} />
    </ViewerShell>
  );
}

// The minimal 3-pane shell (S-001). TOC + rail are later stories — rendered as reserved slots so
// the structure (and DESIGN.md "chrome recedes behind the doc") is in place now. The top bar's
// full controls are S-005; here it carries only doc identity so the route is usable.
function ViewerShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div data-testid="viewer-screen" className="flex h-dvh flex-col bg-paper text-ink">
      <header className="flex h-12 flex-none items-center gap-2 border-b border-line px-4">
        <span className="truncate text-[13.5px] font-semibold text-ink">{title}</span>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[260px_1fr_360px]">
        {/* TocSidebar slot — S-002. */}
        <aside
          data-testid="viewer-toc-slot"
          className="hidden border-r border-line bg-sunken lg:block"
          aria-hidden
        />
        <main data-testid="viewer-doc-pane" className="min-w-0 overflow-auto">
          {children}
        </main>
        {/* AnnotationsRail slot — S-003. */}
        <aside
          data-testid="viewer-rail-slot"
          className="hidden border-l border-line bg-sunken lg:block"
          aria-hidden
        />
      </div>
    </div>
  );
}
