import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  createAnnotation,
  type ViewerAnnotation,
} from "@/features/viewer/services/client";
import { selectionToAnchor, type SelectionAnchor } from "@/features/viewer/lib/selection-anchor";
import { placeAnnotations } from "@/features/viewer/components/annotation-marks";
import { placePopover, isRectOutOfViewport, type RectLike } from "@/features/viewer/lib/place-popover";

// MƯỢT TASK 1/2: the popover is now viewport-aware. A live Markdown selection keeps a reference to
// its DOM Range so scroll/resize can re-read the current selection rect and reposition (or dismiss
// when it scrolls out). placePopover (pure) does the flip/clamp math; this hook owns the wiring.
//
// A fallback popover size used while the popover hasn't been measured yet (happy-dom returns 0 for
// getBoundingClientRect, so every test path uses this). Roughly the rendered Comment+Dismiss toolbar.
const DEFAULT_POPOVER_SIZE = { width: 168, height: 40 };

function viewport(): { width: number; height: number } {
  return {
    width: typeof window !== "undefined" ? window.innerWidth || 1024 : 1024,
    height: typeof window !== "undefined" ? window.innerHeight || 768 : 768,
  };
}

/** Read the live selection's first range rect (RectLike), or null when there's no live range. */
function selectionRect(sel: Selection | null): RectLike | null {
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0).getBoundingClientRect?.();
  if (!r) return null;
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
}

// useCompose (S-001): the comment WRITE flow for a Markdown doc, lifted out of viewer-screen so the
// shell module stays focused. Owns: selection capture → popover → composer → optimistic create.
//
//   1. SELECTION (C-003/C-004): on mouseup over the doc pane, if the role may compose AND the
//      selection covers real characters inside a data-block-id block (selectionToAnchor != null),
//      show the popover. A viewer-only role (canCompose=false) never attaches the listener, so it
//      gets no popover/composer — a read-only rail.
//   2. COMPOSE: Comment in the popover opens the composer prefilled with the quote.
//   3. SEND (AS-001 + C-011): optimistically prepend a thread + place its highlight, then
//      POST annotation → POST comment. On success, BUILD the real annotation from the responses and
//      PREPEND it into the react-query cache (no refetch — no network reload, no flicker), then clear
//      the optimistic temp. On a refused / failed write, ROLL BACK — remove the optimistic thread +
//      highlight — and toast an error.

let optimisticSeq = 0;

/**
 * Build the author attribution for an optimistic created annotation AND the no-refetch reconciled
 * real row (both must match so there's no name/avatar flicker when the temp is swapped). A signed-in
 * member uses their REAL session display name + durable `authorId` — so the rail shows the real name
 * + avatar immediately and `isOwn` (authorId === currentUserId) matches without waiting for a
 * refetch. A guest uses its self-entered name and carries NO authorId (a guest matches no signed-in
 * user). There is NO "You" fallback — if a signed-in session's name hasn't resolved yet the comment
 * carries no name, and the no-refetch reconcile fills the real name moments later.
 */
export function optimisticAuthor(
  currentUser: { id: string; name: string } | null | undefined,
  guestIdentity: { guestName: string } | undefined,
): { comment: { authorName?: string; guestName?: string }; authorId?: string } {
  if (guestIdentity) return { comment: { guestName: guestIdentity.guestName } };
  if (currentUser?.name) return { comment: { authorName: currentUser.name }, authorId: currentUser.id };
  // No "You" fallback — a guest uses its session name, a member uses the authored name. The only way
  // here is a not-yet-resolved session, a rare window the no-refetch reconcile corrects.
  return { comment: {} };
}

// S-003 (C-003 / challenge #9): the Like preset. Picking Like opens the composer pre-filled with the
// preset's display text (editable) and creates a signal annotation carrying `label="looks-good"`.
// Only `looks-good` matters for S-003 — the full preset set + LabelPicker are S-004's job.
export const LIKE_LABEL = "looks-good";
export const LIKE_BODY = "Looks good";

// S-002 (C-003): a redline has no composer, but every annotation needs a root comment and the
// backend rejects an empty body, so the redline's root comment carries this concise default
// (the strike conveys the deletion; this is just the thread's authored anchor). S3 guard.
export const REDLINE_ROOT_BODY = "Suggested deletion";

// pinpoint S-002 (C-002 / AS-006c): the cap for a whole-block textSnippet. A block can be large (a
// fenced code block, a wide table) — unlike a range snippet which is small by nature — so we bound
// the stored snippet to keep the anchor jsonb + the per-version locate scan small. Above the cap we
// store HEAD + TAIL windows joined by a content-hash marker (not the whole block verbatim, Data
// Model), and `length` carries the FULL block length in UTF-16 units so offsets never desync.
export const MAX_BLOCK_SNIPPET = 8192;
const BLOCK_SNIPPET_WINDOW = 3072; // head + tail window size when capping (head+tail+hash < cap)

/** A tiny, stable, non-crypto content hash (FNV-1a, base36) — the join marker for a capped block
 *  snippet so two long blocks that share a head+tail still differ. PURE + deterministic. */
function blockSnippetHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * pinpoint S-002 (C-002 / AS-006c): cap a block's full text for storage. At or below the cap the
 * snippet is the verbatim text; above it we keep the HEAD + TAIL windows joined by a hash marker so
 * the stored snippet stays bounded (head+tail+hash) while a large/unicode-heavy block can't blow the
 * jsonb. The `length` field (built separately) always carries the FULL UTF-16 length, not the cap.
 */
export function capBlockSnippet(text: string): string {
  if (text.length <= MAX_BLOCK_SNIPPET) return text;
  const head = text.slice(0, BLOCK_SNIPPET_WINDOW);
  const tail = text.slice(text.length - BLOCK_SNIPPET_WINDOW);
  return `${head}…⟨${blockSnippetHash(text)}⟩…${tail}`;
}

