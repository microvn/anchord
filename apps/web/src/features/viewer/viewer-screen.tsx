import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useApiQuery } from "../../lib/use-api-query";
import { useViewerLayoutMode } from "../../lib/use-breakpoint";
import { Icon } from "../../components/icon";
import { EmptyState } from "../../components/empty-state";
import { ErrorState } from "../../components/error-state";
import { Skeleton } from "../../components/skeleton";
import { DocPane } from "./doc-pane";
import { TocSidebar } from "./toc-sidebar";
import { AnnotationsRail } from "./annotations-rail";
import { ViewerTopBar } from "./viewer-top-bar";
import { MetaStrip, type SpecMeta } from "./meta-strip";
import { toast } from "sonner";
import { useAnnotationMarks, placeAnnotations, scrollToAnno } from "./annotation-marks";
import {
  fetchViewerDoc,
  listAnnotations,
  type ViewerDocResponse,
  type ListAnnotationsResponse,
  type ViewerAnnotation,
} from "./client";

// ViewerScreen (S-001): the React route `/w/:workspaceId/d/:slug`. It fetches the doc via the
// workspace-scoped read, then renders it inside the 3-pane viewer shell. The TOC sidebar (S-002),
// the annotations rail (S-003), the top bar (S-005), and the responsive drawers (S-006) all mount
// into this shell.
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
  // S-005: the spec meta strip. The S-001 doc payload does NOT carry a spec flag or the
  // story/AS/updated/draft fields the strip wants (see meta-strip.tsx PAYLOAD GAP), so there is no
  // spec meta to show yet → `spec={null}` and the strip renders nothing. When the backend grows
  // those fields (or a spec-meta read lands), build a SpecMeta here from slug/version/url + counts.
  const specMeta: SpecMeta | null = null;
  return (
    <ViewerShell title={doc.doc.title} doc={doc.doc} specMeta={specMeta} workspaceId={workspaceId} slug={slug}>
      <DocPane doc={doc} />
    </ViewerShell>
  );
}

// The 3-pane shell (S-001 + S-002 + S-003 + S-005 + S-006). At desktop width the TOC + rail are
// inline grid columns; below 1200 the TOC collapses to an overlay drawer (toggled by the top bar's
// outline button); below 900 (drawer mode) the rail collapses to an overlay drawer too, and a
// CommentFab carrying the annotation count opens it. Tapping a highlight also opens the rail drawer
// in drawer mode (S-006, AS-014). Both drawers close via the shared DrawerScrim. The mapping is
// driven by the single `useViewerLayoutMode` hook (C-005: one breakpoint source).
//
// workspaceId/slug are absent on the loading / error shells (no doc yet) — the rail only mounts
// once a doc has rendered, so those calls omit them and the rail slot stays reserved-but-empty.
function ViewerShell({
  title,
  doc,
  specMeta,
  children,
  workspaceId,
  slug,
}: {
  title: string;
  /** present only on the success path — drives the S-005 ViewerTopBar identity. */
  doc?: { title: string; kind: ViewerDocResponse["doc"]["kind"]; version: number; status: string };
  specMeta?: SpecMeta | null;
  children: React.ReactNode;
  workspaceId?: string;
  slug?: string;
}) {
  const { drawerMode, tocDrawer } = useViewerLayoutMode();

  // The scrollable doc pane is both the scroll-spy container, the TOC heading source, AND the
  // highlight host for S-003. A callback ref re-derives once the content mounts (and on new doc).
  const [docPaneEl, setDocPaneEl] = useState<HTMLElement | null>(null);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  // S-005 (AS-012): `railVisible` is lifted here so the top bar's comments toggle can show/hide the
  // rail (desktop). S-006: in drawer mode the rail + TOC live in overlay drawers driven by
  // `railOpen` / `tocOpen` instead — the top bar's comments toggle and the CommentFab open the rail
  // drawer; the outline button opens the TOC drawer; the scrim closes both.
  const [railVisible, setRailVisible] = useState(true);
  const [railOpen, setRailOpen] = useState(false); // drawer-mode rail overlay
  const [tocOpen, setTocOpen] = useState(false); // toc-drawer overlay
  const hasDoc = Boolean(workspaceId && slug);

  // S-003/S-006: the annotations are read here (lifted above the rail) so the CommentFab can show
  // the count and the highlight-tap can open the rail drawer, while the rail still renders them.
  const anno = useAnnotations(workspaceId, slug, docPaneEl, hasDoc, () => {
    if (drawerMode) setRailOpen(true); // AS-014: tapping a highlight opens the rail drawer
  });

  const toggleRail = () => (drawerMode ? setRailOpen((o) => !o) : setRailVisible((v) => !v));
  const closeDrawers = () => {
    setRailOpen(false);
    setTocOpen(false);
  };

  const railContent = hasDoc ? <AnnotationsRail {...anno.railProps} /> : null;

  return (
    <div data-testid="viewer-screen" className="flex h-dvh flex-col bg-paper text-ink">
      {doc ? (
        // S-005: the full top bar. In tocDrawer mode the outline button opens the TOC drawer.
        <ViewerTopBar
          doc={doc}
          railVisible={drawerMode ? railOpen : railVisible}
          onToggleRail={toggleRail}
          onToggleToc={() => setTocOpen((o) => !o)}
          showTocToggle={tocDrawer}
          onVersion={() => toast("Version history isn't available yet")}
          onShare={() => toast("Sharing isn't available yet")}
          onOverflow={() => toast("More actions")}
        />
      ) : (
        // Loading / not-found / error states have no doc yet → a minimal title-only bar.
        <header className="flex h-12 flex-none items-center gap-2 border-b border-line px-4">
          <span className="truncate text-[13.5px] font-semibold text-ink">{title}</span>
        </header>
      )}
      {/* S-005 (AS-013): the spec meta strip — desktop, spec docs only. Null when not a spec doc. */}
      <div className="hidden lg:block">
        <MetaStrip spec={specMeta ?? null} />
      </div>
      <div className="relative grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[260px_1fr_360px]">
        {/* TocSidebar — S-002. Inline column when NOT in tocDrawer mode; an overlay drawer below
            1200 (S-006), opened by the top bar's outline button. */}
        {!tocDrawer && (
          <aside
            data-testid="viewer-toc-slot"
            className="hidden border-r border-line bg-sunken lg:block"
          >
            <TocSidebar contentEl={docPaneEl} activeId={activeSection} onActiveChange={setActiveSection} />
          </aside>
        )}
        <main ref={setDocPaneEl} data-testid="viewer-doc-pane" className="min-w-0 overflow-auto">
          {children}
        </main>
        {/* AnnotationsRail — S-003. Inline column on desktop while the comments toggle keeps it
            visible (S-005, AS-012). Hidden as an inline column in drawer mode — it moves to the
            overlay drawer below (S-006). */}
        {!drawerMode && railVisible && (
          <aside
            data-testid="viewer-rail-slot"
            className="hidden border-l border-line bg-sunken lg:block"
          >
            {railContent}
          </aside>
        )}

        {/* S-006: overlay drawers (drawer mode). Visual slide-in/bottom-sheet is [→MANUAL] +
            Playwright (C-005); here they are absolutely-positioned panels matching the prototype
            `.toc`/`.rail` drawer + `.drawer-scrim` structure. */}
        {tocDrawer && tocOpen && hasDoc && (
          <aside
            data-testid="viewer-toc-drawer"
            className="absolute inset-y-0 left-0 z-30 w-[260px] border-r border-line bg-sunken shadow-xl"
          >
            <TocSidebar
              contentEl={docPaneEl}
              activeId={activeSection}
              onActiveChange={setActiveSection}
            />
          </aside>
        )}
        {drawerMode && railOpen && hasDoc && (
          <aside
            data-testid="viewer-rail-drawer"
            className="absolute inset-y-0 right-0 z-30 w-[360px] max-w-[88vw] border-l border-line bg-sunken shadow-xl"
          >
            {railContent}
          </aside>
        )}
        {(tocOpen || railOpen) && (tocDrawer || drawerMode) && (
          <button
            type="button"
            data-testid="drawer-scrim"
            aria-label="Close"
            className="absolute inset-0 z-20 bg-black/40"
            onClick={closeDrawers}
          />
        )}
      </div>

      {/* CommentFab — S-006 (drawer mode only). Shows the annotation count; opens the rail drawer
          (prototype `.comment-fab`: pill, accent bg, on-accent text, inbox icon + count). */}
      {drawerMode && hasDoc && (
        <button
          type="button"
          data-testid="comment-fab"
          aria-label="Comments"
          className="fixed bottom-4 right-4 z-40 inline-flex h-11 items-center gap-2 rounded-full bg-accent px-4 text-[13px] font-semibold text-on-accent shadow-lg"
          onClick={() => setRailOpen(true)}
        >
          <Icon name="inbox" size={16} />
          {anno.count}
        </button>
      )}
    </div>
  );
}

