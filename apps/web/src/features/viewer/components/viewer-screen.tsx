import { useCallback, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useApiQuery } from "@/lib/api/use-api-query";
import { useViewerLayoutMode } from "@/hooks/use-breakpoint";
import { Icon } from "@/components/icon";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { Skeleton } from "@/components/skeleton";
import { DocPane } from "./doc-pane";
import type { HtmlSandboxFrameHandle } from "./html-sandbox-frame";
import { DocModeToolbar } from "./doc-mode-toolbar";
import { TocSidebar } from "./toc-sidebar";
import { AnnotationsRail } from "./annotations-rail";
import { ViewerTopBar } from "./viewer-top-bar";
import { MetaStrip } from "./meta-strip";
import type { SpecMeta } from "@/features/viewer/types";
import { toast } from "sonner";
import { useAnnotationMarks, scrollToAnno } from "./annotation-marks";
import { SelectionPopover } from "./selection-popover";
import { Composer } from "./composer";
import { useDismissOnOutsideAndEscape } from "@/features/viewer/hooks/use-dismiss";
import { useDraggable } from "@/features/viewer/hooks/use-draggable";
import { useCompose, peelCommentId } from "@/features/viewer/hooks/use-compose";
import { ShareDialog } from "@/features/sharing/components/share-dialog";
import { canManageShare } from "@/features/sharing/services/client";
import { VersionHistoryPanel } from "@/features/versioning/components/version-history-panel";
import {
  fetchViewerDoc,
  listAnnotations,
  addComment,
  setResolution,
  canComment,
  type ViewerDocResponse,
  type ListAnnotationsResponse,
  type ViewerAnnotation,
} from "@/features/viewer/services/client";

// ViewerScreen (S-001): the React route `/w/:workspaceId/d/:slug`. It fetches the doc via the
// workspace-scoped read, then renders it inside the 3-pane viewer shell. The TOC sidebar (S-002),
// the annotations rail (S-003), the top bar (S-005), and the responsive drawers (S-006) all mount
// into this shell.
//
// C-002 (existence-hiding): a 404 — a missing slug OR a doc this session can't access — renders a
// not-found / no-access state, NEVER an empty viewer or a "0 comments" shell that would leak the
// doc's existence. Not-found and no-access are deliberately the same surface.