/**
 * pinpoint S-002 (C-002): build a WHOLE-block anchor from a picked block element — the Pinpoint
 * counterpart of selectionToAnchor. `textSnippet` is the block's full text content (CAPPED per the
 * Data Model), `offset` is 0, `length` is the block text's UTF-16 code-unit count (the SAME unit the
 * `@anchord/anchor` matcher counts, so an emoji/CJK-heavy block does not desync — AS-006c), and there
 * are NO `segments` (a block is single, not a multi-range). Returns null for an empty / whitespace-
 * only block (`<hr>`, an image-only block, an empty paragraph) so the pick is a NO-OP (AS-006b) —
 * mirroring `buildAnchor`'s empty-text guard server-side.
 */
export function buildBlockAnchor(
  blockId: string,
  element: { textContent: string | null },
): SelectionAnchor | null {
  const full = element.textContent ?? "";
  // AS-006b: an empty / whitespace-only block is not annotatable.
  if (full.trim().length === 0) return null;
  const textSnippet = capBlockSnippet(full);
  // AS-006c: length is the FULL block text's UTF-16 length (String.length / locateRange's unit),
  // even when textSnippet is capped — so offsets stay aligned with the matcher's counting.
  return { blockId, textSnippet, offset: 0, length: full.length, segments: undefined as unknown as SelectionAnchor["segments"] };
}

export interface ComposeApi {
  /** popover position when a valid selection is live (else null → no popover). `centered` means
   *  `left` is the CENTER x of the selection and the popover applies translateX(-50%) (above-
   *  centered, Plannotator center-above, Apache-2.0). */
  popover: { top: number; left: number; centered: boolean } | null;
  /** the active quote when the composer is open (else null → no composer). */
  quote: string | null;
  /** S-003 (C-003): the pre-filled body the composer opens with — "Looks good" for a Like, empty
   *  for a plain Comment. The composer seeds its editable body from this. */
  composeInitialBody: string;
  /** #3 (2026-06-12): the on-screen position for the INLINE composer popover — the same anchor the
   *  selection popover used (above-centered). Non-null only while the composer is open. */
  composerAnchor: { top: number; left: number; centered: boolean } | null;
  /** the optimistic threads created locally and not yet reconciled (lead the rail). */
  optimistic: ViewerAnnotation[];
  /** true while a create write is in flight. */
  pending: boolean;
  startComment: () => void;
  /** S-003 (AS-010): pick Like on the pending selection → open the composer pre-filled "Looks good"
   *  (editable). On send it creates a signal annotation carrying `label="looks-good"` + its root
   *  comment (one labeled-create path, riding the same doc-scoped create as a plain comment). */
  startLike: () => void;
  /** S-004 (AS-012 / C-003): pick a Label preset on the pending selection → open the composer
   *  pre-filled with the preset's display text (editable), carrying `label=<presetId>`. SAME labeled-
   *  create path as Like (#9) — `send` rides the captured label into createAnnotation; the server
   *  validates it ∈ the preset set (AS-014). The picker only ever passes a REAL preset id. */
  startLabel: (presetId: string, presetText: string) => void;
  /** S-002 (AS-004): pick Redline on the pending selection → create a delete-kind suggestion + its
   *  root comment WITHOUT a composer (the strike conveys the proposal). Optimistically shows a red
   *  strike + a DELETE card, then rolls back on a refused/failed write (AS-009/C-007). No-op when no
   *  workspaceId is reachable (the workspace-scoped suggestion route is unreachable). */
  startRedline: () => void;
  dismissPopover: () => void;
  /** S-005: a guest send carries its self-entered name (AS-010, name only — no email AS-017); a
   *  member send omits `guestIdentity`. The name rides to addComment alongside the body — no userId
   *  either way (identity is the session cookie; a guest has none → guestName is its display label). */
  send: (body: string, guestIdentity?: { guestName: string }) => void;
  cancel: () => void;
  /** S-002: open the compose flow from an externally-supplied anchor (the HTML-sandbox bridge
   *  relays the selection over its port — the parent can't read the opaque iframe's selection).
   *  Mirrors the Markdown mouseup path: stash the anchor + raise the popover. The rect is the
   *  selection's viewport rect (RectLike); placePopover does the flip/clamp (MƯỢT TASK 1/3). */
  beginCompose: (anchor: ComposeAnchor, rect?: RectLike | null) => void;
  /** pinpoint S-002 (AS-004 / AS-005 / C-001): a block click in Pinpoint mode opens the SAME 5-type
   *  popover from a SYNTHESIZED whole-block anchor + rect — a block click is NOT a live text selection,
   *  so it bypasses the selection→commit path entirely (which is inert in Pinpoint, S-001). Builds the
   *  whole-block anchor via buildBlockAnchor (offset 0, capped snippet, UTF-16 length); an empty block
   *  returns false and raises nothing (AS-006b). Gated by canCompose (C-004). Returns whether the
   *  popover was raised so the caller knows if the block was pickable (drives the outline lifecycle). */
  beginBlockCompose: (blockId: string, element: { textContent: string | null }, rect?: RectLike | null) => boolean;
  /** MƯỢT TASK 3: reposition the open popover from a fresh selection rect relayed by the iframe
   *  bridge on its in-iframe scroll. No-op when no popover is open. */
  repositionFromRect: (rect: RectLike) => void;
  /** MƯỢT TASK 1: the popover reports its measured size so placePopover can flip/clamp correctly. */
  setPopoverSize: (size: { width: number; height: number }) => void;
  /** S-004 (AS-017): arm a one-shot intercept for the NEXT valid text selection's anchor — used by
   *  re-attach. When armed, the next selection routes its anchor to `handler` (the viewer calls the
   *  reattach route) INSTEAD of raising the create popover, then disarms. Pass `null` to cancel an
   *  armed intercept. Reuses the SAME selection→anchor builder the create path uses (no new path). */
  armSelectionIntercept: (handler: ((anchor: SelectionAnchor) => void) | null) => void;
}