// useAnnotations (S-003/S-006): reads the doc's annotations, places highlight marks against the doc
// content element, owns focus pairing (C-003), and exposes the rail props + the FAB count. Lifted
// out of the rail so the CommentFab (count) and the drawer-open-on-highlight-tap (AS-014) can share
// the same annotation set. `onHighlightTap` fires on a highlight click (after focus) so the shell
// can open the rail drawer in drawer mode.
function useAnnotations(
  workspaceId: string | undefined,
  slug: string | undefined,
  docPaneEl: HTMLElement | null,
  enabled: boolean,
  onHighlightTap: () => void,
): {
  count: number;
  railProps: {
    annotations: ViewerAnnotation[];
    focusedId: string | null;
    unplaceableIds: Set<string>;
    onFocusThread: (id: string) => void;
  };
} {
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const annoQuery = useApiQuery<ListAnnotationsResponse>(
    ["viewer-annotations", workspaceId, slug],
    () => listAnnotations(workspaceId ?? "", slug ?? ""),
    { enabled },
  );

  const annotations: ViewerAnnotation[] = annoQuery.data?.items ?? [];

  // Which anchored annotations the FE could NOT place at runtime (GAP-005).
  const unplaceableIds = useMemo(() => {
    const set = new Set<string>();
    if (!docPaneEl) return set;
    const { unplaceable } = placeAnnotations(docPaneEl, annotations);
    unplaceable.forEach((id) => set.add(id));
    return set;
  }, [docPaneEl, annotations]);

  // Place marks + wire click-on-highlight → focus thread (AS-008) AND open the rail drawer (AS-014).
  useAnnotationMarks(docPaneEl, annotations, focusedId, (id) => {
    setFocusedId(id);
    onHighlightTap();
  });

  const focusThread = (id: string) => {
    setFocusedId(id);
    scrollToAnno(docPaneEl, id); // AS-009: scroll to + emphasise the highlight.
  };

  return {
    count: annotations.length,
    railProps: { annotations, focusedId, unplaceableIds, onFocusThread: focusThread },
  };
}
