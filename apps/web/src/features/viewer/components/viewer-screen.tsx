import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/api/auth-client";
import { useApiQuery } from "@/lib/api/use-api-query";
import { NoAccessView } from "./no-access-view";
import { useViewerLayoutMode } from "@/hooks/use-breakpoint";
import { Icon } from "@/components/icon";
import { ErrorState } from "@/components/error-state";
import { Skeleton } from "@/components/skeleton";
import { DocPane } from "./doc-pane";
import type { HtmlSandboxFrameHandle } from "./html-sandbox-frame";
import type { BridgeAnchor } from "@/features/viewer/lib/bridge";
import { DocModeToolbar, type MarkupTool } from "./doc-mode-toolbar";
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
import { useAnnotationMarks, scrollToAnno, type PlaceableAnnotation } from "./annotation-marks";
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
  const [activeTool, setActiveTool] = useState<MarkupTool>("markup");
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

  // S-003/S-006: the annotations are read here (lifted above the rail) so the CommentFab can show
  // the count and the highlight-tap can open the rail drawer, while the rail still renders them.
  const anno = useAnnotations(slug, docPaneEl, hasDoc, canCompose, memberWorkspaceId, effectiveRole, doc?.kind === "markdown", () => {
    if (drawerMode) setRailOpen(true); // AS-014: tapping a highlight opens the rail drawer
  }, guest ? guestIdentity.name : null, guest ? null : currentUserName);

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
      if (drawerMode) setRailOpen(true); // surface the new thread in the rail drawer on tablet/mobile
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

  // Optimistic threads (created locally, not yet reconciled by a refetch) lead the rail so the
  // newest comment tops the list (AS-001) and the count includes them (AS-001.T4 / C-011).
  const railAnnotations = [...compose.optimistic, ...anno.railProps.annotations];
  const railContent = hasDoc ? (
    <AnnotationsRail
      {...anno.railProps}
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
          onOverflow={() => toast("More actions")}
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
              onPinpointUnavailable={() => toast("Pinpoint mode is coming soon")}
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
              // S-004/AS-011 (C-005): a highlight click inside the iframe → focus that rail thread
              // (and open the rail drawer on narrow), mirroring the markdown click→focus path above.
              onHtmlMarkClick={
                isHtml
                  ? (id) => {
                      // Mirror the markdown click→focus (setFocusedId + open the rail drawer on
                      // narrow). onFocusThread sets focusedId; the focus-sync effect below then posts
                      // focus back DOWN the port so the clicked mark is emphasised too.
                      anno.railProps.onFocusThread(id);
                      if (drawerMode) setRailOpen(true);
                    }
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
          onDismiss={compose.dismissPopover}
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
): {
  count: number;
  refetch: () => Promise<unknown>;
  /** PERF: prepend a freshly-created real annotation into the cache (newest-first, deduped) so the
   *  rail re-renders without a refetch. Called from useCompose's create-success reconcile. */
  prependAnnotation: (real: ViewerAnnotation) => void;
  /** HTML-PLACE: the placeable anchors to post down the iframe bridge (html docs only draw this way).
   *  Non-orphaned, anchored annotations mapped to the bridge's `{id, anchor}` shape. */
  htmlPlaceable: { id: string; anchor: BridgeAnchor; hue?: string; filtered?: boolean }[];
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
