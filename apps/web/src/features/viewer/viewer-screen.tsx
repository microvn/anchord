import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useApiQuery } from "../../lib/use-api-query";
import { EmptyState } from "../../components/empty-state";
import { ErrorState } from "../../components/error-state";
import { Skeleton } from "../../components/skeleton";
import { DocPane } from "./doc-pane";
import { TocSidebar } from "./toc-sidebar";
import { AnnotationsRail } from "./annotations-rail";
import { useAnnotationMarks, placeAnnotations, scrollToAnno } from "./annotation-marks";
import {
  fetchViewerDoc,
  listAnnotations,
  type ViewerDocResponse,
  type ListAnnotationsResponse,
  type ViewerAnnotation,
} from "./client";

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
    <ViewerShell title={doc.doc.title} workspaceId={workspaceId} slug={slug}>
      <DocPane doc={doc} />
    </ViewerShell>
  );
}

// The minimal 3-pane shell (S-001 + S-002 + S-003). The TOC (S-002) reads its outline from the
// rendered doc content element (the scrollable doc pane). The AnnotationsRail (S-003) reads the
// doc's annotations and pairs each anchored one to an in-text highlight in that same content
// element. The top bar's full controls are S-005; here it carries only doc identity.
//
// workspaceId/slug are absent on the loading / error shells (no doc yet) — the rail only mounts
// once a doc has rendered, so those calls omit them and the rail slot stays reserved-but-empty.
function ViewerShell({
  title,
  children,
  workspaceId,
  slug,
}: {
  title: string;
  children: React.ReactNode;
  workspaceId?: string;
  slug?: string;
}) {
  // The scrollable doc pane is both the scroll-spy container, the TOC heading source, AND the
  // highlight host for S-003. A callback ref re-derives once the content mounts (and on new doc).
  const [docPaneEl, setDocPaneEl] = useState<HTMLElement | null>(null);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const hasDoc = Boolean(workspaceId && slug);

  return (
    <div data-testid="viewer-screen" className="flex h-dvh flex-col bg-paper text-ink">
      <header className="flex h-12 flex-none items-center gap-2 border-b border-line px-4">
        <span className="truncate text-[13.5px] font-semibold text-ink">{title}</span>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[260px_1fr_360px]">
        {/* TocSidebar — S-002 (collapses to a drawer on narrow screens in S-006). */}
        <aside
          data-testid="viewer-toc-slot"
          className="hidden border-r border-line bg-sunken lg:block"
        >
          <TocSidebar
            contentEl={docPaneEl}
            activeId={activeSection}
            onActiveChange={setActiveSection}
          />
        </aside>
        <main
          ref={setDocPaneEl}
          data-testid="viewer-doc-pane"
          className="min-w-0 overflow-auto"
        >
          {children}
        </main>
        {/* AnnotationsRail — S-003 (collapses to a drawer on narrow screens in S-006). */}
        <aside
          data-testid="viewer-rail-slot"
          className="hidden border-l border-line bg-sunken lg:block"
        >
          {hasDoc ? (
            <AnnotationsPane workspaceId={workspaceId!} slug={slug!} docPaneEl={docPaneEl} />
          ) : null}
        </aside>
      </div>
    </div>
  );
}

// AnnotationsPane (S-003): reads the doc's annotations, places highlight marks against the doc
// content element, and renders the rail. Owns focus pairing (C-003): clicking a highlight focuses
// its thread (via useAnnotationMarks), clicking a thread scrolls to + emphasises its highlight.
function AnnotationsPane({
  workspaceId,
  slug,
  docPaneEl,
}: {
  workspaceId: string;
  slug: string;
  docPaneEl: HTMLElement | null;
}) {
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const annoQuery = useApiQuery<ListAnnotationsResponse>(
    ["viewer-annotations", workspaceId, slug],
    () => listAnnotations(workspaceId, slug),
  );

  const annotations: ViewerAnnotation[] = annoQuery.data?.items ?? [];

  // Which anchored annotations the FE could NOT place at runtime (GAP-005) — a dry placement run
  // against the live content drives the "couldn't place" flag in the rail.
  const unplaceableIds = useMemo(() => {
    const set = new Set<string>();
    if (!docPaneEl) return set;
    const { unplaceable } = placeAnnotations(docPaneEl, annotations);
    unplaceable.forEach((id) => set.add(id));
    return set;
  }, [docPaneEl, annotations]);

  // Place marks + wire click-on-highlight → focus thread (AS-008).
  useAnnotationMarks(docPaneEl, annotations, focusedId, setFocusedId);

  const focusThread = (id: string) => {
    setFocusedId(id);
    scrollToAnno(docPaneEl, id); // AS-009: scroll to + emphasise the highlight.
  };

  if (annoQuery.isPending) return null;

  return (
    <AnnotationsRail
      annotations={annotations}
      focusedId={focusedId}
      unplaceableIds={unplaceableIds}
      onFocusThread={focusThread}
    />
  );
}