/** The anchor shape `beginCompose` accepts (the bridge's `segments` is optional; we normalize). */
export interface ComposeAnchor {
  blockId: string;
  textSnippet: string;
  offset: number;
  length: number;
  segments?: { blockId: string; textSnippet: string; offset: number; length: number }[];
}

export function useCompose(
  slug: string | undefined,
  docPaneEl: HTMLElement | null,
  canCompose: boolean,
  /** S-002: the doc's workspace (member-only) + current version — required for the workspace-scoped
   *  redline create + its stale pin. Null/undefined → redline is unavailable (startRedline no-ops). */
  redlineCtx: { workspaceId: string | null; version: number } | null,
  /** PERF (no-refetch reconcile): called on a successful create with the REAL annotation built from
   *  the server-returned ids. The screen PREPENDS it into the react-query cache (newest-first) so the
   *  rail re-renders WITHOUT a network reload — replacing the old onSent()→refetch reconcile. */
  onCreatedAnnotation: (real: ViewerAnnotation) => void,
  /** S-002: called after a successful create with the anchor + the real annotation id, so the
   *  screen can relay a highlight DOWN to the in-iframe bridge (the parent can't draw the mark). */
  onCreated?: (anchor: SelectionAnchor, annotationId: string) => void,
  /** annotation-actions-ui S-001 (C-001): the signed-in session user (id + display name). Used to
   *  attribute the optimistic + reconciled created annotation to the REAL author — real name/avatar
   *  shown instantly + `authorId` set so `isOwn` matches without a refetch. Null/undefined for a
   *  signed-out visitor (a guest send carries its own `guestIdentity` instead). */
  currentUser?: { id: string; name: string } | null,
  /** annotation-actions S-006: whether the session can EDIT the doc (owner/editor). A creator with
   *  edit authority has their OWN proposal born ACCEPTED (mirrors the backend createSuggestion
   *  auto-accept), so the optimistic + reconciled redline shows Accepted, not Pending. Commenter →
   *  false → the proposal stays pending awaiting an owner decision. */
  canEditDoc?: boolean,
  /** annotation-create-version-pin S-001 (AS-005): called when a create is refused as STALE (409 —
   *  the doc advanced past the version the viewer rendered). The screen reloads the doc + annotations
   *  and surfaces a "document changed — reloaded" message; `send` itself PRESERVES the user's draft
   *  (re-opens the composer with the same body/anchor) so the annotation is never silently lost. */
  onStaleCreate?: () => void,
  /** S-007 (AS-017): the session guest name when this is a guest session (null/undefined for a
   *  signed-in member). Immediate-create paths that BYPASS the composer — startRedline — attach it to
   *  the create `comment` so a guest suggestion carries its name (the composer `send` gets the name
   *  from its own prop). Without this, a guest redline POSTs no name and the server rejects it. */
  guestName?: string | null,
  /** pinpoint S-001 (AS-002 / C-001): the active input mode (ViewerScreen owns it). In `"pinpoint"`
   *  a text drag-selection is INERT — the mouseup/selectionchange commit path does NOT raise the
   *  create popover (only a block click creates, S-002). In `"select"` (the default) the normal
   *  text-selection→popover→create flow runs. Defaults to "select" so every existing call site keeps
   *  its current behaviour. The gate lives HERE, not in the toolbar — the toolbar only owns the chip. */
  inputMode: "select" | "pinpoint" = "select",
): ComposeApi {
  const [popover, setPopover] = useState<{ top: number; left: number; centered: boolean } | null>(null);
  const [active, setActive] = useState<SelectionAnchor | null>(null);
  const [quote, setQuote] = useState<string | null>(null);
  // S-003 (C-003): the label + pre-filled body for the open composer. A plain Comment leaves both at
  // their resting values (no label, empty body); a Like sets label="looks-good" + body "Looks good".
  // `send` rides `composeLabel` into the createAnnotation body (the one labeled-create path, #9).
  const [composeLabel, setComposeLabel] = useState<string | null>(null);
  const [composeInitialBody, setComposeInitialBody] = useState("");
  // #3: the inline composer popover anchor (the position the selection popover occupied). Kept in
  // sync on scroll/resize the same way the selection popover is, so the composer stays at the text.
  const [composerAnchor, setComposerAnchor] = useState<{ top: number; left: number; centered: boolean } | null>(null);
  const [optimistic, setOptimistic] = useState<ViewerAnnotation[]>([]);
  const [pending, setPending] = useState(false);
  // Hold the anchor the popover was raised for, so Comment uses it even after the DOM selection
  // collapses (a click can clear window.getSelection()).
  const pendingAnchor = useRef<SelectionAnchor | null>(null);
  // pinpoint S-002 (C-002 / AS-005): true while the pending/active anchor is a WHOLE-BLOCK pick (vs a
  // text selection), so the create paths send `type=block` instead of range/multi_range. Set in
  // beginBlockCompose, captured into `activeIsBlock` when the composer opens, and reset by every path
  // that raises a fresh selection popover (commit / beginCompose) or dismisses.
  const pendingIsBlock = useRef(false);
  const [activeIsBlock, setActiveIsBlock] = useState(false);
  // MƯỢT TASK 1: the measured popover size (set by selection-popover via setPopoverSize at render).
  // Falls back to DEFAULT_POPOVER_SIZE until measured (always, under happy-dom).
  const popoverSize = useRef(DEFAULT_POPOVER_SIZE);
  // MƯỢT TASK 1: a getter for the CURRENT selection rect of the live Markdown selection, so the
  // scroll/resize reposition can re-read it. Set when a Markdown selection raises the popover;
  // null for the bridge path (the iframe re-posts its own rect — TASK 3).
  const liveRect = useRef<(() => RectLike | null) | null>(null);
  // S-004 (AS-017): a one-shot intercept for the NEXT valid selection's anchor (re-attach). When set,
  // a committed selection's anchor goes to this handler INSTEAD of raising the create popover, then
  // the ref is cleared (one-shot). Reuses the SAME selectionToAnchor builder as create — no new path.
  const selectionIntercept = useRef<((anchor: SelectionAnchor) => void) | null>(null);
  const armSelectionIntercept = useCallback((handler: ((anchor: SelectionAnchor) => void) | null) => {
    selectionIntercept.current = handler;
  }, []);

  // Compute the on-screen {top,left,centered} for a selection rect via placePopover (above-centered,
  // flip-below, clamp). `centered` rides through so the popover applies translateX(-50%).
  // `prefer` defaults to "above" (the selection quick-popover, tooltip-style); the inline COMPOSER
  // passes "below" so its card drops below the selection (Plannotator-style, Apache-2.0).
  const positionFor = useCallback((rect: RectLike | null, prefer: "above" | "below" = "above") => {
    if (!rect) return { top: 0, left: 0, centered: true };
    const { top, left, centered } = placePopover(rect, popoverSize.current, viewport(), prefer);
    return { top, left, centered };
  }, []);

  const setPopoverSize = useCallback((size: { width: number; height: number }) => {
    if (size.width > 0 && size.height > 0) popoverSize.current = size;
  }, []);

  // C-004: only attach the selection listener for a comment-capable role. A viewer-only role gets
  // no popover (and thus no composer) — the rail stays read-only.
  //
  // MƯỢT TASK 2 (responsive): a fine pointer commits on mouseup. A COARSE pointer (touch) has no
  // reliable mouseup over a drag-select, so on `(pointer: coarse)` we listen to `selectionchange`
  // (debounced ~380ms — adopted from Plannotator's useAnnotationHighlighter touch path) and commit
  // the resulting selection the same way. Both paths funnel through `commit`.
  useEffect(() => {
    if (!canCompose || !docPaneEl) return;
    const doc = docPaneEl.ownerDocument;

    const commit = () => {
      // pinpoint S-001 (AS-002 / C-001): in Pinpoint mode a text drag-selection is INERT — never
      // raise the create popover. Only a block click creates (block-pick is S-002). The mode is the
      // gate (per C-001), and it lives here so the suppression covers BOTH the mouseup and the touch
      // selectionchange path that funnel through commit.
      if (inputMode !== "select") return;
      const sel = doc.getSelection();
      const anchor = selectionToAnchor(sel);
      if (!anchor) {
        // C-003: empty / whitespace-only (or out-of-block) selection → no popover, nothing created.
        return;
      }
      // S-004 (AS-017): a re-attach intercept is armed → route this selection's anchor to it (one-shot)
      // instead of raising the create popover. The viewer calls the reattach route with this anchor.
      if (selectionIntercept.current) {
        const handler = selectionIntercept.current;
        selectionIntercept.current = null;
        handler(anchor);
        return;
      }
      pendingAnchor.current = anchor;
      pendingIsBlock.current = false; // a text selection is a range, not a block pick (C-002).
      // Re-read THIS document's live selection rect on demand so scroll/resize can reposition.
      liveRect.current = () => selectionRect(doc.getSelection());
      // Position via the pure flip/clamp math. happy-dom returns zeros under test (fine — we assert
      // the popover renders + the math, not live pixels). C-005 live placement is [→MANUAL].
      setPopover(positionFor(liveRect.current()));
    };

    const coarse =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches;

    if (coarse) {
      // Touch: debounce selectionchange. A collapsed/empty selection is a no-op (C-003) — commit()
      // already early-returns when selectionToAnchor is null.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onSelectionChange = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(commit, 380);
      };
      doc.addEventListener("selectionchange", onSelectionChange);
      return () => {
        if (timer) clearTimeout(timer);
        doc.removeEventListener("selectionchange", onSelectionChange);
      };
    }

    docPaneEl.addEventListener("mouseup", commit);
    return () => docPaneEl.removeEventListener("mouseup", commit);
    // pinpoint S-001: re-bind when inputMode flips so the commit closure reads the current mode (a
    // Select→Pinpoint switch makes the next drag inert; Pinpoint→Select restores create — AS-002).
  }, [canCompose, docPaneEl, positionFor, inputMode]);

  // MƯỢT TASK 1: while the popover is open, reposition on scroll/resize by re-reading the live
  // selection rect; auto-dismiss when the selection scrolls out of the viewport (closeOnScrollOut —
  // Plannotator AnnotationToolbar). Capture phase + passive so inner scroll containers count and the
  // listener never blocks scrolling. Cleaned up when the popover closes or the hook unmounts.
  useEffect(() => {
    // #3: reposition while EITHER the selection popover OR the inline composer popover is open.
    if (!popover && !composerAnchor) return;
    const reposition = () => {
      const get = liveRect.current;
      if (!get) return; // bridge path re-posts its own rect (TASK 3) — nothing to re-read here.
      const rect = get();
      if (!rect) return;
      // A collapsed / cleared doc selection — e.g. focus moved into the composer textarea (autofocus
      // on open) — yields a zero/origin rect. Re-placing from it would slam the popover to the
      // top-left corner. This ALSO fires when the textarea scrolls its OWN content once the body
      // overflows its rows (the capture-phase scroll listener catches that inner scroll). In both
      // cases there is no real on-screen selection box to follow, so KEEP the current position
      // (the user may also have dragged the card) instead of repositioning to garbage.
      if (rect.top === 0 && rect.left === 0 && rect.bottom === 0 && rect.right === 0) return;
      if (isRectOutOfViewport(rect, viewport())) {
        // Only the floating selection popover auto-dismisses on scroll-out; the composer (the user
        // is mid-typing) stays mounted so an accidental scroll doesn't discard the draft.
        setPopover(null);
        if (!composerAnchor) pendingAnchor.current = null;
        return;
      }
      setPopover((cur) => (cur ? positionFor(rect) : cur));
      // The composer card tracks the selection on the BELOW side (matches its initial placement).
      setComposerAnchor((cur) => (cur ? positionFor(rect, "below") : cur));
    };
    window.addEventListener("scroll", reposition, { capture: true, passive: true });
    window.addEventListener("resize", reposition, { passive: true });
    return () => {
      window.removeEventListener("scroll", reposition, { capture: true } as EventListenerOptions);
      window.removeEventListener("resize", reposition);
    };
  }, [popover, composerAnchor, positionFor]);

  // C-004 gate also applies to the bridge path: a viewer-only role never opens a composer even if a
  // (forged or real) selection arrives over the port. The screen only wires the bridge when
  // canCompose is true, but we re-check here so beginCompose can't be driven for a read-only role.
  const beginCompose = useCallback(
    (anchor: ComposeAnchor, rect?: RectLike | null) => {
      if (!canCompose) return;
      // C-003: an empty / whitespace-only snippet is not a selection — never open the composer.
      if (!anchor || anchor.textSnippet.trim().length === 0) return;
      const normalized: SelectionAnchor = {
        blockId: anchor.blockId,
        textSnippet: anchor.textSnippet,
        offset: anchor.offset,
        length: anchor.length,
        segments: anchor.segments ?? [
          {
            blockId: anchor.blockId,
            textSnippet: anchor.textSnippet,
            offset: anchor.offset,
            length: anchor.length,
          },
        ],
      };
      // S-004 (AS-017): a re-attach intercept armed on the bridge (HTML) path routes the relayed
      // selection's anchor to it (one-shot), mirroring the markdown commit path above.
      if (selectionIntercept.current) {
        const handler = selectionIntercept.current;
        selectionIntercept.current = null;
        handler(normalized);
        return;
      }
      pendingAnchor.current = normalized;
      pendingIsBlock.current = false; // the bridge relays a text selection, not a block pick (C-002).
      // Bridge path: the iframe owns the selection; there's no parent-readable Range to re-read on
      // scroll, so clear liveRect. The iframe re-posts its rect over the port instead (TASK 3).
      liveRect.current = null;
      setPopover(rect ? positionFor(rect) : { top: 0, left: 0, centered: true });
    },
    [canCompose, positionFor],
  );

  // pinpoint S-002 (AS-004/AS-005/C-001): open the 5-type popover for a PICKED BLOCK. A block click
  // is not a live text selection, so this bypasses the selection→commit path (inert in Pinpoint,
  // S-001) and feeds the chooser a SYNTHESIZED whole-block anchor + rect directly. C-004: a viewer-
  // only role never picks (canCompose false → no-op). AS-006b: an empty block builds a null anchor →
  // returns false, raises nothing (the caller never outlines an unpickable block). There is no live
  // Range to re-read on scroll, so liveRect is cleared (the block rect is static for this pick).
  const beginBlockCompose = useCallback(
    (blockId: string, element: { textContent: string | null }, rect?: RectLike | null): boolean => {
      if (!canCompose) return false;
      const anchor = buildBlockAnchor(blockId, element);
      if (!anchor) return false; // AS-006b: empty / whitespace-only block → no popover, no create.
      pendingAnchor.current = anchor;
      pendingIsBlock.current = true; // C-002: the create paths send type=block for this pick.
      liveRect.current = null; // a block pick has no live selection Range to re-read.
      setPopover(rect ? positionFor(rect) : { top: 0, left: 0, centered: true });
      return true;
    },
    [canCompose, positionFor],
  );

  // MƯỢT TASK 3: the iframe bridge relays a fresh selection rect on its own in-iframe scroll (the
  // parent can't see that scroll). Reposition the open popover via the same flip/clamp math.
  const repositionFromRect = useCallback(
    (rect: RectLike) => {
      setPopover((cur) => (cur ? positionFor(rect) : cur));
    },
    [positionFor],
  );

  const dismissPopover = useCallback(() => {
    setPopover(null);
    pendingAnchor.current = null;
    pendingIsBlock.current = false; // C-002: drop the block-pick flag along with the pending anchor.
    liveRect.current = null;
  }, []);

  // Open the inline composer at the pending selection, optionally pre-filled + carrying a label.
  // Shared by Comment (no label, empty body) and Like (label="looks-good", body "Looks good").
  const openComposer = useCallback(
    (opts?: { label?: string; initialBody?: string }) => {
      const anchor = pendingAnchor.current;
      if (!anchor) return;
      setActive(anchor);
      setActiveIsBlock(pendingIsBlock.current); // C-002: carry the block-pick flag into send.
      setQuote(anchor.textSnippet);
      setComposeLabel(opts?.label ?? null);
      setComposeInitialBody(opts?.initialBody ?? "");
      // #3 (2026-06-12): the composer is now an INLINE popover at the selection (not the rail). The
      // composer card prefers BELOW the selection (Plannotator-style, Apache-2.0) — recompute from the
      // live selection rect with prefer:"below" so it drops under the text rather than sitting where
      // the (above) selection popover was. Falls back to the selection popover's spot when no live rect
      // is readable (the iframe bridge path). Then close the selection popover — the composer replaces it.
      const rect = liveRect.current?.() ?? null;
      const below = rect ? positionFor(rect, "below") : (popover ?? { top: 0, left: 0, centered: true });
      setComposerAnchor((prev) => prev ?? below);
      setPopover(null);
    },
    [popover, positionFor],
  );

  const startComment = useCallback(() => openComposer(), [openComposer]);

  // S-003 (AS-010 / C-003): Like opens the composer pre-filled "Looks good" (editable) and stashes
  // the `looks-good` label, which `send` rides into the createAnnotation body — one labeled-create
  // path. The optimistic thread + rollback are the SAME as a comment send (C-007), just carrying the
  // label so the rail renders the 👍 row.
  const startLike = useCallback(
    () => openComposer({ label: LIKE_LABEL, initialBody: LIKE_BODY }),
    [openComposer],
  );

  // S-004 (AS-012 / C-003 / #9): Label opens the composer pre-filled with the CHOSEN preset's text
  // (editable) and stashes the preset id, which `send` rides into the createAnnotation body — the
  // SAME labeled-create path as Like, just a different preset. The optimistic thread + rollback are
  // identical to a comment/Like send (C-007), carrying the label so the rail renders the preset row.
  const startLabel = useCallback(
    (presetId: string, presetText: string) => openComposer({ label: presetId, initialBody: presetText }),
    [openComposer],
  );

  const cancel = useCallback(() => {
    setActive(null);
    setActiveIsBlock(false);
    setQuote(null);
    setComposerAnchor(null);
    setComposeLabel(null);
    setComposeInitialBody("");
  }, []);

  // S-002 (AS-004 / AS-009 / C-002 / C-007): Redline the pending selection. UNLIKE Comment, there is
  // NO composer step — the strike itself conveys the deletion proposal (Data Model: redline root body
  // is empty), so picking Redline creates immediately. We optimistically show a red strike + a DELETE
  // card, then POST the delete-kind suggestion → attach its root comment. On a refused/failed write we
  // roll BOTH the optimistic strike + card back (no ghost) and toast. The redline create is workspace-
  // scoped (the only suggestion route), so it no-ops without a reachable workspaceId.
  const startRedline = useCallback(() => {
    const anchor = pendingAnchor.current;
    if (!anchor) return;
    // pinpoint S-002 (C-002): a redline on a picked block creates type=block; else range/multi_range.
    const redlineType: "range" | "multi_range" | "block" = pendingIsBlock.current
      ? "block"
      : anchor.segments && anchor.segments.length > 1
        ? "multi_range"
        : "range";
    if (!slug || redlineCtx == null) {
      // No version pin reachable (no doc context) → can't pin `againstVersion`. Close the popover;
      // don't create a ghost that can never persist. (C-018: the redline now rides the doc-addressed
      // unified create, so it no longer needs a workspaceId — only the version to pin against.)
      setPopover(null);
      pendingAnchor.current = null;
      return;
    }
    const tempId = `optimistic-${++optimisticSeq}`;
    const createdAt = new Date().toISOString();
    // A redline is a signed-in member action (no guest path) → attribute it to the REAL session
    // author + durable authorId so it reads as own immediately (the owner-decide gate keys on this).
    const author = optimisticAuthor(currentUser, guestName ? { guestName } : undefined);
    // annotation-actions S-006: a creator who can EDIT the doc has their own proposal born ACCEPTED
    // (mirrors the backend createSuggestion auto-accept); a commenter's stays pending. Used for BOTH
    // the optimistic temp and the no-refetch reconciled real row so neither flashes Pending.
    const bornStatus = canEditDoc ? "accepted" : "pending";
    // The optimistic redline thread: type=suggestion + kind=delete + pending status, with its root
    // comment. The rail renders the DELETE card; the mark renders the red strike (kind=redline).
    const optimisticRedline: ViewerAnnotation = {
      id: tempId,
      ...(author.authorId ? { authorId: author.authorId } : {}),
      // The rail/decide logic keys on type=suggestion (the redline lifecycle); the BLOCK vs range
      // distinction rides the create request's `type` (redlineType) — the server derives suggestion.
      type: "suggestion",
      status: "unresolved",
      isOrphaned: false,
      anchor: {
        blockId: anchor.blockId,
        textSnippet: anchor.textSnippet,
        offset: anchor.offset,
        length: anchor.length,
        segments: anchor.segments,
      },
      suggestion: { kind: "delete", from: anchor.textSnippet, againstVersion: redlineCtx.version },
      suggestionStatus: bornStatus,
      comments: [
        {
          id: `${tempId}-c`,
          parentId: null,
          ...author.comment,
          // C-003: every annotation has a root comment. Redline's default is the deletion intent; the
          // backend rejects an empty body, so a concise non-empty default stands in (S3 guard).
          body: REDLINE_ROOT_BODY,
          createdAt,
        },
      ],
    };

    setOptimistic((prev) => [optimisticRedline, ...prev]);
    if (docPaneEl) {
      placeAnnotations(docPaneEl, [
        {
          id: tempId,
          anchor: { blockId: anchor.blockId, textSnippet: anchor.textSnippet, offset: anchor.offset, length: anchor.length },
          kind: "redline",
        },
      ]);
    }
    setPopover(null);
    pendingAnchor.current = null;
    setPending(true);

    const clearOptimistic = () => {
      setOptimistic((prev) => prev.filter((a) => a.id !== tempId));
      if (docPaneEl) {
        const mark = docPaneEl.querySelector<HTMLElement>(`[data-anno="${tempId}"]`);
        if (mark?.parentNode) {
          const parent = mark.parentNode;
          while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
          parent.removeChild(mark);
          parent.normalize?.();
        }
      }
    };
    const rollback = () => {
      // C-007/AS-009: remove the optimistic strike + card; no ghost mark remains.
      clearOptimistic();
      toast.error("Couldn't create your redline");
    };

    void (async () => {
      try {
        // C-018: ONE atomic doc-addressed create — the suggestion annotation AND its root comment
        // persist together (the standalone workspace-scoped suggestion route is subsumed). Omit `to`
        // → the server records kind=delete; the root body rides `comment` (no second addComment).
        const created = await createAnnotation(slug, {
          // The request `type` is the ANCHOR shape — the server DERIVES type="suggestion" from the
          // `suggestion` payload (createAnnotationSchema rejects type:"suggestion"). A single-segment
          // selection is a range; a cross-block one is multi_range; a Pinpoint block pick is block.
          type: redlineType,
          anchor: {
            blockId: anchor.blockId,
            textSnippet: anchor.textSnippet,
            offset: anchor.offset,
            length: anchor.length,
            segments: anchor.segments,
          },
          suggestion: { from: anchor.textSnippet, againstVersion: redlineCtx.version },
          // S-007 (AS-017): a guest redline carries the session name (else the server rejects the
          // anon write with "guestName is required"); a member omits it (identity is the session).
          comment: { body: REDLINE_ROOT_BODY, ...(guestName ? { guestName } : {}) },
        });
        if (created.error || !created.data) {
          rollback();
          return;
        }
        const annotationId = peelId(created.data);
        const real: ViewerAnnotation = {
          id: annotationId,
          ...(author.authorId ? { authorId: author.authorId } : {}),
          type: "suggestion",
          status: "unresolved",
          isOrphaned: false,
          anchor: {
            blockId: anchor.blockId,
            textSnippet: anchor.textSnippet,
            offset: anchor.offset,
            length: anchor.length,
            segments: anchor.segments,
          },
          suggestion: { kind: "delete", from: anchor.textSnippet, againstVersion: redlineCtx.version },
          suggestionStatus: bornStatus,
          comments: [
            { id: peelCommentId(created.data), parentId: null, ...author.comment, body: REDLINE_ROOT_BODY, createdAt },
          ],
        };
        onCreatedAnnotation(real);
        clearOptimistic();
      } catch {
        rollback();
      } finally {
        setPending(false);
      }
    })();
  }, [slug, docPaneEl, redlineCtx, onCreatedAnnotation, currentUser?.id, currentUser?.name, canEditDoc, guestName]);

  const send = useCallback(
    (body: string, guestIdentity?: { guestName: string }) => {
      const anchor = active;
      if (!anchor || !slug || body.trim().length === 0) return;
      // S-003 (C-003): capture the label for THIS send (Like → "looks-good", Comment → none). Carried
      // into both the optimistic thread (so the rail renders the 👍 row immediately) and the real
      // createAnnotation body (the one labeled-create path). The server validates it ∈ the preset set.
      const label = composeLabel ?? undefined;
      // S-005: a guest send with no name is a no-op write (the composer already gates Send on a
      // non-empty name — AS-011 — but re-check here so a forced call can't post an unnamed guest).
      if (guestIdentity && guestIdentity.guestName.trim().length === 0) return;

      const tempId = `optimistic-${++optimisticSeq}`;
      // Capture ONE ISO time so the optimistic comment and the reconciled real row share it (no
      // visible timestamp jump when the temp is swapped for the real cache row).
      const createdAt = new Date().toISOString();
      // The author attribution is shared by the optimistic temp AND the reconciled real row: a
      // guest's self-entered name (C-010), or — for a signed-in member — the REAL session name +
      // durable authorId, so the rail shows the real name/avatar immediately and `isOwn` matches
      // without a refetch (the "You" placeholder bug). optimisticAuthor owns the precedence.
      const author = optimisticAuthor(currentUser, guestIdentity);
      const attribution = author.comment;
      // pinpoint S-002 (C-002): a block pick creates type=block; a text selection a range/multi_range.
      const createType: "range" | "multi_range" | "block" = activeIsBlock
        ? "block"
        : anchor.segments && anchor.segments.length > 1
          ? "multi_range"
          : "range";
      const optimisticThread: ViewerAnnotation = {
        id: tempId,
        type: createType,
        status: "unresolved",
        isOrphaned: false,
        // C-001: carry the durable authorId so the just-created thread reads as OWN immediately (the
        // no-self-approve gate + own controls), not as a guest until a refetch. Absent for a guest.
        ...(author.authorId ? { authorId: author.authorId } : {}),
        // S-003 (AS-010 / AS-011): a Like carries the label optimistically so the rail shows the 👍
        // "Looks good" row instantly; if the write is refused, the whole optimistic thread (label row
        // included) is rolled back (C-007). A plain comment has no label.
        ...(label ? { label } : {}),
        anchor: {
          blockId: anchor.blockId,
          textSnippet: anchor.textSnippet,
          offset: anchor.offset,
          length: anchor.length,
          segments: anchor.segments,
        },
        comments: [
          {
            id: `${tempId}-c`,
            parentId: null,
            // S-005: a guest's optimistic comment is attributed to its self-entered name (C-010);
            // a member's is "You". Either way it renders inert via ThreadCard (C-008).
            ...attribution,
            body, // inert plaintext when rendered by ThreadCard (C-008)
            createdAt,
          },
        ],
      };

      // AS-001 / C-011: optimistic — show the thread + highlight immediately. The thread leads the
      // rail (prepended by the screen); place a highlight on the selected text right away.
      setOptimistic((prev) => [optimisticThread, ...prev]);
      if (docPaneEl) {
        placeAnnotations(docPaneEl, [
          { id: tempId, anchor: { blockId: anchor.blockId, textSnippet: anchor.textSnippet, offset: anchor.offset, length: anchor.length } },
        ]);
      }
      // S-001 (AS-005): snapshot the draft (anchor + quote + composer anchor + label + body) BEFORE
      // clearing, so a STALE refusal can re-open the SAME composer with the user's text intact — the
      // annotation is never silently lost on a "document changed" reload.
      const draftQuote = quote;
      const draftComposerAnchor = composerAnchor;
      const draftLabel = composeLabel;
      const restoreDraft = () => {
        setActive(anchor);
        setQuote(draftQuote);
        setComposerAnchor(draftComposerAnchor);
        setComposeLabel(draftLabel);
        setComposeInitialBody(body);
      };

      setActive(null);
      setQuote(null);
      setComposerAnchor(null); // #3: close the inline composer popover on send.
      setComposeLabel(null); // S-003: reset for the next compose (the label was captured above).
      setComposeInitialBody("");
      setPending(true);

      // Drop the optimistic temp thread + unwrap its highlight mark. Shared by the success reconcile
      // (the real cache row becomes the single source of truth) and the failure rollback.
      const clearOptimistic = () => {
        setOptimistic((prev) => prev.filter((a) => a.id !== tempId));
        if (docPaneEl) {
          const mark = docPaneEl.querySelector<HTMLElement>(`[data-anno="${tempId}"]`);
          if (mark?.parentNode) {
            const parent = mark.parentNode;
            while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
            parent.removeChild(mark);
            parent.normalize?.();
          }
        }
      };

      const rollback = () => {
        // C-011: remove the optimistic thread + its highlight; no ghost thread left behind.
        clearOptimistic();
        toast.error("Couldn't save your comment");
      };

      void (async () => {
        try {
          // C-018: ONE atomic request — the annotation AND its first comment are created together
          // server-side (a failure of either rolls BOTH back, no orphan). There is no longer a
          // second addComment call to compensate for, so the old create-then-comment rollback
          // branch is gone — a refused create simply rolls the optimistic thread back.
          const created = await createAnnotation(slug, {
            // pinpoint S-002 (C-002): type=block for a whole-block pick (offset 0, capped snippet),
            // else the range/multi_range shape — the server stores the anchor verbatim either way.
            type: createType,
            anchor: {
              blockId: anchor.blockId,
              textSnippet: anchor.textSnippet,
              offset: anchor.offset,
              length: anchor.length,
              segments: anchor.segments,
            },
            // S-003 (C-003 / #9): a Like rides the SAME doc-scoped create as a comment, carrying the
            // label; the server validates it ∈ the preset set (AS-014 server-side). Omitted for a comment.
            ...(label ? { label } : {}),
            // C-018: the first comment rides the create. S-005 (AS-010): a guest posts under its
            // self-entered name (name only — no email, AS-017); a member posts body-only (identity = session cookie).
            comment: {
              body,
              ...(guestIdentity ? { guestName: guestIdentity.guestName } : {}),
            },
            // annotation-create-version-pin S-001 (AS-005): pin the create to the version the viewer
            // RENDERED. If an agent advanced the doc since, the server 409s and we keep the draft +
            // reload (the staleRefusal branch below) instead of silently anchoring against new content.
            ...(redlineCtx ? { expectedVersion: redlineCtx.version } : {}),
          });
          if (created.error || !created.data) {
            // S-001 (AS-005 / C-002): a 409 means the doc changed — the server refused the create and
            // returned its current version. Reload doc + annotations, KEEP the draft (re-open the
            // composer with the same body/anchor), and surface the message — never a silent loss.
            if (isStaleConflict(created.error)) {
              clearOptimistic(); // drop the optimistic temp; the reload brings the real (newer) state.
              restoreDraft();
              onStaleCreate?.();
              return;
            }
            rollback();
            return;
          }
          const annotationId = peelId(created.data);
          // Success: reconcile WITHOUT a refetch. Build the REAL annotation from the server-returned
          // ids (reusing the optimistic anchor + body + createdAt + attribution) and PREPEND it into
          // the react-query cache (newest-first). Then clear the optimistic temp thread + its
          // highlight mark — so the real row is the SINGLE source of truth (no double render, no
          // double-count, no stale temp mark double-wrapping the same range). The real row's mark is
          // placed by the existing useAnnotationMarks effect when the annotations array changes.
          const real: ViewerAnnotation = {
            id: annotationId,
            type: createType,
            status: "unresolved",
            isOrphaned: false,
            // C-001: same durable authorId as the optimistic temp so the reconciled (no-refetch) row
            // keeps reading as OWN with the real name/avatar — no flip to guest/"You" on reconcile.
            ...(author.authorId ? { authorId: author.authorId } : {}),
            // S-003: preserve the label on the reconciled real row so the rail keeps the 👍 row after
            // the optimistic temp is swapped out (no flicker of the label line).
            ...(label ? { label } : {}),
            anchor: {
              blockId: anchor.blockId,
              textSnippet: anchor.textSnippet,
              offset: anchor.offset,
              length: anchor.length,
              segments: anchor.segments,
            },
            comments: [
              {
                id: peelCommentId(created.data),
                parentId: null,
                ...attribution,
                body,
                createdAt,
              },
            ],
          };
          onCreatedAnnotation(real);
          clearOptimistic();
          // S-002: relay the real highlight DOWN to the in-iframe bridge (HTML docs). For a
          // Markdown doc onCreated is undefined — the highlight is the real row's mark instead.
          onCreated?.(anchor, annotationId);
        } catch {
          // network failure (C-011/AS-013).
          rollback();
        } finally {
          setPending(false);
        }
      })();
    },
    [active, activeIsBlock, slug, docPaneEl, composeLabel, quote, composerAnchor, redlineCtx, onCreatedAnnotation, onCreated, onStaleCreate, currentUser?.id, currentUser?.name],
  );

  return {
    popover,
    quote,
    composeInitialBody,
    composerAnchor,
    optimistic,
    pending,
    startComment,
    startLike,
    startLabel,
    startRedline,
    dismissPopover,
    send,
    cancel,
    beginCompose,
    beginBlockCompose,
    repositionFromRect,
    setPopoverSize,
    armSelectionIntercept,
  };
}

