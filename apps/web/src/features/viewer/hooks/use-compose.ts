import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { createAnnotation, addComment, type ViewerAnnotation } from "@/features/viewer/client";
import { selectionToAnchor, type SelectionAnchor } from "@/features/viewer/selection-anchor";
import { placeAnnotations } from "@/features/viewer/components/annotation-marks";
import { placePopover, isRectOutOfViewport, type RectLike } from "@/features/viewer/place-popover";

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

export interface ComposeApi {
  /** popover position when a valid selection is live (else null → no popover). `centered` means
   *  `left` is the CENTER x of the selection and the popover applies translateX(-50%) (above-
   *  centered, Plannotator center-above, Apache-2.0). */
  popover: { top: number; left: number; centered: boolean } | null;
  /** the active quote when the composer is open (else null → no composer). */
  quote: string | null;
  /** #3 (2026-06-12): the on-screen position for the INLINE composer popover — the same anchor the
   *  selection popover used (above-centered). Non-null only while the composer is open. */
  composerAnchor: { top: number; left: number; centered: boolean } | null;
  /** the optimistic threads created locally and not yet reconciled (lead the rail). */
  optimistic: ViewerAnnotation[];
  /** true while a create write is in flight. */
  pending: boolean;
  startComment: () => void;
  dismissPopover: () => void;
  /** S-005: a guest send carries its self-entered name + optional email (AS-010); a member send
   *  omits `guestIdentity`. The fields ride to addComment alongside the body — no userId either way
   *  (identity is the session cookie; a guest has none → guestName is its display label, C-010). */
  send: (body: string, guestIdentity?: { guestName: string; guestEmail?: string }) => void;
  cancel: () => void;
  /** S-002: open the compose flow from an externally-supplied anchor (the HTML-sandbox bridge
   *  relays the selection over its port — the parent can't read the opaque iframe's selection).
   *  Mirrors the Markdown mouseup path: stash the anchor + raise the popover. The rect is the
   *  selection's viewport rect (RectLike); placePopover does the flip/clamp (MƯỢT TASK 1/3). */
  beginCompose: (anchor: ComposeAnchor, rect?: RectLike | null) => void;
  /** MƯỢT TASK 3: reposition the open popover from a fresh selection rect relayed by the iframe
   *  bridge on its in-iframe scroll. No-op when no popover is open. */
  repositionFromRect: (rect: RectLike) => void;
  /** MƯỢT TASK 1: the popover reports its measured size so placePopover can flip/clamp correctly. */
  setPopoverSize: (size: { width: number; height: number }) => void;
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
  workspaceId: string | undefined,
  slug: string | undefined,
  docPaneEl: HTMLElement | null,
  canCompose: boolean,
  /** PERF (no-refetch reconcile): called on a successful create with the REAL annotation built from
   *  the server-returned ids. The screen PREPENDS it into the react-query cache (newest-first) so the
   *  rail re-renders WITHOUT a network reload — replacing the old onSent()→refetch reconcile. */
  onCreatedAnnotation: (real: ViewerAnnotation) => void,
  /** S-002: called after a successful create with the anchor + the real annotation id, so the
   *  screen can relay a highlight DOWN to the in-iframe bridge (the parent can't draw the mark). */
  onCreated?: (anchor: SelectionAnchor, annotationId: string) => void,
): ComposeApi {
  const [popover, setPopover] = useState<{ top: number; left: number; centered: boolean } | null>(null);
  const [active, setActive] = useState<SelectionAnchor | null>(null);
  const [quote, setQuote] = useState<string | null>(null);
  // #3: the inline composer popover anchor (the position the selection popover occupied). Kept in
  // sync on scroll/resize the same way the selection popover is, so the composer stays at the text.
  const [composerAnchor, setComposerAnchor] = useState<{ top: number; left: number; centered: boolean } | null>(null);
  const [optimistic, setOptimistic] = useState<ViewerAnnotation[]>([]);
  const [pending, setPending] = useState(false);
  // Hold the anchor the popover was raised for, so Comment uses it even after the DOM selection
  // collapses (a click can clear window.getSelection()).
  const pendingAnchor = useRef<SelectionAnchor | null>(null);
  // MƯỢT TASK 1: the measured popover size (set by selection-popover via setPopoverSize at render).
  // Falls back to DEFAULT_POPOVER_SIZE until measured (always, under happy-dom).
  const popoverSize = useRef(DEFAULT_POPOVER_SIZE);
  // MƯỢT TASK 1: a getter for the CURRENT selection rect of the live Markdown selection, so the
  // scroll/resize reposition can re-read it. Set when a Markdown selection raises the popover;
  // null for the bridge path (the iframe re-posts its own rect — TASK 3).
  const liveRect = useRef<(() => RectLike | null) | null>(null);

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
      const sel = doc.getSelection();
      const anchor = selectionToAnchor(sel);
      if (!anchor) {
        // C-003: empty / whitespace-only (or out-of-block) selection → no popover, nothing created.
        return;
      }
      pendingAnchor.current = anchor;
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
  }, [canCompose, docPaneEl, positionFor]);

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
      pendingAnchor.current = normalized;
      // Bridge path: the iframe owns the selection; there's no parent-readable Range to re-read on
      // scroll, so clear liveRect. The iframe re-posts its rect over the port instead (TASK 3).
      liveRect.current = null;
      setPopover(rect ? positionFor(rect) : { top: 0, left: 0, centered: true });
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
    liveRect.current = null;
  }, []);

  const startComment = useCallback(() => {
    const anchor = pendingAnchor.current;
    if (!anchor) return;
    setActive(anchor);
    setQuote(anchor.textSnippet);
    // #3 (2026-06-12): the composer is now an INLINE popover at the selection (not the rail). The
    // composer card prefers BELOW the selection (Plannotator-style, Apache-2.0) — recompute from the
    // live selection rect with prefer:"below" so it drops under the text rather than sitting where
    // the (above) selection popover was. Falls back to the selection popover's spot when no live rect
    // is readable (the iframe bridge path). Then close the selection popover — the composer replaces it.
    const rect = liveRect.current?.() ?? null;
    const below = rect ? positionFor(rect, "below") : (popover ?? { top: 0, left: 0, centered: true });
    setComposerAnchor((prev) => prev ?? below);
    setPopover(null);
  }, [popover, positionFor]);

  const cancel = useCallback(() => {
    setActive(null);
    setQuote(null);
    setComposerAnchor(null);
  }, []);

  const send = useCallback(
    (body: string, guestIdentity?: { guestName: string; guestEmail?: string }) => {
      const anchor = active;
      if (!anchor || !workspaceId || !slug || body.trim().length === 0) return;
      // S-005: a guest send with no name is a no-op write (the composer already gates Send on a
      // non-empty name — AS-011 — but re-check here so a forced call can't post an unnamed guest).
      if (guestIdentity && guestIdentity.guestName.trim().length === 0) return;

      const tempId = `optimistic-${++optimisticSeq}`;
      // Capture ONE ISO time so the optimistic comment and the reconciled real row share it (no
      // visible timestamp jump when the temp is swapped for the real cache row).
      const createdAt = new Date().toISOString();
      // The author attribution is shared by the optimistic temp AND the reconciled real row: a
      // guest's self-entered name (C-010) or "You" for a member. NOTE: "You" is a placeholder — the
      // server's real display name only lands on a later genuine read; acceptable for the local echo.
      const attribution = guestIdentity
        ? { guestName: guestIdentity.guestName }
        : { authorName: "You" };
      const optimisticThread: ViewerAnnotation = {
        id: tempId,
        type: "range",
        status: "unresolved",
        isOrphaned: false,
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
      setActive(null);
      setQuote(null);
      setComposerAnchor(null); // #3: close the inline composer popover on send.
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
          const created = await createAnnotation(workspaceId, slug, {
            type: "range",
            anchor: {
              blockId: anchor.blockId,
              textSnippet: anchor.textSnippet,
              offset: anchor.offset,
              length: anchor.length,
              segments: anchor.segments,
            },
          });
          if (created.error || !created.data) {
            rollback();
            return;
          }
          const annotationId = peelId(created.data);
          const commented = await addComment(workspaceId, slug, annotationId, {
            body,
            // S-005 (AS-010): a guest comment posts under its self-entered name + optional email;
            // a member posts body-only (identity rides the session cookie, no userId in the body).
            ...(guestIdentity
              ? {
                  guestName: guestIdentity.guestName,
                  ...(guestIdentity.guestEmail ? { guestEmail: guestIdentity.guestEmail } : {}),
                }
              : {}),
          });
          if (commented.error) {
            rollback();
            return;
          }
          // Success: reconcile WITHOUT a refetch. Build the REAL annotation from the server-returned
          // ids (reusing the optimistic anchor + body + createdAt + attribution) and PREPEND it into
          // the react-query cache (newest-first). Then clear the optimistic temp thread + its
          // highlight mark — so the real row is the SINGLE source of truth (no double render, no
          // double-count, no stale temp mark double-wrapping the same range). The real row's mark is
          // placed by the existing useAnnotationMarks effect when the annotations array changes.
          const real: ViewerAnnotation = {
            id: annotationId,
            type: "range",
            status: "unresolved",
            isOrphaned: false,
            anchor: {
              blockId: anchor.blockId,
              textSnippet: anchor.textSnippet,
              offset: anchor.offset,
              length: anchor.length,
              segments: anchor.segments,
            },
            comments: [
              {
                id: peelCommentId(commented.data),
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
    [active, workspaceId, slug, docPaneEl, onCreatedAnnotation, onCreated],
  );

  return {
    popover,
    quote,
    composerAnchor,
    optimistic,
    pending,
    startComment,
    dismissPopover,
    send,
    cancel,
    beginCompose,
    repositionFromRect,
    setPopoverSize,
  };
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
