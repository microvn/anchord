import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/api/auth-client";
import { useApiQuery } from "@/lib/api/use-api-query";
import { NoAccessView } from "./no-access-view";
import { useViewerLayoutMode } from "@/hooks/use-breakpoint";
import { usePageMeta } from "@/hooks/use-page-meta";
import { Icon } from "@/components/icon";
import { ErrorState } from "@/components/error-state";
import { Skeleton } from "@/components/skeleton";
import { DocPane } from "./doc-pane";
import type { HtmlSandboxFrameHandle } from "./html-sandbox-frame";
import { clampRectToViewport, isKnownAnnotationId, type BridgeAnchor, type BridgeRect } from "@/features/viewer/lib/bridge";
import { DocModeToolbar, MARKUP_TOOLS, INPUT_MODES, type MarkupTool, type InputMode } from "./doc-mode-toolbar";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { TocSidebar } from "./toc-sidebar";
import { AnnotationsRail } from "./annotations-rail";
import {
  type StatusFacet,
  type TypeFacet,
  type DecisionFacet,
  DEFAULT_STATUS,
  DEFAULT_TYPE,
  DEFAULT_DECISION,
  statusFacet,
  typeFacet,
  decisionFacet,
  isShown,
} from "@/features/viewer/lib/annotation-filter";
import { ViewerTopBar } from "./viewer-top-bar";
import { MetaStrip } from "./meta-strip";
import type { SpecMeta } from "@/features/viewer/types";
import { toast } from "sonner";
import { useAnnotationMarks, useBlockPick, scrollToAnno, type PlaceableAnnotation, type HoverPeekOptions, type PinOptions, type BlockPick } from "./annotation-marks";
import { useHoverPin } from "@/features/viewer/hooks/use-hover-pin";
import { AnnotationPeekCard } from "./annotation-peek-card";
import { PinnedCardPopover } from "./pinned-card-popover";
import { AnnotationBottomSheet } from "./annotation-bottom-sheet";
import { isRectOutOfViewport } from "@/features/viewer/lib/place-popover";
import { SelectionPopover } from "./selection-popover";
import { LabelPicker } from "./label-picker";
import { Composer } from "./composer";

// DESIGN.md type/tool palette — the marks use the SAME 4 basic tool hues as the toolbar (NOT a
// per-label rainbow, which reads chaotic): Markup = teal (the default, no override), Comment = amber,
// Redline = red (the strike), Label = gold (every label, incl. the Like "looks-good" preset). Comment
// amber is deliberately NOT the banned Claude-orange #d97757.
const COMMENT_HUE = "#d68a3e"; // amber
const LABEL_HUE = "#cbb24a"; // gold (all labels + like)
// HTML-PLACE: a stable empty placeable array — fed to the light-DOM placer for non-markdown docs so
// it never false-flags iframe-resident anchors "couldn't place" (a fresh `[]` each render would
// re-run the placer effect every commit; this identity-stable const keeps the single-place guarantee).
const EMPTY_PLACEABLE: PlaceableAnnotation[] = [];
import { useGuestIdentity } from "@/features/viewer/hooks/use-guest-identity";
import { GuestIdentityChip } from "./guest-identity-chip";
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
  decideSuggestion,
  deleteAnnotation,
  restoreAnnotation,
  dismissAnnotation,
  reattachAnnotation,
  canComment,
  type ViewerDocResponse,
  type ListAnnotationsResponse,
  type ViewerAnnotation,
} from "@/features/viewer/services/client";

// ViewerScreen (doc-access-routing S-003): the PUBLIC React route `/d/:slug` (outside AuthGuard).
// It fetches the doc via the slug-only `GET /api/docs/:slug` read (anon-capable), then renders it
// inside the 3-pane viewer shell. The TOC sidebar (S-002),
// the annotations rail (S-003), the top bar (S-005), and the responsive drawers (S-006) all mount
// into this shell.
//
// C-002 (existence-hiding): a 404 — a missing slug OR a doc this session can't access — renders a
// not-found / no-access state, NEVER an empty viewer or a "0 comments" shell that would leak the
// doc's existence. Not-found and no-access are deliberately the same surface.

// MƯỢT TASK 1/3: the iframe bridge sends a selection rect as {x,y,width,height}. HtmlSandboxFrame
// has already translated it from iframe-local to PAGE coords (it adds the iframe's own offset), so
// this is a pure shape conversion to the RectLike {top,bottom,left,right} placePopover wants.
function frameRectToViewport(rect: { x: number; y: number; width: number; height: number }): {
  top: number;
  bottom: number;
  left: number;
  right: number;
} {
  return { top: rect.y, bottom: rect.y + rect.height, left: rect.x, right: rect.x + rect.width };
}

// annotation-hover-card S-003 (C-008): build the HoverPeek shape the peek/pin state hooks consume
// (annoId + a DOMRect-LIKE rect) from a page-coord rect. useHoverPin only reads top/bottom/left/right
// (it feeds the rect to placePopover), so a RectLike satisfies it — cast to DOMRect for the type.
function frameRectToHoverPeek(annoId: string, rect: { x: number; y: number; width: number; height: number }): {
  annoId: string;
  rect: DOMRect;
} {
  return { annoId, rect: frameRectToViewport(rect) as unknown as DOMRect };
}

// annotation-hover-card S-003 / C-006 (AS-027): the live viewport for clamping a relayed rect.
function liveViewport(): { width: number; height: number } {
  return typeof window !== "undefined"
    ? { width: window.innerWidth, height: window.innerHeight }
    : { width: 1000, height: 800 };
}

