import { useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useApiQuery } from "../../lib/use-api-query";
import { useViewerLayoutMode } from "../../lib/use-breakpoint";
import { Icon } from "../../components/icon";
import { EmptyState } from "../../components/empty-state";
import { ErrorState } from "../../components/error-state";
import { Skeleton } from "../../components/skeleton";
import { DocPane } from "./doc-pane";
import type { HtmlSandboxFrameHandle } from "./html-sandbox-frame";
import { DocModeToolbar } from "./doc-mode-toolbar";
import { TocSidebar } from "./toc-sidebar";
import { AnnotationsRail } from "./annotations-rail";
import { ViewerTopBar } from "./viewer-top-bar";
import { MetaStrip, type SpecMeta } from "./meta-strip";
import { toast } from "sonner";
import { useAnnotationMarks, placeAnnotations, scrollToAnno } from "./annotation-marks";
import { SelectionPopover } from "./selection-popover";
import { Composer } from "./composer";
import { useCompose } from "./use-compose";
import {
  fetchViewerDoc,
  listAnnotations,
  addComment,
  canComment,
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
    <ViewerShell
      title={doc.doc.title}
      doc={doc.doc}
      docResponse={doc}
      specMeta={specMeta}
      workspaceId={workspaceId}
      slug={slug}
      canCompose={canComment(doc.doc.effectiveRole)}
    />
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
  docResponse,
  specMeta,
  children,
  workspaceId,
  slug,
  canCompose = false,
}: {
  title: string;
  /** present only on the success path — drives the S-005 ViewerTopBar identity. */
  doc?: { title: string; kind: ViewerDocResponse["doc"]["kind"]; version: number; status: string };
  /** the full doc read on the success path — rendered into the center pane (DocPane). Absent on
   *  the loading / not-found / error shells (no doc to render). */
  docResponse?: ViewerDocResponse;
  specMeta?: SpecMeta | null;
  /** the loading / not-found / error shells render their state here instead of a DocPane. */
  children?: React.ReactNode;
  workspaceId?: string;
  slug?: string;
  /** S-001/C-004: whether the session's effective role may comment. A viewer-only role gets a
   *  read-only rail — no popover, no composer. False on the loading / error shells (no doc). */
  canCompose?: boolean;
}) {
  const { drawerMode, tocDrawer } = useViewerLayoutMode();
  const navigate = useNavigate();

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
  // S-001 (DocModeToolbar): the doc measure (Wide 760px | Focus 620px). Set on the docpane <main>
  // via data-doc-width so .doc-prose reflows. The toolbar only mounts on the success path (doc present).
  const [docWidth, setDocWidth] = useState<"wide" | "focus">("wide");
  const hasDoc = Boolean(workspaceId && slug);

  // S-003/S-006: the annotations are read here (lifted above the rail) so the CommentFab can show
  // the count and the highlight-tap can open the rail drawer, while the rail still renders them.
  const anno = useAnnotations(workspaceId, slug, docPaneEl, hasDoc, canCompose, () => {
    if (drawerMode) setRailOpen(true); // AS-014: tapping a highlight opens the rail drawer
  });

  // S-002: a handle to the HTML sandbox frame so a created annotation's highlight can be relayed
  // DOWN to the in-iframe bridge (the parent can't draw a <mark> into the opaque iframe).
  const htmlFrameRef = useRef<HtmlSandboxFrameHandle>(null);
  const isHtml = doc?.kind === "html";

  // S-001 (commenting write path): capture a text selection on the doc → popover → composer → send.
  // Gated by `canCompose` (C-004): a viewer-only role never sees a popover/composer (read-only rail).
  // S-002: on a successful create for an HTML doc, relay the highlight to the iframe bridge.
  const compose = useCompose(
    workspaceId,
    slug,
    docPaneEl,
    canCompose,
    () => {
      if (drawerMode) setRailOpen(true); // surface the composer in the rail drawer on tablet/mobile
      void anno.refetch();
    },
    (anchor, annotationId) => {
      // C-001: this fires only AFTER the server-authorized create succeeded — the highlight is a
      // consequence of the real annotation, never of the untrusted selection hint itself.
      if (isHtml) htmlFrameRef.current?.postHighlight(anchor, annotationId);
    },
  );

  const toggleRail = () => (drawerMode ? setRailOpen((o) => !o) : setRailVisible((v) => !v));
  const closeDrawers = () => {
    setRailOpen(false);
    setTocOpen(false);
  };

  const composerNode =
    compose.quote !== null ? (
      <Composer
        quote={compose.quote}
        pending={compose.pending}
        onSend={compose.send}
        onCancel={compose.cancel}
      />
    ) : null;

  // Optimistic threads (created locally, not yet reconciled by a refetch) lead the rail so the
  // newest comment tops the list (AS-001) and the count includes them (AS-001.T4 / C-011).
  const railAnnotations = [...compose.optimistic, ...anno.railProps.annotations];
  const railContent = hasDoc ? (
    <AnnotationsRail
      {...anno.railProps}
      annotations={railAnnotations}
      composer={composerNode}
    />
  ) : null;

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
          onBack={workspaceId ? () => navigate(`/w/${workspaceId}`) : undefined}
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
      {/* 3 equal panes (Outline · Doc · Comments) at desktop, per the product owner — diverges from
          the prototype's doc-hero proportions (236/1fr/312). Single column below lg (drawers). */}
      <div className="relative grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-3">
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
        <main
          ref={setDocPaneEl}
          data-testid="viewer-doc-pane"
          data-doc-width={docWidth}
          className="min-w-0 overflow-auto"
        >
          {doc && (
            <DocModeToolbar
              width={docWidth}
              onWidth={setDocWidth}
              onMarkupUnavailable={() => toast("Markup mode arrives with commenting")}
            />
          )}
          {docResponse ? (
            <DocPane
              doc={docResponse}
              htmlFrameRef={isHtml ? htmlFrameRef : undefined}
              // C-004: wire the bridge selection relay ONLY for a comment-capable role on an HTML
              // doc. A viewer-only role gets no onSelection → the frame never connects the bridge,
              // so a relayed (or forged) selection can't open a composer.
              onSelection={
                isHtml && canCompose
                  ? (anchor, rect) =>
                      compose.beginCompose(
                        anchor,
                        rect ? { top: rect.y + rect.height, left: rect.x } : null,
                      )
                  : undefined
              }
              onClearSelection={isHtml && canCompose ? compose.dismissPopover : undefined}
            />
          ) : (
            children
          )}
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
          {anno.count + compose.optimistic.length}
        </button>
      )}

      {/* S-001: the selection popover — floats over a live selection, offering Comment. Only ever
          rendered for a comment-capable role (C-004) and a real selection (C-003), both enforced in
          useCompose; mounted here so it overlays the viewer body. */}
      {compose.popover && (
        <SelectionPopover
          rect={compose.popover}
          onComment={compose.startComment}
          onDismiss={compose.dismissPopover}
        />
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
  canCompose: boolean,
  onHighlightTap: () => void,
): {
  count: number;
  refetch: () => Promise<unknown>;
  railProps: {
    annotations: ViewerAnnotation[];
    focusedId: string | null;
    unplaceableIds: Set<string>;
    onFocusThread: (id: string) => void;
    onReply?: (annotation: ViewerAnnotation, body: string) => Promise<boolean>;
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

  // S-003 (AS-006 / C-005): send a reply to an anchored thread. The reply is a comment whose
  // parentId is the annotation's FIRST/root comment — flat replies (the read side shapes every
  // reply as a sibling of the root, never nested, C-005). Identity rides the session cookie; the
  // body carries no userId (C-001). On success we refetch so the real reply replaces the card's
  // optimistic temp (mirrors S-001's reconcile-on-success — no duplicate). On a refused/failed
  // write we return false (the card's onReply=false contract → no ghost reply) + toast the same
  // error S-001 uses. Gated by canCompose (C-004): a viewer-only role gets no reply affordance.
  const onReply =
    canCompose && workspaceId && slug
      ? async (annotation: ViewerAnnotation, body: string): Promise<boolean> => {
          const parentId = (annotation.comments ?? [])[0]?.id;
          try {
            const res = await addComment(workspaceId, slug, annotation.id, {
              body,
              ...(parentId ? { parentId } : {}),
            });
            if (res.error) {
              toast.error("Couldn't post your reply");
              return false;
            }
            // Reconcile: the refetched thread carries the real reply flat under the annotation.
            await annoQuery.refetch();
            return true;
          } catch {
            toast.error("Couldn't post your reply");
            return false;
          }
        }
      : undefined;

  return {
    count: annotations.length,
    refetch: () => annoQuery.refetch(),
    railProps: { annotations, focusedId, unplaceableIds, onFocusThread: focusThread, onReply },
  };
}