// annotation-create-version-pin S-001 (AS-005 / C-002): a create refused as STALE comes back 409
// (the server's ConflictError — the doc advanced past the rendered version). The Eden error is
// `unknown` at the type layer; read its status defensively (mirrors the redline-decide 409 check).
function isStaleConflict(error: unknown): boolean {
  return (error as { status?: number } | null)?.status === 409;
}

// The create result is `{ annotationId }`, but useApiQuery's peel runs on READS; the write thunks
// return treaty's raw `{ data, error }`. The success envelope wraps the payload, so the id can sit
// at `.annotationId` or `.data.annotationId` depending on whether the envelope is peeled — accept
// both shapes defensively.
function peelId(data: unknown): string {
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (typeof obj.annotationId === "string") return obj.annotationId;
    const inner = obj.data;
    if (inner && typeof inner === "object" && typeof (inner as Record<string, unknown>).annotationId === "string") {
      return (inner as Record<string, string>).annotationId;
    }
  }
  return "";
}

// Same envelope-defensive peel for the comment create result (`{ commentId }` possibly wrapped in
// the success envelope). The real id is needed so the prepended cache comment carries the server id
// (a later genuine read then matches it — no duplicate).
export function peelCommentId(data: unknown): string {
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (typeof obj.commentId === "string") return obj.commentId;
    const inner = obj.data;
    if (inner && typeof inner === "object" && typeof (inner as Record<string, unknown>).commentId === "string") {
      return (inner as Record<string, string>).commentId;
    }
  }
  return "";
}