// MƯỢT TASK 1/3: the iframe bridge sends a selection rect as {x,y,width,height} (iframe-local
// viewport coords). placePopover wants a RectLike {top,bottom,left,right} — convert here. The
// popover is position:absolute over the viewer body, so iframe-local top/left is a close-enough
// anchor for v0 (pixel-exact cross-frame offset is [→MANUAL]/Playwright).
function frameRectToViewport(rect: { x: number; y: number; width: number; height: number }): {
  top: number;
  bottom: number;
  left: number;
  right: number;
} {
  return { top: rect.y, bottom: rect.y + rect.height, left: rect.x, right: rect.x + rect.width };
}

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
      effectiveRole={doc.doc.effectiveRole}
      canCompose={canComment(doc.doc.effectiveRole)}
      // S-005: a logged-out guest session (consumed from the read side) → the composer shows the
      // GuestNameField + name-required gate; the rail badges the guest comment (C-010).
      guest={doc.doc.guest === true}
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
  effectiveRole,
  canCompose = false,
  guest = false,
}: {
  title: string;
  /** present only on the success path — drives the S-005 ViewerTopBar identity. */
  doc?: { title: string; kind: ViewerDocResponse["doc"]["kind"]; version: number; status: string };
  /** the session's effective role on this doc — gates the Share affordance (S-001 / C-002). */
  effectiveRole?: ViewerDocResponse["doc"]["effectiveRole"];
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
  /** S-005: this is a logged-out guest session → the composer shows the GuestNameField + gates
   *  Send on a name (C-007). Consumed from the read side; the FE doesn't own the sharing toggle. */
  guest?: boolean;
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
  // C-006 / AS-018: the desktop inline-outline visibility (Markdown only). The outline-toggle
  // collapses it to give the content more room; in tocDrawer mode the same toggle drives `tocOpen`.
  const [tocVisible, setTocVisible] = useState(true);
  // S-001 (DocModeToolbar): the doc measure (Wide = full column width | Focus = 800px). Set on the docpane <main>
  // via data-doc-width so .doc-prose reflows. The toolbar only mounts on the success path (doc present).
  const [docWidth, setDocWidth] = useState<"wide" | "focus">("wide");
  const hasDoc = Boolean(workspaceId && slug);

  // S-001 (AS-001): the ShareDialog open-state, hosted here so the top bar's Share button opens it.
  const [shareOpen, setShareOpen] = useState(false);
  // versioning-diff-ui S-001 (AS-001): the VersionHistoryPanel open-state, hosted here so the top
  // bar's version button opens it (replacing the old placeholder toast). doc.version is the current
  // version (the "Current" marker / later the default Compare target).
  const [versionsOpen, setVersionsOpen] = useState(false);
  // C-002 (Share affordance gate): only a potential manager (owner, or editor — the editor's
  // editorsCanShare is re-checked after the dialog reads the share state) is shown the Share button.
  // A viewer/commenter — or an absent role (conservative) — never gets a Share affordance that opens
  // the editable dialog (AS-003). canManageShare(role, true) treats owner→true, editor→true (the
  // toggle is verified post-open), viewer/commenter/absent→false.
  const canShare = canManageShare(effectiveRole, true);

  // S-003/S-006: the annotations are read here (lifted above the rail) so the CommentFab can show
  // the count and the highlight-tap can open the rail drawer, while the rail still renders them.
  const anno = useAnnotations(workspaceId, slug, docPaneEl, hasDoc, canCompose, () => {
    if (drawerMode) setRailOpen(true); // AS-014: tapping a highlight opens the rail drawer
  });

  // S-002: a handle to the HTML sandbox frame so a created annotation's highlight can be relayed
  // DOWN to the in-iframe bridge (the parent can't draw a <mark> into the opaque iframe).
  const htmlFrameRef = useRef<HtmlSandboxFrameHandle>(null);
  const isHtml = doc?.kind === "html";
  // C-006: the outline exists ONLY for a Markdown doc (its headings are derivable in the app-origin
  // render). An HTML doc lives in a cross-origin sandbox and an image has no headings (GAP-004), so
  // both render 2-pane (content + rail) with no outline pane and no outline-toggle.
  const isMarkdown = doc?.kind === "markdown";

  // S-001 (commenting write path): capture a text selection on the doc → popover → composer → send.
  // Gated by `canCompose` (C-004): a viewer-only role never sees a popover/composer (read-only rail).
  // S-002: on a successful create for an HTML doc, relay the highlight to the iframe bridge.
  const compose = useCompose(
    workspaceId,
    slug,
    docPaneEl,
    canCompose,
    (real) => {
      // PERF: reconcile the create WITHOUT a refetch — prepend the real server row into the
      // react-query cache (newest-first, deduped). The rail re-renders with no network reload.
      anno.prependAnnotation(real);
      if (drawerMode) setRailOpen(true); // surface the new thread in the rail drawer on tablet/mobile
    },
    (anchor, annotationId) => {
      // C-001: this fires only AFTER the server-authorized create succeeded — the highlight is a
      // consequence of the real annotation, never of the untrusted selection hint itself.
      if (isHtml) htmlFrameRef.current?.postHighlight(anchor, annotationId);
    },
  );

  const toggleRail = () => (drawerMode ? setRailOpen((o) => !o) : setRailVisible((v) => !v));
  // The outline-toggle: in tocDrawer mode it opens/closes the TOC overlay drawer; on desktop it
  // collapses/expands the inline outline column (AS-018). Markdown-only (the button isn't shown
  // for html/image — C-006).
  const toggleToc = () => (tocDrawer ? setTocOpen((o) => !o) : setTocVisible((v) => !v));

  // The 3-pane grid columns are derived from the SAME JS tier that gates which panes render, so the
  // template never reserves a column for an absent pane. (The old `lg:grid-cols-[236px_1fr_312px]`
  // keyed off Tailwind `lg`=1024px while the TOC/rail render off the JS tiers 900/1200 — the two
  // disagreed, leaving the doc squished into the empty TOC slot at 1024–1199 and the rail vanishing
  // at 900–1023.) doc column = minmax(0,1fr) so long content shrinks instead of overflowing.
  //   <900 (drawer)            → doc only
  //   900–1199 (TOC drawer)    → doc + rail (when visible)
  //   ≥1200 (desktop)          → TOC + doc + rail (when visible)
  // C-006: the outline column appears only for Markdown, at desktop width (≥1200, i.e. not
  // tocDrawer), and while not collapsed (AS-018). html/image never reserve it → 2-pane (full-width
  // doc + rail). doc column = minmax(0,1fr) so long content shrinks instead of overflowing.
  const tocInline = isMarkdown && !tocDrawer && tocVisible;
  const railInline = !drawerMode && railVisible;
  const gridCols = [tocInline ? "236px" : null, "minmax(0,1fr)", railInline ? "312px" : null]
    .filter(Boolean)
    .join(" ");
  const closeDrawers = () => {
    setRailOpen(false);
    setTocOpen(false);
  };

  // #3 (2026-06-12) — PRODUCT DECISION (deviates from the spec's "Composer in AnnotationsRail"):
  // the composer is now an INLINE popover anchored at the selection (above-centered, same anchor as
  // the selection popover) so the user types + sends right at the text. Only the COMPOSING UI moved;
  // the optimistic + reconciled threads still land in the rail as before. Recorded here for /mf-plan.
  const composerNode =
    compose.quote !== null && compose.composerAnchor ? (
      <InlineComposerPopover
        anchor={compose.composerAnchor}
        quote={compose.quote}
        pending={compose.pending}
        guest={guest}
        onSend={compose.send}
        onCancel={compose.cancel}
      />
    ) : null;

  // Optimistic threads (created locally, not yet reconciled by a refetch) lead the rail so the
  // newest comment tops the list (AS-001) and the count includes them (AS-001.T4 / C-011).
  const railAnnotations = [...compose.optimistic, ...anno.railProps.annotations];
  const railContent = hasDoc ? (
    <AnnotationsRail {...anno.railProps} annotations={railAnnotations} />
  ) : null;

  return (
    <div data-testid="viewer-screen" className="flex h-dvh flex-col bg-paper text-ink">
      {doc ? (
        // S-005: the full top bar. In tocDrawer mode the outline button opens the TOC drawer.
        <ViewerTopBar
          doc={doc}
          railVisible={drawerMode ? railOpen : railVisible}
          onToggleRail={toggleRail}
          onToggleToc={toggleToc}
          // C-006: the outline-toggle is shown only for Markdown — on desktop it collapses the
          // inline outline (AS-018), in drawer mode it opens the TOC drawer. html/image: no toggle.
          showTocToggle={isMarkdown}
          onBack={workspaceId ? () => navigate(`/w/${workspaceId}`) : undefined}
          onVersion={() => setVersionsOpen(true)}
          onShare={() => setShareOpen(true)}
          showShare={canShare}
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
      {/* 3-pane shell (Outline · Doc · Comments) at desktop in the prototype's doc-hero proportions
          236/1fr/312 (Anchord-Design/viewer.css `.vbody`): the DOC column is the dominant 1fr, the
          outline + comments are fixed-width rails — NOT equal thirds. Single column below lg (drawers). */}
      <div className="relative grid min-h-0 flex-1" style={{ gridTemplateColumns: gridCols }}>
        {/* TocSidebar — S-002. Markdown-only (C-006). Inline column at desktop width while not
            collapsed (AS-018); an overlay drawer below 1200 (S-006), opened by the outline button. */}
        {tocInline && (
          <aside
            data-testid="viewer-toc-slot"
            // min-h-0 + overflow-hidden: as a grid item this would otherwise grow to its content
            // height (grid items default to min-height:auto), so the inner outline list never
            // overflow-scrolls. Constraining the slot lets TocSidebar's own list scroll.
            className="min-h-0 overflow-hidden border-r border-line bg-sunken"
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
                      compose.beginCompose(anchor, rect ? frameRectToViewport(rect) : null)
                  : undefined
              }
              onClearSelection={isHtml && canCompose ? compose.dismissPopover : undefined}
              // MƯỢT TASK 3: the iframe re-posts its selection rect on its own in-iframe scroll
              // (the parent can't see that scroll); reposition the open popover via placePopover.
              onSelectionRect={
                isHtml && canCompose
                  ? (rect) => compose.repositionFromRect(frameRectToViewport(rect))
                  : undefined
              }
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
            // min-h-0 + overflow-hidden so the rail's own thread list overflow-scrolls (same
            // grid-item min-height:auto issue as the TOC slot).
            className="min-h-0 overflow-hidden border-l border-line bg-sunken"
          >
            {railContent}
          </aside>
        )}

        {/* S-006: overlay drawers (drawer mode). Visual slide-in/bottom-sheet is [→MANUAL] +
            Playwright (C-005); here they are absolutely-positioned panels matching the prototype
            `.toc`/`.rail` drawer + `.drawer-scrim` structure. */}
        {isMarkdown && tocDrawer && tocOpen && hasDoc && (
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
          onMeasure={compose.setPopoverSize}
        />
      )}

      {/* #3: the INLINE composer popover — replaces the selection popover at the same anchor once
          the user picks Comment. Mounted here (overlays the viewer body), not in the rail. */}
      {composerNode}

      {/* S-001: the ShareDialog — opened by the top bar's Share button. Only a doc with a
          workspace + slug can be shared; the dialog reads the share state on open to prefill +
          re-check editor manage-eligibility (C-002). */}
      {hasDoc && doc && (
        <ShareDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          workspaceId={workspaceId!}
          slug={slug!}
          docTitle={doc.title}
          effectiveRole={effectiveRole}
        />
      )}

      {/* versioning-diff-ui S-001: the version history panel — opened by the top bar's version
          button. Compare/Restore are wired in later stories (S-002/S-003); for now they toast. */}
      {hasDoc && doc && (
        <VersionHistoryPanel
          open={versionsOpen}
          workspaceId={workspaceId!}
          slug={slug!}
          onClose={() => setVersionsOpen(false)}
          onCompare={() => toast("Compare arrives with the diff view")}
          onRestore={() => toast("Restore arrives next")}
        />
      )}
    </div>
  );
}

// InlineComposerPopover (#3/#2, 2026-06-12): the comment composer rendered as a FLOATING card at the
// selection. It drops BELOW the selection (prefer:"below" via placePopover) and is DRAGGABLE by its
// quote-ref header (Plannotator card, Apache-2.0). Before any drag it tracks `anchor` (re-positioned
// on scroll/resize by useCompose); once dragged it uses the manual absolute position and STOPS
// auto-repositioning — a manual position wins. Centering (translateX(-50%)) only applies while
// undragged; a dragged card uses an absolute left.
// Outside-click + Escape dismiss reuses the same guard as the selection popover (the multi-click
// guard keeps a triple-click selection alive). A drag-start on the header stopsPropagation so the
// single mousedown that powers that guard never reads a drag as an outside click. The Composer inside
// is unchanged (quote, textarea, Send, guest fields), so all its behavior + data-testids hold.
function InlineComposerPopover({
  anchor,
  quote,
  pending,
  guest,
  onSend,
  onCancel,
}: {
  anchor: { top: number; left: number; centered: boolean };
  quote: string;
  pending?: boolean;
  guest?: boolean;
  onSend: (body: string, guestIdentity?: { guestName: string; guestEmail?: string }) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useDraggable();
  // Dismiss on an outside mousedown / Escape → cancel the compose (same as the selection popover).
  useDismissOnOutsideAndEscape(ref, onCancel);

  // Before any drag: follow the anchor (centered when placePopover says so). After a drag: pin to the
  // manual absolute position (no centering — left is the real left edge).
  const dragged = drag.dragged && drag.pos !== null;
  const top = dragged ? drag.pos!.top : anchor.top;
  const left = dragged ? drag.pos!.left : anchor.left;
  const centered = !dragged && anchor.centered;

  return (
    <div
      ref={ref}
      data-testid="inline-composer-popover"
      className="absolute z-40 w-[320px] max-w-[88vw]"
      style={{ top, left, transform: centered ? "translateX(-50%)" : undefined }}
    >
      <Composer
        quote={quote}
        pending={pending}
        guest={guest}
        onSend={onSend}
        onCancel={onCancel}
        dragging={drag.dragging}
        dragHandleProps={{
          "data-testid": "composer-drag-handle",
          onPointerDown: (e) => {
            // Grab from the card's CURRENT absolute top/left. While still centered, the visual left
            // is `anchor.left - width/2`; once we start dragging we drop centering and pin to that
            // resolved left so the card doesn't jump on the first move.
            const width = ref.current?.getBoundingClientRect().width ?? 320;
            const resolvedLeft = centered ? left - width / 2 : left;
            drag.onHandlePointerDown(e, { top, left: resolvedLeft });
          },
        }}
      />
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
  /** PERF: prepend a freshly-created real annotation into the cache (newest-first, deduped) so the
   *  rail re-renders without a refetch. Called from useCompose's create-success reconcile. */
  prependAnnotation: (real: ViewerAnnotation) => void;
  railProps: {
    annotations: ViewerAnnotation[];
    focusedId: string | null;
    unplaceableIds: Set<string>;
    onFocusThread: (id: string) => void;
    onReply?: (annotation: ViewerAnnotation, body: string) => Promise<boolean>;
    onResolve?: (annotation: ViewerAnnotation, resolved: boolean) => Promise<boolean>;
  };
} {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  // The cache key for this doc's annotation list (matches useApiQuery below). All post-write
  // reconciles patch THIS entry directly via setQueryData instead of refetching.
  const annoKey = ["viewer-annotations", workspaceId, slug] as const;

  const annoQuery = useApiQuery<ListAnnotationsResponse>(
    annoKey,
    () => listAnnotations(workspaceId ?? "", slug ?? ""),
    { enabled },
  );

  const annotations: ViewerAnnotation[] = annoQuery.data?.items ?? [];

  // PERF (create reconcile): prepend the real row into the cached list — newest-first, deduped by id
  // (a defensive guard so a double-fire can't list the same annotation twice). Only writes when ws +
  // slug are present (the enabled-gated query); the create-success path always has them.
  const prependAnnotation = useCallback(
    (real: ViewerAnnotation) => {
      if (!workspaceId || !slug) return;
      queryClient.setQueryData<ListAnnotationsResponse>(annoKey, (old) => {
        const items = old?.items ?? [];
        if (items.some((a) => a.id === real.id)) return old ?? { items };
        return { ...old, items: [real, ...items] };
      });
    },
    // annoKey is derived from workspaceId+slug; list them so the closure tracks the real deps.
    [queryClient, workspaceId, slug], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Which anchored annotations the FE could NOT place at runtime (GAP-005). BUG #1 (2026-06-12):
  // this used to be derived in a render-time useMemo that called placeAnnotations — a DOM side
  // effect DURING render. It's now reported from the post-commit useAnnotationMarks effect (the
  // single owner of mark placement), removing the double-place that could wipe existing highlights.
  const [unplaceableIds, setUnplaceableIds] = useState<Set<string>>(() => new Set());
  const reportUnplaceable = useCallback((ids: string[]) => {
    setUnplaceableIds((prev) => {
      // Avoid a state churn loop: only update when the set actually changed.
      if (prev.size === ids.length && ids.every((id) => prev.has(id))) return prev;
      return new Set(ids);
    });
  }, []);

  // Place marks + wire click-on-highlight → focus thread (AS-008) AND open the rail drawer (AS-014).
  useAnnotationMarks(
    docPaneEl,
    annotations,
    focusedId,
    (id) => {
      setFocusedId(id);
      onHighlightTap();
    },
    reportUnplaceable,
  );

  const focusThread = (id: string) => {
    setFocusedId(id);
    scrollToAnno(docPaneEl, id); // AS-009: scroll to + emphasise the highlight.
  };

  // S-003 (AS-006 / C-005): send a reply to an anchored thread. The reply is a comment whose
  // parentId is the annotation's FIRST/root comment — flat replies (the read side shapes every
  // reply as a sibling of the root, never nested, C-005). Identity rides the session cookie; the
  // body carries no userId (C-001). On success we APPEND the real reply flat into the cached thread
  // via setQueryData — no refetch, no network reload (mirrors S-001's create reconcile). On a
  // refused/failed write we return false (the card's onReply=false contract → no ghost reply, no
  // cache change) + toast the same error S-001 uses. Gated by canCompose (C-004): a viewer-only role
  // gets no reply affordance.
  const onReply =
    canCompose && workspaceId && slug
      ? async (annotation: ViewerAnnotation, body: string): Promise<boolean> => {
          const parentId = (annotation.comments ?? [])[0]?.id ?? null;
          try {
            const res = await addComment(workspaceId, slug, annotation.id, {
              body,
              ...(parentId ? { parentId } : {}),
            });
            if (res.error) {
              toast.error("Couldn't post your reply");
              return false;
            }
            // Reconcile (no refetch): append the real reply flat (parentId = the thread's root
            // comment id, C-005) to ITS annotation in the cache.
            const reply: ViewerAnnotation["comments"][number] = {
              id: peelCommentId(res.data),
              parentId,
              authorName: "You",
              body,
              createdAt: new Date().toISOString(),
            };
            queryClient.setQueryData<ListAnnotationsResponse>(annoKey, (old) => {
              if (!old) return old;
              return {
                ...old,
                items: old.items.map((a) =>
                  a.id === annotation.id ? { ...a, comments: [...a.comments, reply] } : a,
                ),
              };
            });
            return true;
          } catch {
            toast.error("Couldn't post your reply");
            return false;
          }
        }
      : undefined;

  // S-004 (AS-007/AS-008/C-006): resolve / reopen an anchored thread. Gated by canCompose (C-004):
  // a viewer-only role gets no Resolve control. NOT author-gated — the server authorizes purely on
  // the session role (AS-008). On the toggle we also dim the in-text highlight immediately by
  // flipping the matching mark's data-resolved flag (the spec's "highlight dims"). On success we
  // patch the annotation's status in the cache via setQueryData — no refetch, no network reload. On
  // a refused/failed write we revert the mark, return false (the card rolls its optimistic toggle
  // back), and toast the same error S-001/S-003 use.
  const dimMark = (annotationId: string, resolved: boolean) => {
    if (!docPaneEl) return;
    const mark = docPaneEl.querySelector<HTMLElement>(`[data-anno="${annotationId}"]`);
    if (mark) {
      if (resolved) mark.dataset.resolved = "true";
      else delete mark.dataset.resolved;
    }
  };
  const onResolve =
    canCompose && workspaceId && slug
      ? async (annotation: ViewerAnnotation, resolved: boolean): Promise<boolean> => {
          dimMark(annotation.id, resolved); // AS-007: highlight dims optimistically
          try {
            const res = await setResolution(workspaceId, annotation.id, { resolved });
            if (res.error) {
              dimMark(annotation.id, !resolved); // revert the highlight
              toast.error("Couldn't update this thread");
              return false;
            }
            // Reconcile (no refetch): patch the annotation's status in the cache.
            queryClient.setQueryData<ListAnnotationsResponse>(annoKey, (old) => {
              if (!old) return old;
              return {
                ...old,
                items: old.items.map((a) =>
                  a.id === annotation.id
                    ? { ...a, status: resolved ? "resolved" : "unresolved" }
                    : a,
                ),
              };
            });
            return true;
          } catch {
            dimMark(annotation.id, !resolved);
            toast.error("Couldn't update this thread");
            return false;
          }
        }
      : undefined;

  return {
    count: annotations.length,
    refetch: () => annoQuery.refetch(),
    prependAnnotation,
    railProps: { annotations, focusedId, unplaceableIds, onFocusThread: focusThread, onReply, onResolve },
  };
}