export function ViewerScreen({
  slug: slugOverride,
  returnTo,
}: { slug?: string; returnTo?: string } = {}) {
  // doc-access-routing S-003: the viewer mounts on the PUBLIC route `/d/:slug` (outside AuthGuard)
  // and is addressed by slug alone (C-002) — there is no workspaceId param. The doc read goes to
  // `GET /api/docs/:slug` (anon-capable), and the cache is keyed off slug only.
  //
  // capability-share-link S-002 (C-009/AS-004): on the `/s/:token` capability route the slug is NOT
  // in the URL (the URL stays the token). The redeem step resolves the slug and passes it in via
  // `slugOverride`, so the viewer renders the doc by slug while the address bar keeps the token.
  const { slug: slugParam = "" } = useParams<{ slug: string }>();
  const slug = slugOverride ?? slugParam;
  const navigate = useNavigate();
  // AS-014/AS-015/AS-016: the session decides the NO-ACCESS variant + the anon top-bar chrome.
  // While the session resolves, `isPending` is true — we don't paint a misleading variant yet.
  const { data: session, isPending: sessionPending } = useSession();
  const signedIn = Boolean(session);
  // annotation-actions-ui S-001 (C-001): the current session user id — the viewer's existing
  // signed-in-user source. Threaded to each rail ThreadCard so it marks own-vs-others from the
  // durable `authorId` (null for an anon/guest → owns nothing). The server is the source of truth.
  const currentUserId = session?.user?.id ?? null;

  // C-004 (AS-014): tag the doc read `viewerRead` so the shared QueryCache onError can NEVER turn
  // a no-access reply into a global sign-out / sign-in redirect on the public viewer.
  const query = useApiQuery<ViewerDocResponse>(
    ["viewer-doc", slug],
    () => fetchViewerDoc(slug),
    // refetchOnWindowFocus: an agent can publish a new version out-of-band (MCP patch/update) with no
    // push channel — refetch when the reviewer returns to the tab so a newer version surfaces (the 30s
    // staleTime bounds how often this fires).
    { meta: { viewerRead: true }, refetchOnWindowFocus: true },
  );

  usePageMeta(query.data?.doc?.title);

  // AS-016: route to sign-in carrying a return-to-doc, so completing sign-in lands back on /d/:slug.
  // capability-share-link S-002 (C-009/GAP-004): on a capability (`/s/:token`) session, the return-to
  // is the TOKEN url, never `/d/:slug` — so signing in never leaks the readable slug into the address
  // bar. `returnTo` is supplied by the redeem screen; the default `/d/:slug` path is unchanged.
  const goSignIn = useCallback(() => {
    const dest = returnTo ?? `/d/${slug}`;
    navigate(`/signin?redirect=${encodeURIComponent(dest)}`);
  }, [navigate, slug, returnTo]);

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
    // doc-delete-trash S-004 (AS-014): a 410 DOC_DELETED means the doc existed but was deleted
    // AND this viewer had prior access (the backend gates that code on prior access; a viewer
    // with none gets the existence-hiding 404 below instead — AS-015). Show the "deleted" notice,
    // never the content. Like the no-access surface, this is meta.viewerRead-exempt so it never
    // bounces to sign-in.
    const docDeleted = query.error.status === 410 || query.error.code === "DOC_DELETED";
    if (docDeleted) {
      return (
        <div
          data-testid="viewer-deleted"
          className="flex h-dvh items-center justify-center bg-paper px-4 text-ink"
        >
          <NoAccessView variant="deleted" slug={slug} />
        </div>
      );
    }
    // C-002: a 404 (missing OR no-access) collapses to one not-found state — never the content,
    // never an empty render. Any other failure shows the retryable error surface.
    const notFound = query.error.status === 404 || query.error.code === "NOT_FOUND";
    if (notFound) {
      // S-003 (C-004): a no-access doc and a missing doc are the SAME existence-hiding 404. The
      // surface NEVER bounces to sign-in (the read is meta.viewerRead-exempt). The variant is
      // chosen by the session: signed-OUT → "sign in to view" (signing in MIGHT help, AS-014),
      // returning the visitor to /d/:slug after (AS-016); signed-IN → plain "you don't have
      // access" (AS-015). While the session is still resolving, default to the no-access message
      // (no premature sign-in prompt) — it flips to the signin prompt once we know there's no
      // session.
      const variant = !sessionPending && !signedIn ? "signin" : "no-access";
      // S-003: the no-access / not-found state is a CLEAN standalone page — NOT the 3-pane viewer
      // shell. Wrapping it in ViewerShell leaked the viewer chrome (a "Not found" top bar, the empty
      // annotations rail, the outline gutter), which both looked broken and hinted the doc exists.
      return (
        <div
          data-testid="viewer-not-found"
          className="flex h-dvh items-center justify-center bg-paper px-4 text-ink"
        >
          <NoAccessView variant={variant} slug={slug} onSignIn={goSignIn} />
        </div>
      );
    }
    return (
      <div className="flex h-dvh items-center justify-center bg-paper px-4 text-ink">
        <ErrorState
          message={query.error.message}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      </div>
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
      slug={slug}
      effectiveRole={doc.doc.effectiveRole}
      // S-003/AS-030: the doc's OWN workspace from the read response (null when project-less).
      // Feeds the member-only, workspace-addressed Share dialog + Version history; null/anon → hidden.
      workspaceId={doc.doc.workspaceId ?? null}
      canCompose={canComment(doc.doc.effectiveRole)}
      // S-005 / AS-016/AS-017 (sharing reversal 2026-06-20): a logged-out (anon) session whose
      // effective LINK ROLE is commenter+ is a guest commenter — the composer shows the
      // GuestNameField + name-required gate and the rail badges the guest comment (C-010). Derived
      // from the role the doc read already returns (NOT the never-emitted `doc.guest` flag — the
      // old keying was the live bug: a guest on anyone-with-link/commenter never got the composer).
      // There is no separate guest-commenting toggle; the link role IS the grant.
      guest={!signedIn && canComment(doc.doc.effectiveRole)}
      // S-003 (AS-029): an anonymous visitor → the top bar shows a Sign in CTA + hides session-only
      // chrome (Share / account menu). signedIn comes from the resolved session, not the doc.
      anonymous={!signedIn}
      // S-001 (C-001): the session user id for the rail's own-vs-others attribution.
      currentUserId={currentUserId}
      currentUserName={session?.user?.name ?? null}
      onSignIn={goSignIn}
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
  slug,
  effectiveRole,
  workspaceId = null,
  canCompose = false,
  guest = false,
  anonymous = false,
  currentUserId = null,
  currentUserName = null,
  onSignIn,
}: {
  title: string;
  /** present only on the success path — drives the S-005 ViewerTopBar identity. */
  doc?: {
    title: string;
    kind: ViewerDocResponse["doc"]["kind"];
    version: number;
    status: string;
    generalAccess: ViewerDocResponse["doc"]["generalAccess"];
  };
  /** the session's effective role on this doc — gates the Share affordance (S-001 / C-002). */
  effectiveRole?: ViewerDocResponse["doc"]["effectiveRole"];
  /** S-003/AS-030: the doc's OWN workspace from the read response (null when project-less, C-011).
   *  The doc-scoped viewer has no :workspaceId URL param, so the member-only, workspace-addressed
   *  Share dialog + Version history source it from here. Panels render only when this is non-null
   *  AND the session is a signed-in member (!anonymous); anon or null → panels hidden. */
  workspaceId?: string | null;
  /** the full doc read on the success path — rendered into the center pane (DocPane). Absent on
   *  the loading / not-found / error shells (no doc to render). */
  docResponse?: ViewerDocResponse;
  specMeta?: SpecMeta | null;
  /** the loading / not-found / error shells render their state here instead of a DocPane. */
  children?: React.ReactNode;
  slug?: string;
  /** S-003 (AS-029): an anonymous visitor → anon top-bar variant; no member-only chrome. */
  anonymous?: boolean;
  /** AS-029/AS-016: the anon top bar's Sign in CTA handler (routes to /signin with return-to). */
  onSignIn?: () => void;
  /** S-001/C-004: whether the session's effective role may comment. A viewer-only role gets a
   *  read-only rail — no popover, no composer. False on the loading / error shells (no doc). */
  canCompose?: boolean;
  /** S-005: this is a logged-out guest session → the composer shows the GuestNameField + gates
   *  Send on a name (C-007). Consumed from the read side; the FE doesn't own the sharing toggle. */
  guest?: boolean;
  /** annotation-actions-ui S-001 (C-001): the session user id, forwarded to the rail so each
   *  ThreadCard marks own-vs-others from the durable `authorId`. Null for an anon/guest. */
  currentUserId?: string | null;
  /** annotation-actions-ui S-001 (C-001): the session user's display name — used to attribute an
   *  optimistically-created annotation to the REAL author (real name + avatar shown instantly,
   *  authorId set) instead of the "You" placeholder. Null for an anon/guest. */
  currentUserName?: string | null;
}) {
  const { drawerMode, tocDrawer } = useViewerLayoutMode();
  const navigate = useNavigate();

  // S-007 (AS-016 / C-007): the session-stable guest identity — ONE random name for the whole
  // viewing session (sessionStorage-backed; survives reload + in-tab nav, NOT re-rolled per composer).
  // Shown as the top-bar GuestIdentityChip (next to Sign in) and ridden up on every guest comment.
  // The hook always runs (Rules of Hooks); its name is only SURFACED when this is a guest session.
  const guestIdentity = useGuestIdentity();

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
  const hasDoc = Boolean(slug);

  // annotation-create-version-pin S-001 (AS-005): the query client for the stale-create reload —
  // invalidates ["viewer-doc", slug] + ["viewer-annotations", slug] so a 409'd create surfaces the
  // current version + content.
  const composeQueryClient = useQueryClient();
  // S-001 (AS-001): the ShareDialog open-state, hosted here so the top bar's Share button opens it.
  const [shareOpen, setShareOpen] = useState(false);
  // versioning-diff-ui S-001 (AS-001): the VersionHistoryPanel open-state, hosted here so the top
  // bar's version button opens it (replacing the old placeholder toast). doc.version is the current
  // version (the "Current" marker / later the default Compare target).
  const [versionsOpen, setVersionsOpen] = useState(false);
  // S-004 (AS-012/AS-013): the LabelPicker open-state. Picking Label in the selection popover opens
  // the picker AT the popover's anchor (the selection is still pending in useCompose). Choosing a
  // preset runs compose.startLabel (the labeled-create path). Null → no picker.
  const [labelPickerAt, setLabelPickerAt] = useState<{ top: number; left: number; centered?: boolean } | null>(null);
  // S-006 (C-009): the active markup tool. Default Markup → preserves S-001 (Markup + select → the
  // 5-type popover). The ACTIVE tool routes a text selection (the effect below): Markup → the popover,
  // Comment → the composer directly, Redline → a red strike directly, Label → the picker directly.
  // Persisted (localStorage) so the chosen tool survives an F5 instead of snapping back to Markup.
  const [activeTool, setActiveTool] = usePersistentState<MarkupTool>(
    "anchord-viewer-markup-tool",
    "markup",
    MARKUP_TOOLS,
  );
  // pinpoint S-001 (C-001): the input mode — OWNED here, lifted above useCompose. "select" (default)
  // = drag-select text → range annotation; "pinpoint" = hover-outline a block + click → whole-block
  // annotation (block-pick is S-002). Threaded into useCompose so the text-selection→create popover
  // path is INERT in Pinpoint (AS-002); the toolbar's Select|Pinpoint chips reflect + toggle it.
  // Persisted (localStorage) so the mode survives an F5.
  const [inputMode, setInputMode] = usePersistentState<InputMode>(
    "anchord-viewer-input-mode",
    "select",
    INPUT_MODES,
  );
  // C-002 (Share affordance gate): only a potential manager (owner, or editor — the editor's
  // editorsCanShare is re-checked after the dialog reads the share state) is shown the Share button.
  // A viewer/commenter — or an absent role (conservative) — never gets a Share affordance that opens
  // the editable dialog (AS-003). canManageShare(role, true) treats owner→true, editor→true (the
  // toggle is verified post-open), viewer/commenter/absent→false.
  const canShare = canManageShare(effectiveRole, true);

  // S-003/AS-030: the member-only, workspace-addressed panels (Share dialog + Version history,
  // kept workspace-addressed per C-007) need a workspaceId. The doc-scoped viewer has no
  // :workspaceId URL param, so it comes from the read response. Show them ONLY when the session
  // is a signed-in member (!anonymous, complements AS-029) AND the response carries a non-null
  // workspaceId (a project-less doc has no workspace → null → panels hidden, C-011). This
  // replaces the S-003 interim stub (workspaceId="").
  const memberWorkspaceId = !anonymous && workspaceId ? workspaceId : null;

  // S-001: the hover-peek state (peeked id + placement). useAnnotationMarks owns the DOM dwell
  // detection on the doc pane; this hook holds the React state the shell renders the peek card from.
  const hoverPin = useHoverPin();
  // The hover options handed to useAnnotationMarks: C-001 suppression is SELECTION-based, NOT
  // tool-based — `isSelectionActive` (omitted here) defaults to the live `window.getSelection()`
  // collapsed/empty read inside the delegated listener, so the peek shows for ANY active tool (the
  // viewer always has one; Markup is the resting default) and is suppressed only while the user is
  // mid-selection. The onHoverPeek sink feeds the peek state. Markdown-only here (the HTML iframe
  // peek is S-003); a drawer-mode/touch device is the bottom-sheet path (S-004), so hover idles there.
  const hoverPeek: HoverPeekOptions = useMemo(
    () => ({ onHoverPeek: hoverPin.onHoverPeek }),
    [hoverPin.onHoverPeek],
  );
  // S-002: the click-to-PIN option handed to useAnnotationMarks. C-001 suppression is SELECTION-based
  // (same as the peek — `isSelectionActive` omitted → the live window-selection read), so a marker
  // click pins for ANY active tool and is suppressed only mid-selection (AS-013). onPinMark sets the
  // pin state (toggling the same id closed, replacing a different one — C-002/AS-011/AS-012). The
  // focus side (C-004) is set by useAnnotations' click→onFocusAnno path; this only owns the pin.
  // Markdown-only here (the HTML iframe pin is S-003); a drawer-mode/touch device opens the bottom
  // sheet instead (S-004), so the pin idles there (the wrapper below is gated on !drawerMode).
  const pinMark = hoverPin.pinMark;
  const pinOptions = useMemo(
    () => ({ onPinMark: (peek: { annoId: string; rect: DOMRect }) => void pinMark(peek) }),
    [pinMark],
  );

  // S-003/S-006: the annotations are read here (lifted above the rail) so the CommentFab can show
  // the count and the highlight-tap can open the rail drawer, while the rail still renders them.
  //
  // annotation-hover-card S-004 (AS-018): in drawer mode the marker tap is RE-ROUTED — it now drives
  // the pin state (pinMark, shared with the desktop pin) so the bottom sheet opens for THAT thread,
  // instead of opening the rail drawer. So we (a) pass `pinOptions` in BOTH modes (the marker tap pins
  // → sets pinnedId → the sheet renders in drawer mode / the popover on desktop), and (b) stop the
  // marker-tap `onHighlightTap` from opening the rail drawer (the sheet is the destination now). The
  // rail drawer + CommentFab stay reachable by their own controls (the FAB, the top bar's comments
  // toggle, and the compose-success path's setRailOpen) — Not in Scope to retire them.
  const anno = useAnnotations(slug, docPaneEl, hasDoc, canCompose, memberWorkspaceId, effectiveRole, doc?.kind === "markdown", () => {
    // S-004: the marker tap no longer opens the rail drawer in drawer mode — it opens the per-thread
    // bottom sheet (driven by pinMark below). The rail drawer is still opened by its own controls.
  }, guest ? guestIdentity.name : null, guest ? null : currentUserName, hoverPeek, pinOptions);

  // S-001: the peeked annotation resolved from the loaded set (a peek can only render data we have).
  const peekAnnotation =
    hoverPin.peekId != null
      ? anno.railProps.annotations.find((a) => a.id === hoverPin.peekId) ?? null
      : null;

  // S-002: the pinned annotation resolved from the loaded set. C-004 contract (d): the pin
  // auto-closes when `pinnedId` no longer resolves to an annotation in the loaded list (deleted,
  // dismissed, orphaned-out, refetch-dropped, redline-rejected → its mark removed). An orphaned
  // (detached) annotation has no in-doc mark, so it can't host an anchored pin either → treat as gone.
  const pinnedAnnotation =
    hoverPin.pinnedId != null
      ? anno.railProps.annotations.find((a) => a.id === hoverPin.pinnedId && !a.isOrphaned) ?? null
      : null;
  const closePin = hoverPin.closePin;
  useEffect(() => {
    // AS-026 (delete) / AS-023-adjacent / refetch reconcile: the pin is open but its annotation is no
    // longer in the loaded, anchored set → close it so the card never lingers over a removed mark.
    if (hoverPin.pinnedId != null && pinnedAnnotation == null) closePin();
  }, [hoverPin.pinnedId, pinnedAnnotation, closePin]);

  // ── annotation-hover-card S-003: HTML-doc peek + pin (C-006 untrusted-relay enforcement) ──────────
  //
  // The peek/pin cards render in the PARENT (the same AnnotationPeekCard / PinnedCardPopover the
  // markdown path uses) from the already-loaded ViewerAnnotation — NEVER from the relayed message
  // (C-003/AS-017). The in-iframe bridge relays only an id + a rect; the parent:
  //   1. looks the id up in the loaded, role-filtered set — a miss is a NO-OP (no card; AS-027/C-006),
  //   2. clamps the (already page-translated) rect to the viewport, rejecting a bad/oversized one
  //      (AS-027/C-006) — a rejected rect opens nothing,
  //   3. drives the SAME peek/pin state (onHoverPeek / pinMark) S-001/S-002 built (AS-015/AS-016).
  // The dwell timer lives here (the parent owns it; the bridge only sends discrete enter/leave). Live
  // cross-iframe positioning is [→MANUAL]/Playwright; the validate/route/clamp path is unit-tested.
  const loadedIds = useMemo(
    () => new Set(anno.railProps.annotations.map((a) => a.id)),
    [anno.railProps.annotations],
  );
  const onHoverPeek = hoverPin.onHoverPeek;
  const pinMarkFn = hoverPin.pinMark;
  const setFocusedThread = anno.railProps.onFocusThread;
  const htmlDwellRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearHtmlDwell = useCallback(() => {
    if (htmlDwellRef.current != null) {
      clearTimeout(htmlDwellRef.current);
      htmlDwellRef.current = null;
    }
  }, []);
  useEffect(() => clearHtmlDwell, [clearHtmlDwell]);

  // AS-015: hover ENTER on an in-iframe mark → after the dwell, show the peek (validated id + clamped
  // rect). A forged/unknown id or a bad rect resolves to no peek (C-006).
  const onHtmlMarkEnter = useCallback(
    (id: string, rect: BridgeRect | null) => {
      clearHtmlDwell();
      if (!isKnownAnnotationId(id, loadedIds)) return; // C-006/AS-027: unknown id → no-op.
      const clamped = rect ? clampRectToViewport(rect, liveViewport()) : null;
      if (!clamped) return; // C-006/AS-027: missing/rejected rect → no card.
      htmlDwellRef.current = setTimeout(() => {
        htmlDwellRef.current = null;
        onHoverPeek(frameRectToHoverPeek(id, clamped));
      }, 200);
    },
    [clearHtmlDwell, loadedIds, onHoverPeek],
  );
  // AS-015: hover LEAVE (not to a same-id sibling — the bridge already coalesced) → cancel dwell + hide.
  const onHtmlMarkLeave = useCallback(() => {
    clearHtmlDwell();
    onHoverPeek(null);
  }, [clearHtmlDwell, onHoverPeek]);

  // AS-016: CLICK an in-iframe mark → pin the full thread card at the (translated, clamped) rect AND
  // focus the rail thread (C-004: pin + focus). Unknown id / bad rect → no-op (C-006/AS-027). A click
  // also cancels any pending peek dwell so the peek never races the pin.
  const onHtmlMarkClick = useCallback(
    (id: string, rect: BridgeRect | null) => {
      clearHtmlDwell();
      onHoverPeek(null);
      if (!isKnownAnnotationId(id, loadedIds)) return; // C-006/AS-027: unknown id → no-op.
      const clamped = rect ? clampRectToViewport(rect, liveViewport()) : null;
      if (!clamped) return; // C-006/AS-027: missing/rejected rect → no pin.
      const pinned = pinMarkFn(frameRectToHoverPeek(id, clamped));
      // pinMark returns the id that ended up pinned (null when the same-marker click toggled it
      // closed). Sync the rail focus to match (C-004): focus on pin, leave on toggle-close.
      if (pinned != null) setFocusedThread(pinned);
    },
    [clearHtmlDwell, onHoverPeek, loadedIds, pinMarkFn, setFocusedThread],
  );

  // AS-021: the in-iframe scroll re-posted the pinned mark's rect → reposition the pin, or auto-close
  // when the mark scrolled out of view / vanished (the parent can't see the iframe's own scroll).
  const repositionPinFn = hoverPin.repositionPin;
  const onHtmlMarkRect = useCallback(
    (id: string, rect: BridgeRect | null) => {
      if (hoverPin.pinnedId == null || id !== hoverPin.pinnedId) return; // only the pinned mark matters.
      const clamped = rect ? clampRectToViewport(rect, liveViewport()) : null;
      if (!clamped) {
        closePin(); // mark gone / scrolled fully out → don't linger.
        return;
      }
      repositionPinFn(frameRectToViewport(clamped));
    },
    [hoverPin.pinnedId, repositionPinFn, closePin],
  );

  // S-002: a handle to the HTML sandbox frame so a created annotation's highlight can be relayed
  // DOWN to the in-iframe bridge (the parent can't draw a <mark> into the opaque iframe).
  const htmlFrameRef = useRef<HtmlSandboxFrameHandle>(null);
  const isHtml = doc?.kind === "html";
  // C-006: the outline exists ONLY for a Markdown doc (its headings are derivable in the app-origin
  // render). An HTML doc lives in a cross-origin sandbox and an image has no headings (GAP-004), so
  // both render 2-pane (content + rail) with no outline pane and no outline-toggle.
  const isMarkdown = doc?.kind === "markdown";

  // S-004/AS-012 (C-005): focusing a thread must emphasise + scroll the iframe to its highlight. For
  // a markdown doc focusThread does this via scrollToAnno on the light DOM; for an HTML doc the marks
  // live inside the opaque iframe (scrollToAnno can't reach them — docPaneEl holds only the <iframe>),
  // so we post focus DOWN the port and the in-iframe bridge toggles .anno-mark--focus + scrollIntoView.
  // Keyed on the focused id so a rail-card focus OR a relayed mark-click (both set focusedId) drives it.
  const htmlFocusedId = anno.railProps.focusedId;
  useEffect(() => {
    if (!isHtml) return;
    htmlFrameRef.current?.postFocus(htmlFocusedId);
  }, [isHtml, htmlFocusedId]);

  // notifications-email S-007 (C-013 / AS-024): the email deep-link is
  // `{APP_URL}/d/{slug}#annotation-{id}` — landing here with that fragment must scroll to +
  // highlight the target annotation, reusing the SAME in-app focus path a rail click takes
  // (onFocusThread → setFocusedId + scrollToAnno). With no fragment, the viewer opens normally
  // and nothing is focused. We fire ONCE per doc mount (a ref guard), waiting until the doc +
  // the target mark have rendered so scrollToAnno actually finds it; `anno.count` re-runs the
  // effect as the annotation list loads/places, and the guard prevents stealing focus afterward.
  const deepLinkHandledRef = useRef(false);
  const onFocusThread = anno.railProps.onFocusThread;
  useEffect(() => {
    if (!hasDoc || deepLinkHandledRef.current) return;
    const hash = typeof window !== "undefined" ? window.location.hash : "";
    const match = /^#annotation-(.+)$/.exec(hash);
    if (!match) {
      // AS-024 (no fragment): nothing to focus — mark handled so a later annotation load
      // (e.g. a refetch) doesn't retroactively grab focus the user never asked for.
      deepLinkHandledRef.current = true;
      return;
    }
    const targetId = decodeURIComponent(match[1]!);
    // For markdown the mark lives in the light DOM (docPaneEl); wait until it's placed. For an
    // HTML doc the focus is relayed down the iframe bridge (the htmlFocusedId effect above), so
    // onFocusThread alone (which sets focusedId) suffices. Only finalize once we can act.
    const markReady = isHtml || (docPaneEl?.querySelector(`[data-anno="${targetId}"]`) ?? null) != null;
    if (!markReady) return; // try again on the next annotation placement (count change)
    deepLinkHandledRef.current = true;
    onFocusThread(targetId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasDoc, isHtml, docPaneEl, anno.count, onFocusThread]);

  // S-001 (commenting write path): capture a text selection on the doc → popover → composer → send.
  // Gated by `canCompose` (C-004): a viewer-only role never sees a popover/composer (read-only rail).
  // S-002: on a successful create for an HTML doc, relay the highlight to the iframe bridge.
  const compose = useCompose(
    slug,
    docPaneEl,
    canCompose,
    // S-002: the redline create + decide are workspace-scoped (no doc-addressed suggestion route), so
    // the slug-only viewer sources the workspaceId from the doc read (member-only). `version` pins the
    // redline's stale check. Null workspaceId (anon / project-less doc) → startRedline no-ops.
    doc ? { workspaceId: memberWorkspaceId, version: doc.version } : null,
    (real) => {
      // PERF: reconcile the create WITHOUT a refetch — prepend the real server row into the
      // react-query cache (newest-first, deduped). The rail re-renders with no network reload.
      anno.prependAnnotation(real);
      // In drawer mode (tablet/mobile) do NOT auto-open the rail drawer after a create — the overlay
      // covers the whole screen right after the user annotates, which reads as the panel "popping out"
      // and blocking the doc. The new thread is still reachable via the CommentFab (its count updates)
      // and the per-thread bottom sheet on tap. The inline rail (desktop) already shows it with no overlay.
    },
    (anchor, annotationId) => {
      // C-001: this fires only AFTER the server-authorized create succeeded — the highlight is a
      // consequence of the real annotation, never of the untrusted selection hint itself.
      if (isHtml) htmlFrameRef.current?.postHighlight(anchor, annotationId);
    },
    // C-001: attribute an optimistic/reconciled create to the REAL signed-in author (real name +
    // avatar + authorId) instead of the "You" placeholder. Null id/name for an anon/guest → the
    // guest self-name path (or the "You" fallback) still applies.
    currentUserId && currentUserName ? { id: currentUserId, name: currentUserName } : null,
    // annotation-actions S-006: owner/editor can edit the doc → their own redline is born ACCEPTED
    // (optimistic + reconciled), mirroring the backend auto-accept; commenter's stays pending.
    effectiveRole === "owner" || effectiveRole === "editor",
    // annotation-create-version-pin S-001 (AS-005): on a STALE create refusal (the doc advanced past
    // the rendered version) reload the doc + annotations so the current version + content show, and
    // surface a message. useCompose itself KEEPS the user's draft (re-opens the composer) — the
    // annotation is never silently lost.
    () => {
      void composeQueryClient.invalidateQueries({ queryKey: ["viewer-doc", slug] });
      void composeQueryClient.invalidateQueries({ queryKey: ["viewer-annotations", slug] });
      toast("The document changed — reloaded; please re-select and try again");
    },
    // S-007 (AS-017): the session guest name for a guest session, so startRedline (which bypasses the
    // composer) attaches it to the create. Null for a signed-in member.
    guest ? guestIdentity.name : null,
    // pinpoint S-001 (AS-002 / C-001): the active input mode. In Pinpoint a text drag-selection is
    // inert — useCompose suppresses the create popover; only a block click creates (S-002).
    inputMode,
  );

  // pinpoint S-002 (AS-003/AS-004/AS-005/C-001): block-pick targeting — ACTIVE only in Pinpoint mode
  // on a markdown doc for a comment-capable role (C-004). Hovering a block outlines it; clicking it
  // synthesizes a whole-block anchor + the block's own rect and opens the SAME 5-type popover the
  // text path uses (compose.beginBlockCompose stashes the block anchor + raises the popover). A block
  // click is NOT a text selection, so it bypasses the selection→commit path (inert in Pinpoint,
  // S-001). The HTML-iframe block pick is S-004 (relayed over the bridge), so this is markdown-only.
  // An empty block never outlines and its click is a no-op (AS-006b, in resolvePickableBlock).
  const onBlockPick = useCallback(
    (pick: BlockPick) => {
      compose.beginBlockCompose(pick.blockId, pick.element, {
        top: pick.rect.top,
        bottom: pick.rect.bottom,
        left: pick.rect.left,
        right: pick.rect.right,
      });
    },
    // compose.beginBlockCompose is a stable callback (deps: canCompose, positionFor).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [compose.beginBlockCompose],
  );
  const { clearHoverOutline: clearBlockOutline } = useBlockPick(
    docPaneEl,
    inputMode === "pinpoint" && canCompose && isMarkdown,
    onBlockPick,
  );
  // AS-004 / S-002 files note: dismissing the synthesized popover must clear the block's outline
  // state. The 5-type popover's onDismiss already calls compose.dismissPopover; we wrap it so the
  // picked block stops being outlined too (the create paths that consume the pick — Comment/Like/
  // Redline/Label — keep their own surfaces, and the outline is cleared when the popover closes).
  const dismissBlockPopover = useCallback(() => {
    compose.dismissPopover();
    clearBlockOutline();
  }, [compose, clearBlockOutline]);

  // pinpoint S-004/AS-010 (C-001/C-002/C-005): a Pinpoint block-pick relayed from the HTML sandbox
  // iframe. The parent can't read the opaque iframe DOM, so the in-iframe bridge relays the picked
  // block's id + its full text (UNTRUSTED, Zod-validated at the boundary — C-005) + the page-translated
  // rect. Route it into the SAME beginBlockCompose the markdown pick uses (it synthesizes the 5-type
  // popover + a whole-block anchor from {textContent}), so the create is identical to markdown. An
  // unresolvable/forged blockId is stored verbatim and the matcher orphans it (AS-011) — the parent
  // does not (cannot) pre-check it against the cross-origin iframe. canCompose-gated inside
  // beginBlockCompose (C-001 commenter+, re-authorized server-side).
  const onHtmlBlockPick = useCallback(
    (blockId: string, rect: { x: number; y: number; width: number; height: number } | null, text: string) => {
      compose.beginBlockCompose(blockId, { textContent: text }, rect ? frameRectToViewport(rect) : null);
    },
    // compose.beginBlockCompose is a stable callback (deps: canCompose, positionFor).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [compose.beginBlockCompose],
  );

  // S-006 (C-009 / AS-020..023): the ACTIVE tool routes a text selection. useCompose raises
  // `compose.popover` on every valid selection (block-scoped, comment-capable — C-001/C-008); the
  // active tool then decides what that selection DOES:
  //   • Markup (default)  → leave the popover up → the 5-type popover (AS-020, the S-001 surface).
  //   • Comment           → open the comment composer directly (no 5-type popover). (AS-021)
  //   • Redline           → strike the selection directly (the existing startRedline). (AS-022)
  //   • Label             → open the LabelPicker directly at the selection. (AS-023)
  // Re-pointing the existing create paths by tool — it does NOT rebuild any create path (S-002/3/4).
  // Guarded so it fires once per fresh popover (depends on the popover identity + the active tool);
  // a viewer-only role never raises a popover (C-001) so this never runs read-only.
  useEffect(() => {
    if (!compose.popover) return;
    if (activeTool === "markup") return; // Markup → keep the 5-type popover (S-001/AS-020).
    if (activeTool === "comment") {
      compose.startComment(); // AS-021: composer directly, no popover.
    } else if (activeTool === "redline") {
      compose.startRedline(); // AS-022: red strike directly, no popover.
    } else if (activeTool === "label") {
      setLabelPickerAt(compose.popover); // AS-023: the label picker directly, no popover.
    }
    // compose handlers are stable callbacks; key the effect on the popover identity + the tool so a
    // new selection (a new popover object) re-routes, but a re-render with the same popover doesn't.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compose.popover, activeTool]);

  // S-004 (AS-017): when a detached card is armed for re-attach (reattachPendingId set), arm the
  // compose selection intercept so the NEXT text selection's anchor routes to reattachWith (instead
  // of opening the create composer) — reusing the SAME selection→anchor path the create flow uses.
  // Disarm when nothing is pending. The captured annotation is looked up from the current set so the
  // patch carries the right id; reattachWith clears the pending id (success or failure).
  const reattachPendingId = anno.railProps.reattachPendingId;
  useEffect(() => {
    if (!reattachPendingId) {
      compose.armSelectionIntercept(null);
      return;
    }
    compose.armSelectionIntercept((anchor) => {
      const target = anno.railProps.annotations.find((a) => a.id === reattachPendingId);
      if (target) void anno.reattachWith(target, anchor);
    });
    return () => compose.armSelectionIntercept(null);
    // compose.armSelectionIntercept is a stable callback; anno.reattachWith is stable per ws/slug. Key
    // on the pending id so re-arming only happens when the armed annotation changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reattachPendingId]);

  const toggleRail = () => (drawerMode ? setRailOpen((o) => !o) : setRailVisible((v) => !v));
  // The outline-toggle: in tocDrawer mode it opens/closes the TOC overlay drawer; on desktop it
  // collapses/expands the inline outline column (AS-018). Markdown-only (the button isn't shown
  // for html/image — C-006).
  const toggleToc = () => (tocDrawer ? setTocOpen((o) => !o) : setTocVisible((v) => !v));
  // AS-018: the in-pane collapse chevron (beside the outline search) — one-way hide. Desktop hides
  // the inline column; drawer mode closes the overlay. The top-bar outline-toggle re-expands.
  const collapseToc = () => (tocDrawer ? setTocOpen(false) : setTocVisible(false));

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
        // S-007 (AS-017): the session name rides up on send; the composer shows no name field.
        guestName={guest ? guestIdentity.name : undefined}
        // S-003 (C-003): a Like opens the composer pre-filled "Looks good" (editable); a plain
        // Comment opens empty. The pre-fill is carried from useCompose's startLike.
        initialBody={compose.composeInitialBody}
        onSend={compose.send}
        onCancel={compose.cancel}
      />
    ) : null;

  // S-002 (AS-023 / C-002): focusing a DIFFERENT thread via the rail closes an open pin — the pin must
  // not linger on A while the rail shows B (at most one active surface). Focusing the pinned thread's
  // OWN rail card leaves the pin open. Wrap the rail's focus so the rail behaviour (focusedId + scroll)
  // is unchanged; we only add the pin close on a cross-thread focus.
  const railFocusThread = anno.railProps.onFocusThread;
  const pinnedId = hoverPin.pinnedId;
  const onRailFocusThread = useCallback(
    (id: string) => {
      if (pinnedId != null && id !== pinnedId) closePin();
      railFocusThread(id);
    },
    [pinnedId, closePin, railFocusThread],
  );

  // S-002 (AS-021 / GAP-001): a throttled doc-pane scroll/resize listener re-reads the pinned mark's
  // rect; when it scrolls out of the viewport the pin auto-closes (isRectOutOfViewport), else it
  // repositions to follow the mark. Markdown-only (the in-iframe scroll relay is S-003); throttled
  // via rAF so cost doesn't scale with scroll frequency (SC-002 spirit). happy-dom has no layout, so
  // this is exercised by driving the handler with a synthetic rect in the unit test.
  const repositionPin = hoverPin.repositionPin;
  useEffect(() => {
    // Markdown-only: an HTML doc's marks live inside the opaque iframe (not the light docPaneEl), so a
    // light-DOM querySelector would always miss → spuriously closePin on the first scroll. The HTML
    // pin auto-close/reposition is driven by the in-iframe `mark-rect` relay instead (onHtmlMarkRect).
    if (!isMarkdown || pinnedId == null || !docPaneEl) return;
    let raf = 0;
    const check = () => {
      raf = 0;
      const mark = docPaneEl.querySelector<HTMLElement>(`[data-anno="${pinnedId}"]`);
      if (!mark) {
        closePin(); // the mark vanished (e.g. content re-rendered) — don't linger.
        return;
      }
      const rect = mark.getBoundingClientRect();
      const vp = { width: window.innerWidth, height: window.innerHeight };
      if (isRectOutOfViewport(rect, vp)) closePin();
      else repositionPin(rect);
    };
    const onScrollOrResize = () => {
      if (raf) return;
      raf = requestAnimationFrame(check);
    };
    docPaneEl.addEventListener("scroll", onScrollOrResize, { passive: true });
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      docPaneEl.removeEventListener("scroll", onScrollOrResize);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [isMarkdown, pinnedId, docPaneEl, closePin, repositionPin]);

  // Optimistic threads (created locally, not yet reconciled by a refetch) lead the rail so the
  // newest comment tops the list (AS-001) and the count includes them (AS-001.T4 / C-011).
  const railAnnotations = [...compose.optimistic, ...anno.railProps.annotations];
  const railContent = hasDoc ? (
    <AnnotationsRail
      {...anno.railProps}
      // S-002 (AS-023): the pin-aware focus wrapper — focusing another thread closes the pin.
      onFocusThread={onRailFocusThread}
      annotations={railAnnotations}
      // S-001 (C-001): each card marks own-vs-others from authorId vs the session user id.
      currentUserId={currentUserId}
      // C-001: the real author name for an optimistic reply (never "You") — guest rides guestName.
      currentAuthorName={guest ? guestIdentity.name : currentUserName}
      currentAuthorIsGuest={guest}
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
          onToggleToc={toggleToc}
          // C-006: the outline-toggle is shown only for Markdown — on desktop it collapses the
          // inline outline (AS-018), in drawer mode it opens the TOC drawer. html/image: no toggle.
          showTocToggle={isMarkdown}
          // S-003: the public viewer carries no workspace to return to. A signed-in member goes
          // home (/); an anon has no app home → no Back button (the Sign in CTA leads instead).
          onBack={!anonymous ? () => navigate("/") : undefined}
          onVersion={() => setVersionsOpen(true)}
          onShare={() => setShareOpen(true)}
          // AS-030: the Share button shows only when the dialog can actually mount — a signed-in
          // member (canShare gates owner/editor) AND a non-null response workspaceId (the panel is
          // workspace-addressed, C-007). A project-less doc (null workspaceId) → no Share button.
          showShare={canShare && Boolean(memberWorkspaceId)}
          // The overflow menu's Download annotations (S-004) serializes the same threads the rail shows.
          annotations={railAnnotations}
          // S-005: the slug addresses the raw Download document endpoint (GET /api/docs/:slug/download).
          slug={slug}
          anonymous={anonymous}
          onSignIn={onSignIn}
          // S-007 (AS-016): a guest's session identity chip — session name + Rename, shown next to
          // the Sign in CTA. Only for a guest (anon + can-comment); a member/viewer-anon gets none.
          guestIdentity={guest ? { name: guestIdentity.name, onRename: guestIdentity.rename } : undefined}
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
            <TocSidebar
              contentEl={docPaneEl}
              activeId={activeSection}
              onActiveChange={setActiveSection}
              onCollapse={collapseToc}
            />
          </aside>
        )}
        <main
          ref={setDocPaneEl}
          data-testid="viewer-doc-pane"
          data-doc-width={docWidth}
          // C-006: an HTML doc renders full-bleed + full-height — the pane is a flex column so the
          // sandbox frame (flex-1) fills the available height with no scroll gutter. Markdown/image
          // keep the natural scrolling pane.
          className={isHtml ? "flex min-w-0 flex-col overflow-hidden" : "min-w-0 overflow-auto"}
        >
          {doc && (
            <DocModeToolbar
              width={docWidth}
              onWidth={setDocWidth}
              // Wide/Focus is the markdown column measure (.doc-prose max-width); an HTML/image doc
              // renders in its own sandbox frame, so the toggle is meaningless there — hide it.
              showWidth={isMarkdown}
              // pinpoint S-001 (C-001): the Select|Pinpoint chips reflect + toggle the live input
              // mode. Switching mode drops any in-flight selection popover so the new mode applies to
              // the NEXT interaction only (no stale create popover lingering under Pinpoint).
              inputMode={inputMode}
              onModeChange={(m) => {
                setInputMode(m);
                compose.dismissPopover();
              }}
              // S-006/C-009: the markup tool palette — the active tool routes the selection (effect above).
              activeTool={activeTool}
              onTool={(t) => {
                setActiveTool(t);
                // Switching tool mid-selection clears any in-flight popover/picker so the new tool's
                // routing only applies to the NEXT selection (no stale 5-type popover under a non-Markup
                // tool). The pending selection is dropped along with the popover.
                setLabelPickerAt(null);
                compose.dismissPopover();
              }}
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
              // HTML-PLACE: draw EVERY existing annotation inside the iframe via the bridge (the only
              // path for an opaque iframe). Role-independent — a read-only viewer must see highlights
              // too (commenting stays gated by onSelection above). A placement miss → reportUnplaceableHtml.
              htmlAnnotations={isHtml ? anno.htmlPlaceable : undefined}
              onHtmlPlaceFailed={isHtml ? anno.reportUnplaceableHtml : undefined}
              // annotation-hover-card S-003/AS-016 (C-005/C-006): a highlight click inside the iframe.
              // On a POINTER device (desktop) it PINS the full thread card at the clicked mark + focuses
              // the rail thread (onHtmlMarkClick: id-validate + clamp + pin, then focus). In drawer mode
              // (touch) there is no pin yet (S-004's bottom sheet), so keep the existing focus + open
              // the rail drawer. The focus-sync effect posts focus back DOWN the port to emphasise the
              // clicked mark in either case.
              onHtmlMarkClick={
                isHtml
                  ? drawerMode
                    ? (id) => {
                        anno.railProps.onFocusThread(id);
                        setRailOpen(true);
                      }
                    : onHtmlMarkClick
                  : undefined
              }
              // S-003/AS-015 (peek): hover enter/leave on an in-iframe mark → the parent dwell + peek
              // (pointer device only; touch has no hover). C-006-validated inside the handlers.
              onHtmlMarkEnter={isHtml && !drawerMode ? onHtmlMarkEnter : undefined}
              onHtmlMarkLeave={isHtml && !drawerMode ? onHtmlMarkLeave : undefined}
              // S-003/AS-021: the in-iframe scroll re-posted the pinned mark's rect → reposition /
              // auto-close (the parent can't see the iframe scroll; markdown uses a doc-pane listener).
              onHtmlMarkRect={isHtml && !drawerMode ? onHtmlMarkRect : undefined}
              // pinpoint S-004/AS-010 (C-001): Pinpoint mode on an HTML doc for a comment-capable role
              // → enable the in-iframe block-pick + route a relayed pick into the SAME block create the
              // markdown pick uses. Gated on canCompose so a viewer-only role never picks (C-004); the
              // create is re-authorized server-side regardless (C-001).
              htmlPinpoint={isHtml && canCompose && inputMode === "pinpoint"}
              onHtmlBlockPick={isHtml && canCompose ? onHtmlBlockPick : undefined}
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
              onCollapse={collapseToc}
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
          <Icon name="highlight" size={16} />
          {anno.count + compose.optimistic.length}
        </button>
      )}

      {/* S-001: the selection popover — floats over a live selection, offering Comment. Only ever
          rendered for a comment-capable role (C-004) and a real selection (C-003), both enforced in
          useCompose; mounted here so it overlays the viewer body. */}
      {/* S-006/C-009: the 5-type popover is the MARKUP tool's surface — shown ONLY when Markup is the
          active tool. The other tools route the selection directly (the effect above), so the popover
          never appears under Comment/Redline/Label (AS-021/022/023). */}
      {compose.popover && activeTool === "markup" && !labelPickerAt && (
        <SelectionPopover
          rect={compose.popover}
          onComment={compose.startComment}
          // S-002: Redline runs the real create flow (delete-kind suggestion + root comment, optimistic
          // strike + DELETE card + rollback). S-003: Like opens the composer pre-filled "Looks good"
          // (editable) → on send a signal annotation carrying label="looks-good" + its root comment.
          // S-004: Label opens the LabelPicker at the popover's anchor (the selection stays pending in
          // useCompose) → choosing a preset runs the labeled-create. Suggest lands in suggest-image.
          onSelectType={(type) =>
            type === "redline"
              ? compose.startRedline()
              : type === "like"
                ? compose.startLike()
                : type === "label"
                  ? setLabelPickerAt(compose.popover)
                  : toast(`${type[0]!.toUpperCase()}${type.slice(1)} is coming soon`)
          }
          // pinpoint S-002 (AS-004): dismissing the synthesized block popover also clears the picked
          // block's hover-outline (a text-selection dismiss path no-ops the outline clear — none lit).
          onDismiss={dismissBlockPopover}
          onMeasure={compose.setPopoverSize}
        />
      )}

      {/* S-004 (AS-012/AS-013): the LabelPicker — opened when the user picks Label in the selection
          popover, anchored at the same spot. Choosing a preset runs the labeled-create (compose.
          startLabel opens the composer pre-filled with the preset text, carrying label=<presetId>);
          the picker closes either way. Outside-click/Escape dismiss reopens nothing — the pending
          selection is dropped along with the picker. */}
      {labelPickerAt && (
        <LabelPicker
          rect={labelPickerAt}
          onPick={(preset) => {
            setLabelPickerAt(null);
            compose.startLabel(preset.id, preset.text);
          }}
          onDismiss={() => {
            setLabelPickerAt(null);
            compose.dismissPopover();
          }}
        />
      )}

      {/* #3: the INLINE composer popover — replaces the selection popover at the same anchor once
          the user picks Comment. Mounted here (overlays the viewer body), not in the rail. */}
      {composerNode}

      {/* S-001: the read-only hover PEEK card — floats over the dwelled marker (prefer above, flips
          + clamps via placePopover). Renders only from the already-loaded annotation data (SC-001),
          carries NO action bar (acting is S-002's pinned card). Suppressed while a creation tool is
          active (C-001, enforced in useAnnotationMarks) and idle in drawer mode (touch → S-004). It
          is pointer-transparent so it never eats the cursor that would otherwise hide it. */}
      {peekAnnotation && hoverPin.peekPlacement && !drawerMode && hoverPin.pinnedId == null && (
        <div
          data-testid="annotation-peek-layer"
          className="pointer-events-none absolute z-40"
          style={{
            top: hoverPin.peekPlacement.top,
            left: hoverPin.peekPlacement.left,
            transform: hoverPin.peekPlacement.centered ? "translateX(-50%)" : undefined,
          }}
        >
          <AnnotationPeekCard annotation={peekAnnotation} />
        </div>
      )}

      {/* S-002: the click-to-PIN card — a floating popover hosting the FULL interactive ThreadCard at
          the clicked marker (prefer below, flip/clamp via placePopover). At most one pinned (C-002).
          Mounted only for a markdown doc on a pointer device (!drawerMode; touch → S-004 sheet) once a
          marker is pinned + its annotation still resolves (auto-close-on-orphan effect above). The
          action bar reuses the rail's per-thread bindings VERBATIM (C-005), so the pinned card and the
          rail card offer the identical role-gated actions; a viewer-only role passes none → read-only
          (AS-014). PinnedCardHost owns the marker-excluded outside-dismiss + the layered Escape. */}
      {pinnedAnnotation && hoverPin.pinPlacement && !drawerMode && (
        <PinnedCardHost
          annotation={pinnedAnnotation}
          placement={hoverPin.pinPlacement}
          docPaneEl={docPaneEl}
          onClose={closePin}
          focused={anno.railProps.focusedId === pinnedAnnotation.id}
          unplaceable={anno.railProps.unplaceableIds.has(pinnedAnnotation.id)}
          onFocus={onRailFocusThread}
          currentUserId={currentUserId}
          currentAuthorName={guest ? guestIdentity.name : currentUserName}
          currentAuthorIsGuest={guest}
          isOwner={anno.railProps.isOwner}
          onReply={
            anno.railProps.onReply
              ? (body: string) => anno.railProps.onReply!(pinnedAnnotation, body)
              : undefined
          }
          onResolve={
            anno.railProps.onResolve
              ? (resolved: boolean) => anno.railProps.onResolve!(pinnedAnnotation, resolved)
              : undefined
          }
          onDecide={
            anno.railProps.onDecide
              ? (decision: "accept" | "reject") => anno.railProps.onDecide!(pinnedAnnotation, decision)
              : undefined
          }
          onDelete={
            anno.railProps.onDelete
              ? () => anno.railProps.onDelete!(pinnedAnnotation)
              : undefined
          }
        />
      )}

      {/* annotation-hover-card S-004 (AS-018/AS-019/AS-020): the mobile/touch BOTTOM SHEET — the
          drawer-mode counterpart of the desktop pinned card. It shares the SAME pin state (pinnedId),
          so at most one is open (C-002) and the auto-close-on-orphan + cross-thread-focus rules apply
          identically. Mounted only in drawer mode (touch); the desktop popover above is gated
          !drawerMode, so the two never coexist — and the hover-peek (gated !drawerMode too) never
          appears on touch (AS-019). The sheet hosts the full ThreadCard with the SAME role-gated
          bindings the rail + the pinned popover use (C-005): a viewer-only role passes none →
          read-only (AS-020). */}
      {pinnedAnnotation && drawerMode && (
        <AnnotationBottomSheet
          annotation={pinnedAnnotation}
          onClose={closePin}
          focused={anno.railProps.focusedId === pinnedAnnotation.id}
          unplaceable={anno.railProps.unplaceableIds.has(pinnedAnnotation.id)}
          onFocus={onRailFocusThread}
          currentUserId={currentUserId}
          currentAuthorName={guest ? guestIdentity.name : currentUserName}
          currentAuthorIsGuest={guest}
          isOwner={anno.railProps.isOwner}
          onReply={
            anno.railProps.onReply
              ? (body: string) => anno.railProps.onReply!(pinnedAnnotation, body)
              : undefined
          }
          onResolve={
            anno.railProps.onResolve
              ? (resolved: boolean) => anno.railProps.onResolve!(pinnedAnnotation, resolved)
              : undefined
          }
          onDecide={
            anno.railProps.onDecide
              ? (decision: "accept" | "reject") => anno.railProps.onDecide!(pinnedAnnotation, decision)
              : undefined
          }
          onDelete={
            anno.railProps.onDelete
              ? () => anno.railProps.onDelete!(pinnedAnnotation)
              : undefined
          }
        />
      )}

      {/* S-001 / S-003 AS-030: the ShareDialog — opened by the top bar's Share button. Share is
          member-only + workspace-addressed (C-007 keeps Share workspace-scoped). It mounts ONLY for
          a signed-in member (memberWorkspaceId is null for an anon — complements AS-029) whose doc
          carries a non-null workspaceId (a project-less doc → null → no panel, C-011). The
          workspaceId is sourced from the doc-read response (the doc-scoped viewer has no URL param),
          replacing the S-003 interim stub (workspaceId=""). */}
      {hasDoc && doc && memberWorkspaceId && (
        <ShareDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          workspaceId={memberWorkspaceId}
          slug={slug!}
          docTitle={doc.title}
          effectiveRole={effectiveRole}
        />
      )}

      {/* versioning-diff-ui S-001 / S-003 AS-030: the version history panel — opened by the top
          bar's version button. Workspace-addressed (C-007), so it mounts ONLY for a signed-in member
          with a non-null response workspaceId (anon or project-less doc → hidden). The workspaceId
          is sourced from the read response, replacing the S-003 interim stub (workspaceId=""). */}
      {hasDoc && doc && memberWorkspaceId && (
        <VersionHistoryPanel
          open={versionsOpen}
          workspaceId={memberWorkspaceId}
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
  guestName,
  initialBody,
  onSend,
  onCancel,
}: {
  anchor: { top: number; left: number; centered: boolean };
  quote: string;
  pending?: boolean;
  guest?: boolean;
  /** S-007 (AS-016/017): the session-stable guest name that rides up on send (no in-composer field). */
  guestName?: string;
  /** S-003 (C-003): the composer's pre-filled body — "Looks good" for a Like, empty for a Comment. */
  initialBody?: string;
  onSend: (body: string, guestIdentity?: { guestName: string }) => void;
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
        guestName={guestName}
        initialBody={initialBody}
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

// PinnedCardHost (S-002): the dismiss-aware wrapper around PinnedCardPopover. It owns the C-004
// contract's two dismiss subtleties that a plain useDismissOnOutsideAndEscape can't express:
//
//  (b) OUTSIDE-CLICK excludes BOTH the popover AND the pinned MARKER. The marker that opened the card
//      must not auto-dismiss it via the capture-phase mousedown — otherwise a re-click on the pinned
//      marker would BOTH toggle-close (the doc-pane click) AND outside-dismiss (this mousedown),
//      double-firing. Excluding the marker makes a re-click resolve to exactly ONE toggle-close
//      (AS-011); a click on any OTHER doc text closes (AS-008).
//  (c) LAYERED Escape: when the reply composer is open, its textarea's onKeyDown handles Escape and
//      stopPropagation (cancel the reply, card stays — AS-024); only an Escape with NO inner composer
//      reaches this window listener and closes the card (AS-009). We bind Escape on `window` (like
//      useDismissOnOutsideAndEscape) so the composer's React stopPropagation layers under it.
//
// The doc-pane element is passed so the mousedown test can find the pinned mark(s) (one annotation =
// N marks for a multi_range) and treat a click on ANY of them as "inside".
function PinnedCardHost({
  annotation,
  placement,
  docPaneEl,
  onClose,
  ...threadProps
}: Omit<React.ComponentProps<typeof PinnedCardPopover>, "wrapperRef"> & {
  docPaneEl: HTMLElement | null;
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const annoId = annotation.id;
  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      // Multi-click guard (mirrors useDismissOnOutsideAndEscape): a double/triple-click is a selection
      // gesture, not an outside dismiss.
      if (event.detail >= 2) return;
      const target = event.target as Node | null;
      if (!target) return;
      // Inside the popover → keep open.
      if (wrapperRef.current?.contains(target)) return;
      // (b) Inside the pinned MARKER (any of its N marks) → keep open; the doc-pane click handler
      // owns the toggle-close (AS-011). Exclude by data-anno match so a re-click is ONE toggle.
      const el = target instanceof Element ? target : (target as Node).parentElement;
      const mark = el?.closest?.(`[data-anno="${annoId}"]`);
      if (mark && docPaneEl?.contains(mark)) return;
      onClose(); // AS-008: a click on any other doc text closes the pin.
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      // (c) AS-009/AS-024: Escape closes the pin — UNLESS an inner reply composer swallowed it first
      // (its textarea stopPropagation prevents this window listener from seeing that key). So reaching
      // here means no composer was open → close.
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleMouseDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [annoId, docPaneEl, onClose]);

  return (
    <PinnedCardPopover
      annotation={annotation}
      placement={placement}
      onClose={onClose}
      wrapperRef={wrapperRef}
      {...threadProps}
    />
  );
}

// useAnnotations (S-003/S-006): reads the doc's annotations, places highlight marks against the doc
// content element, owns focus pairing (C-003), and exposes the rail props + the FAB count. Lifted
// out of the rail so the CommentFab (count) and the drawer-open-on-highlight-tap (AS-014) can share
// the same annotation set. `onHighlightTap` fires on a highlight click (after focus) so the shell
// can open the rail drawer in drawer mode.
function useAnnotations(
  slug: string | undefined,
  docPaneEl: HTMLElement | null,
  enabled: boolean,
  canCompose: boolean,
  /** S-002: the doc's workspace (member-only, sourced from the read response). The redline DECIDE
   *  route is workspace-scoped, so a non-null workspaceId is required to offer Accept/Reject. */
  workspaceId: string | null,
  /** S-002 (C-002): deciding a redline is OWNER-only — the Accept/Reject row only appears for owner. */
  effectiveRole: ViewerDocResponse["doc"]["effectiveRole"],
  /** HTML-PLACE: markdown places via the light-DOM placer; html/image place via the iframe bridge. */
  isMarkdown: boolean,
  onHighlightTap: () => void,
  /** S-007 (AS-017): the session-stable guest name when this is a guest session (null for a signed-in
   *  member). A guest reply rides it up so the anon write isn't rejected ("guestName is required");
   *  a member passes null (identity is the session cookie). Mirrors useCompose's `guestName` param. */
  guestName: string | null,
  /** C-001: the member's REAL display name, so a reconciled reply shows the real name (never "You").
   *  Null for a guest (the guest path uses guestName instead). */
  currentUserName: string | null,
  /** S-001: hover-peek detection options forwarded to useAnnotationMarks (active-tool suppression +
   *  dwell + the onHoverPeek callback). Undefined → no hover (e.g. on a non-markdown shell). */
  hoverPeek: HoverPeekOptions | undefined,
  /** S-002: click-to-pin options forwarded to useAnnotationMarks (selection-gated onPinMark). Undefined
   *  → click only focuses (drawer-mode/touch → S-004 sheet, or a non-markdown shell). */
  pin: PinOptions | undefined,
): {
  count: number;
  refetch: () => Promise<unknown>;
  /** PERF: prepend a freshly-created real annotation into the cache (newest-first, deduped) so the
   *  rail re-renders without a refetch. Called from useCompose's create-success reconcile. */
  prependAnnotation: (real: ViewerAnnotation) => void;
  /** HTML-PLACE: the placeable anchors to post down the iframe bridge (html docs only draw this way).
   *  Non-orphaned, anchored annotations mapped to the bridge's `{id, anchor}` shape. */
  htmlPlaceable: { id: string; anchor: BridgeAnchor; hue?: string; filtered?: boolean; type?: "block" }[];
  /** HTML-PLACE: route an in-iframe placement failure to the rail's couldn't-place badge (additive). */
  reportUnplaceableHtml: (id: string) => void;
  railProps: {
    annotations: ViewerAnnotation[];
    focusedId: string | null;
    unplaceableIds: Set<string>;
    /** S-007 (C-009): the active Status / Type facet sets + their toggles + Reset, lifted here so the
     *  SAME selection drives the rail filter AND the in-text mark dimming. */
    activeStatus: ReadonlySet<StatusFacet>;
    activeType: ReadonlySet<TypeFacet>;
    activeDecision: ReadonlySet<DecisionFacet>;
    onToggleStatus: (f: StatusFacet) => void;
    onToggleType: (f: TypeFacet) => void;
    onToggleDecision: (f: DecisionFacet) => void;
    onResetFilter: () => void;
    /** S-002 (C-002): the session is the doc owner — forwarded to each card's proposal close family. */
    isOwner: boolean;
    onFocusThread: (id: string) => void;
    onReply?: (annotation: ViewerAnnotation, body: string) => Promise<boolean>;
    onResolve?: (annotation: ViewerAnnotation, resolved: boolean) => Promise<boolean>;
    onDecide?: (annotation: ViewerAnnotation, decision: "accept" | "reject") => Promise<boolean>;
    /** S-003 (C-004/C-005): delete an anchored thread — optimistic remove + undo toast + restore. */
    onDelete?: (annotation: ViewerAnnotation) => Promise<boolean>;
    /** S-004 (C-004): the session may comment → the detached cards show Re-attach + Dismiss. */
    canCompose: boolean;
    /** S-004 (AS-017): the detached annotation currently armed for re-attach (null → none). */
    reattachPendingId: string | null;
    /** S-004 (AS-016): dismiss a detached annotation — optimistic remove + rollback. */
    onDismissDetached?: (annotation: ViewerAnnotation) => Promise<boolean>;
    /** S-004 (AS-017): arm/cancel re-attach for a detached annotation. */
    onReattachDetached?: (annotation: ViewerAnnotation) => void;
  };
  /** S-004 (AS-017): re-attach a detached annotation to a freshly-selected anchor (called by the
   *  viewer once it captures the next selection via the compose intercept). Patches the cache:
   *  isOrphaned → false + the new anchor, so it moves out of the detached section + gets a highlight. */
  reattachWith: (annotation: ViewerAnnotation, anchor: ViewerAnnotation["anchor"]) => Promise<boolean>;
} {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  // S-007 (C-009): the TWO-AXIS filter selection, lifted here (like focusedId) so the SAME selection
  // drives BOTH the rail thread list AND the in-text mark dimming. Both axes all-selected by default.
  // Toggling a facet OFF hides its threads + dims their marks; the detached section is unaffected
  // (C-004). A thread shows iff its status facet AND its type facet are both selected (AND across).
  // C-009 (2026-06-21): the rail filter DEFAULT hides Resolved — Status starts at {Open} only, Type
  // all-selected. Resolved threads surface only when the reviewer enables the Resolved facet.
  const [activeStatus, setActiveStatus] = useState<ReadonlySet<StatusFacet>>(DEFAULT_STATUS);
  const [activeType, setActiveType] = useState<ReadonlySet<TypeFacet>>(DEFAULT_TYPE);
  // S-007 third axis (C-009): the Decision facet set — PARTIAL (only suggestions carry a decision).
  // All-selected by default; the Open-only Status default already hides most decided suggestions.
  const [activeDecision, setActiveDecision] = useState<ReadonlySet<DecisionFacet>>(DEFAULT_DECISION);
  const toggleStatus = useCallback((f: StatusFacet) => {
    setActiveStatus((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  }, []);
  const toggleType = useCallback((f: TypeFacet) => {
    setActiveType((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  }, []);
  const toggleDecision = useCallback((f: DecisionFacet) => {
    setActiveDecision((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  }, []);
  // S-007 (AS-027): Reset re-selects every facet across all three axes.
  const resetFilter = useCallback(() => {
    // Reset returns to the DEFAULT baseline (Open-only, all types, all decisions) — NOT all-selected (C-011).
    setActiveStatus(DEFAULT_STATUS);
    setActiveType(DEFAULT_TYPE);
    setActiveDecision(DEFAULT_DECISION);
  }, []);
  // S-007 (AS-028): acting on a filtered-out annotation must re-activate whichever of its facets are off
  // — across all three axes (status, type, and — for a suggestion — decision) — so it matches again,
  // never a dead no-op. Used by the click-on-mark + rail-thread focus paths before they focus the thread.
  const ensureFacetsActive = useCallback((a: Pick<ViewerAnnotation, "type" | "status" | "suggestion" | "label" | "suggestionStatus">) => {
    const sf = statusFacet(a);
    const tf = typeFacet(a);
    const df = decisionFacet(a);
    setActiveStatus((prev) => (prev.has(sf) ? prev : new Set(prev).add(sf)));
    setActiveType((prev) => (prev.has(tf) ? prev : new Set(prev).add(tf)));
    if (df !== null) setActiveDecision((prev) => (prev.has(df) ? prev : new Set(prev).add(df)));
  }, []);
  const queryClient = useQueryClient();
  // The cache key for this doc's annotation list (matches useApiQuery below). All post-write
  // reconciles patch THIS entry directly via setQueryData instead of refetching.
  const annoKey = ["viewer-annotations", slug] as const;

  // C-004 (AS-014): the annotation read is ALSO a doc-centric viewer read — tag it `viewerRead` so a
  // no-access reply can never fire the global sign-out on the public viewer (the read is gated by
  // `enabled`, but if it runs and 401s/404s for an anon, it stays in-place, no bounce).
  const annoQuery = useApiQuery<ListAnnotationsResponse>(
    annoKey,
    () => listAnnotations(slug ?? ""),
    // refetchOnWindowFocus (paired with the doc read above): a new version re-anchors annotations
    // server-side, so refresh the list when the reviewer tabs back to pick up the carried/orphaned state.
    { enabled, meta: { viewerRead: true }, refetchOnWindowFocus: true },
  );

  const annotations: ViewerAnnotation[] = annoQuery.data?.items ?? [];

  // PERF (create reconcile): prepend the real row into the cached list — newest-first, deduped by id
  // (a defensive guard so a double-fire can't list the same annotation twice). Only writes when ws +
  // slug are present (the enabled-gated query); the create-success path always has them.
  const prependAnnotation = useCallback(
    (real: ViewerAnnotation) => {
      if (!slug) return;
      queryClient.setQueryData<ListAnnotationsResponse>(annoKey, (old) => {
        const items = old?.items ?? [];
        if (items.some((a) => a.id === real.id)) return old ?? { items };
        return { ...old, items: [real, ...items] };
      });
    },
    // annoKey is derived from slug; list it so the closure tracks the real deps.
    [queryClient, slug], // eslint-disable-line react-hooks/exhaustive-deps
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
  // HTML-PLACE: the light-DOM placer never runs for an HTML doc (the blocks live in the opaque
  // iframe — it could only ever false-flag every id "couldn't place"). Instead the in-iframe bridge
  // reports a per-id placement failure over the port. This adds that single id additively (the set
  // starts empty for HTML, so a matched annotation never lands here — only genuinely-unlocatable ones).
  const reportUnplaceableHtml = useCallback((id: string) => {
    setUnplaceableIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);
  // S-003 (C-002): the in-iframe sync is clear-then-redraw and re-posts place-failed for the
  // genuinely-unplaceable items of EACH sync. So the HTML-unplaceable set must be RESET at the start
  // of every sync — otherwise it is additive-only and an id that became placeable again (a restore,
  // or a re-anchor that now matches) would stay falsely flagged. We clear it whenever the posted HTML
  // set changes; the place-failed callbacks from that sync then repopulate only the real misses.
  // For an HTML doc the markdown placer is fed EMPTY_PLACEABLE and never touches this set, so the
  // reset is HTML-owned and never clobbers markdown's unplaceable (the two never coexist on one doc).
  const resetUnplaceableHtml = useCallback(() => {
    setUnplaceableIds((prev) => (prev.size === 0 ? prev : new Set()));
  }, []);

  // S-002 (C-002/AS-007): derive the redline kind + stale flag onto each placeable annotation so the
  // mark renders the red strike (a delete-kind suggestion) or the muted-dashed stale style (a drifted
  // redline). Ordinary annotations carry neither. Memoized so the marks effect's `annotations` dep
  // stays referentially stable across a selection re-render (the single-place guarantee, BUG #1).
  const placeable = useMemo(
    () =>
      annotations
        // C-002 (AS-006): a REJECTED delete-proposal carries NO doc mark — the proposal is dead, so the
        // text it struck renders plain again (no dangling strike on text that stays). Excluded from BOTH
        // mark paths (the light-DOM placer clears+redraws from this set; htmlPlaceable derives from it).
        // An ACCEPTED redline is NOT excluded — its strike stays (dimmed), slated for MCP-apply (AS-005).
        .filter((a) => !(a.type === "suggestion" && a.suggestion?.kind === "delete" && a.suggestionStatus === "rejected"))
        .map((a) => {
        const isRedline = a.type === "suggestion" && a.suggestion?.kind === "delete";
        // DESIGN.md type/tool palette: 4 basic tool hues (NOT per-label). A redline strikes red (via
        // kind, no hue); ANY label (incl. the Like "looks-good" preset) → Label gold; a plain comment
        // → Comment amber; everything else (a replace-suggestion, etc.) stays the default Markup teal.
        const hue = isRedline ? undefined : a.label ? LABEL_HUE : a.suggestion ? undefined : COMMENT_HUE;
        return {
          ...a,
          kind: isRedline ? ("redline" as const) : undefined,
          stale: a.suggestionStatus === "stale",
          hue,
          // S-007 (C-009): the mark is DIMMED when the annotation is NOT shown by the three-axis filter
          // (its status / type / decision facet is toggled off). Detached items carry no highlight
          // (excluded below / by the placer), so this only affects anchored marks.
          filtered: !isShown(a, activeStatus, activeType, activeDecision),
        };
      }),
    [annotations, activeStatus, activeType, activeDecision],
  );

  // HTML-PLACE: the placeable set in the bridge's `{id, anchor}` shape, for an HTML doc to post down
  // the port (the parent can't draw into the opaque iframe). Orphaned annotations get no highlight
  // (C-004) — they live in the rail's detached section — so they're excluded here, mirroring the
  // light-DOM placer's isOrphaned skip. Derived from `placeable` so it stays referentially stable.
  const htmlPlaceable = useMemo(
    () =>
      placeable
        .filter((a) => !a.isOrphaned)
        // S-001/AS-002: carry the SAME per-type/label hue derived above (Comment amber / Label gold /
        // redline none / default teal) so the in-iframe mark matches the markdown hued mark.
        // S-002/C-003: ALSO carry the lifecycle state — resolved (status==="resolved") → dim,
        // kind==="redline" → red strike, stale → muted/dashed — so the in-iframe mark reproduces the
        // markdown mark's resolved/redline/stale appearance (the SAME flags `placeable` derives).
        .map((a) => ({
          id: a.id,
          anchor: a.anchor as BridgeAnchor,
          hue: a.hue,
          resolved: a.status === "resolved",
          kind: a.kind,
          stale: a.stale,
          // S-007 (C-009): carry the dim state down the bridge so the in-iframe mark dims too (the
          // markdown placer + the HTML bridge are the TWO placement paths; both must dim, AS-023).
          filtered: a.filtered,
          // pinpoint S-004/AS-012 (C-002): a type=block annotation tells the in-iframe bridge to
          // outline the whole block ELEMENT (data-block-anno) instead of wrapping a text range.
          type: a.type === "block" ? ("block" as const) : undefined,
        })),
    [placeable],
  );

  // S-003 (C-002): reset the HTML-unplaceable set at the START of each in-iframe sync (the posted set
  // changed). The frame's clear-then-redraw re-posts place-failed for the real misses of this sync,
  // which repopulate the set — so a now-placeable id (restored / re-anchored) clears instead of
  // lingering. Keyed on the id list so it fires exactly when the synced set changes. Gated on
  // !isMarkdown (the iframe-drawn path — html/image): a markdown doc places via the light-DOM placer
  // + reportUnplaceable and never wires reportUnplaceableHtml, so resetting there would clobber it.
  const htmlIdsKey = !isMarkdown ? htmlPlaceable.map((a) => a.id).join(",") : "";
  useEffect(() => {
    if (isMarkdown) return;
    resetUnplaceableHtml();
  }, [isMarkdown, htmlIdsKey, resetUnplaceableHtml]);

  // Place marks + wire click-on-highlight → focus thread (AS-008) AND open the rail drawer (AS-014).
  // HTML-PLACE: the light-DOM placer is MARKDOWN-only. For an HTML doc the content lives inside the
  // opaque sandbox iframe, so docPaneEl holds only the <iframe> — placeAnnotations would findBlock
  // null for every anchor and false-flag ALL of them "couldn't place". HTML is drawn the only way it
  // can be: each anchor posted down the bridge by HtmlSandboxFrame (placement failures come back via
  // onPlaceFailed → reportUnplaceableHtml). So feed the placer an empty set for non-markdown.
  // S-007 (AS-028): a click on a (possibly filtered-out, dimmed) highlight must re-activate BOTH the
  // annotation's facets (status AND type) before focusing — so its thread reappears in the rail and
  // the click is never a dead no-op. Looks the annotation up by id to find its facets.
  const reactivateFacetsFor = useCallback(
    (id: string) => {
      const a = annotations.find((x) => x.id === id);
      if (a) ensureFacetsActive(a);
    },
    [annotations, ensureFacetsActive],
  );

  useAnnotationMarks(
    docPaneEl,
    isMarkdown ? placeable : EMPTY_PLACEABLE,
    focusedId,
    (id) => {
      reactivateFacetsFor(id); // AS-028: clicking a dimmed/filtered mark re-activates BOTH its facets
      setFocusedId(id);
      onHighlightTap();
    },
    reportUnplaceable,
    // S-001: hover-peek detection on the SAME delegated doc-pane listener (markdown light DOM; the
    // HTML iframe case is S-003). Suppressed while a creation tool is active (C-001) — the flag is
    // read live inside the listener so it never goes stale.
    hoverPeek,
    // S-002: click-to-pin on the SAME delegated click listener — a non-suppressed marker click pins
    // the full card at the clicked mark's own rect (C-008). Selection-gated (C-001/AS-013), read live.
    pin,
  );

  const focusThread = (id: string) => {
    reactivateFacetsFor(id); // AS-028: focusing a filtered-out thread re-activates BOTH its facets
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
    canCompose && slug
      ? async (annotation: ViewerAnnotation, body: string): Promise<boolean> => {
          const parentId = (annotation.comments ?? [])[0]?.id ?? null;
          try {
            const res = await addComment(slug, annotation.id, {
              body,
              ...(parentId ? { parentId } : {}),
              // Regression: a guest reply must carry the session-stable name — the anon write path has
              // no session cookie, so without it the server rejects with "guestName is required". The
              // composer (send) + redline (startRedline) already ride the name up; the reply path was
              // the one guest-write surface the identity refactor missed. Members pass null (session cookie).
              ...(guestName ? { guestName } : {}),
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
              // C-001: attribute with the REAL name — guest rides guestName (dims as a guest), a member
              // rides their session name. No "You": if a member's name is unresolved, carry no name.
              ...(guestName
                ? { guestName }
                : currentUserName
                  ? { authorName: currentUserName }
                  : {}),
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
    canCompose && slug
      ? async (annotation: ViewerAnnotation, resolved: boolean): Promise<boolean> => {
          dimMark(annotation.id, resolved); // AS-007: highlight dims optimistically
          try {
            const res = await setResolution(slug, annotation.id, { resolved });
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

  // S-002 (AS-005/006/008/C-002): the OWNER accepts/rejects a redline. Workspace-scoped (the decide
  // route has no doc-addressed form) + OWNER-only, so it's wired ONLY when a workspaceId is reachable
  // AND the effective role is owner. Deciding auto-resolves the thread: on success we patch the
  // suggestionStatus AND flip status→resolved in the cache (no refetch), and dim the highlight. On a
  // refused / stale (409) / failed decide we return false (the card rolls its optimistic resolve
  // back) and toast — an accept on a drifted redline does NOT apply it (AS-007).
  const onDecide =
    workspaceId && effectiveRole === "owner" && slug
      ? async (annotation: ViewerAnnotation, decision: "accept" | "reject"): Promise<boolean> => {
          try {
            const res = await decideSuggestion(workspaceId, annotation.id, { decision });
            if (res.error) {
              // 409 stale (AS-007) or a refused write — keep the redline pending, surface it. The
              // eden error is `unknown` at the type layer; read its status defensively.
              const stale = (res.error as { status?: number } | null)?.status === 409;
              toast.error(stale ? "This redline is stale and can't be accepted" : "Couldn't decide this redline");
              if (stale) {
                queryClient.setQueryData<ListAnnotationsResponse>(annoKey, (old) =>
                  old
                    ? {
                        ...old,
                        items: old.items.map((a) =>
                          a.id === annotation.id ? { ...a, suggestionStatus: "stale" } : a,
                        ),
                      }
                    : old,
                );
              }
              return false;
            }
            // Success: deciding auto-resolves (C-002). Patch the suggestionStatus + resolve the thread
            // in the cache, and dim the in-text strike.
            dimMark(annotation.id, true);
            queryClient.setQueryData<ListAnnotationsResponse>(annoKey, (old) => {
              if (!old) return old;
              return {
                ...old,
                items: old.items.map((a) =>
                  a.id === annotation.id
                    ? { ...a, status: "resolved", suggestionStatus: decision === "accept" ? "accepted" : "rejected" }
                    : a,
                ),
              };
            });
            return true;
          } catch {
            toast.error("Couldn't decide this redline");
            return false;
          }
        }
      : undefined;

  // annotation-actions-ui S-003 (C-004/C-005): DELETE an annotation with an optimistic remove + an
  // undo toast that restores it. Session-required server-side (an anon/guest is refused, the
  // affordance is already author/owner-gated in the card). Wired ONLY when the session can act on the
  // doc — same `canComment` gate as reply/resolve (a viewer-only role gets no onDelete, so the card
  // shows no Delete). The card's affordance is a HINT; the backend re-authorizes (S-004).
  //   • delete: snapshot the annotation, optimistically REMOVE it from the cached list (it vanishes
  //     from the rail immediately), call deleteAnnotation. On success raise an UNDO toast whose action
  //     calls restoreAnnotation + re-inserts the snapshot (newest-first, deduped) — a refetch would
  //     also bring it back via S-005's restore, but the in-cache re-insert keeps it instant. On a
  //     refused/failed delete (role revoked / network) RE-ADD the snapshot + toast an error — no
  //     silent loss (C-005). A soft-deleted annotation is excluded from the list read (S-005), so the
  //     optimistic remove stays consistent on any later refetch.
  const removeFromCache = (id: string) =>
    queryClient.setQueryData<ListAnnotationsResponse>(annoKey, (old) =>
      old ? { ...old, items: old.items.filter((a) => a.id !== id) } : old,
    );
  const reinsertIntoCache = (anno: ViewerAnnotation) =>
    queryClient.setQueryData<ListAnnotationsResponse>(annoKey, (old) => {
      const items = old?.items ?? [];
      if (items.some((a) => a.id === anno.id)) return old ?? { items };
      return { ...old, items: [anno, ...items] };
    });
  const onDelete =
    canCompose && slug
      ? async (annotation: ViewerAnnotation): Promise<boolean> => {
          const snapshot = annotation; // restore target if the user undoes / the write is refused
          removeFromCache(annotation.id); // optimistic remove — vanishes from the rail immediately
          try {
            const res = await deleteAnnotation(slug, annotation.id);
            if (res.error) {
              reinsertIntoCache(snapshot); // refused → roll back (no silent loss)
              toast.error("Couldn't delete this annotation");
              return false;
            }
            // Success: an undo toast restores it if the user acts in time (C-005). Undoing calls the
            // restore route + re-inserts the snapshot; a failed restore re-removes it + errors.
            toast("Annotation deleted", {
              action: {
                label: "Undo",
                onClick: () => {
                  reinsertIntoCache(snapshot); // bring it back instantly
                  void (async () => {
                    const r = await restoreAnnotation(slug, snapshot.id);
                    if (r.error) {
                      removeFromCache(snapshot.id); // restore refused → it stays gone, surface it
                      toast.error("Couldn't restore this annotation");
                    }
                  })();
                },
              },
            });
            return true;
          } catch {
            reinsertIntoCache(snapshot);
            toast.error("Couldn't delete this annotation");
            return false;
          }
        }
      : undefined;

  // S-004 (AS-016/AS-017 / C-004): manage a DETACHED (isOrphaned) annotation — dismiss it (it leaves
  // the rail) or re-attach it to a freshly-selected range (it becomes anchored). Both routes are
  // WORKSPACE-scoped + commenter+ (the backend re-authorizes; a viewer is refused 403). They're wired
  // ONLY when a workspaceId is reachable AND the session can comment — same gate family as reply/
  // resolve/delete; an anon / project-less doc / viewer-only role gets display-only detached cards.
  //
  //   • Dismiss (AS-016): optimistically REMOVE the annotation from the cached list (it vanishes from
  //     the detached section + the rail total drops), call dismissAnnotation. On a refused/failed
  //     write RE-ADD the snapshot + toast — no silent loss. A dismissed row is excluded from the
  //     active read, so the optimistic remove stays consistent on a refetch (no reappear on reload).
  //   • Re-attach (AS-017): arming is owned by the shell (it sets the compose selection intercept);
  //     once the next selection is captured the shell calls reattachWith(annotation, anchor). On
  //     success we PATCH the cache: isOrphaned → false + the NEW anchor — the annotation moves out of
  //     the detached section into the anchored thread list and the placer draws its highlight on the
  //     new range. On a refused/failed/400-mismatch write we keep it detached + toast.
  const [reattachPendingId, setReattachPendingId] = useState<string | null>(null);
  const detachedEnabled = canCompose && Boolean(workspaceId) && Boolean(slug);
  const onDismissDetached = detachedEnabled
    ? async (annotation: ViewerAnnotation): Promise<boolean> => {
        const snapshot = annotation;
        removeFromCache(annotation.id); // AS-016: optimistic remove — leaves the detached section now
        try {
          const res = await dismissAnnotation(workspaceId!, annotation.id);
          if (res.error) {
            reinsertIntoCache(snapshot); // refused → roll back (no silent loss)
            toast.error("Couldn't dismiss this annotation");
            return false;
          }
          return true;
        } catch {
          reinsertIntoCache(snapshot);
          toast.error("Couldn't dismiss this annotation");
          return false;
        }
      }
    : undefined;
  // AS-017: clicking Re-attach arms (or cancels) the next-selection capture for THIS annotation. The
  // shell wires the actual selection intercept (it owns useCompose) — here we only track which one is
  // armed so the rail card reads as armed. Re-clicking the armed card cancels (toggle off).
  const onReattachDetached = detachedEnabled
    ? (annotation: ViewerAnnotation): void => {
        setReattachPendingId((cur) => (cur === annotation.id ? null : annotation.id));
      }
    : undefined;
  const reattachWith = useCallback(
    async (annotation: ViewerAnnotation, anchor: ViewerAnnotation["anchor"]): Promise<boolean> => {
      setReattachPendingId(null); // disarm regardless of outcome
      if (!workspaceId || !slug) return false;
      try {
        const res = await reattachAnnotation(workspaceId, annotation.id, anchor);
        if (res.error) {
          // 400 anchor-mismatch or a refused write — keep it detached, surface it (no silent move).
          toast.error("Couldn't re-attach this annotation");
          return false;
        }
        // Success (AS-017): clear isOrphaned + set the new anchor in the cache → the annotation moves
        // out of the detached section into the anchored list; the marks effect draws its highlight.
        queryClient.setQueryData<ListAnnotationsResponse>(annoKey, (old) =>
          old
            ? {
                ...old,
                items: old.items.map((a) =>
                  a.id === annotation.id ? { ...a, isOrphaned: false, anchor } : a,
                ),
              }
            : old,
        );
        return true;
      } catch {
        toast.error("Couldn't re-attach this annotation");
        return false;
      }
    },
    [workspaceId, slug, queryClient], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return {
    count: annotations.length,
    refetch: () => annoQuery.refetch(),
    prependAnnotation,
    htmlPlaceable,
    reportUnplaceableHtml,
    railProps: { annotations, focusedId, unplaceableIds, activeStatus, activeType, activeDecision, onToggleStatus: toggleStatus, onToggleType: toggleType, onToggleDecision: toggleDecision, onResetFilter: resetFilter, isOwner: effectiveRole === "owner", onFocusThread: focusThread, onReply, onResolve, onDecide, onDelete, canCompose, reattachPendingId, onDismissDetached, onReattachDetached },
    reattachWith,
  };
}
