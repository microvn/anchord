import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { createAnnotation, addComment, type ViewerAnnotation } from "./client";
import { selectionToAnchor, type SelectionAnchor } from "./selection-anchor";
import { placeAnnotations } from "./annotation-marks";

// useCompose (S-001): the comment WRITE flow for a Markdown doc, lifted out of viewer-screen so the
// shell module stays focused. Owns: selection capture → popover → composer → optimistic create.
//
//   1. SELECTION (C-003/C-004): on mouseup over the doc pane, if the role may compose AND the
//      selection covers real characters inside a data-block-id block (selectionToAnchor != null),
//      show the popover. A viewer-only role (canCompose=false) never attaches the listener, so it
//      gets no popover/composer — a read-only rail.
//   2. COMPOSE: Comment in the popover opens the composer prefilled with the quote.
//   3. SEND (AS-001 + C-011): optimistically prepend a thread + place its highlight, then
//      POST annotation → POST comment. On success keep it (a refetch reconciles). On a refused /
//      failed write, ROLL BACK — remove the optimistic thread + highlight — and toast an error.

let optimisticSeq = 0;

export interface ComposeApi {
  /** popover position when a valid selection is live (else null → no popover). */
  popover: { top: number; left: number } | null;
  /** the active quote when the composer is open (else null → no composer). */
  quote: string | null;
  /** the optimistic threads created locally and not yet reconciled (lead the rail). */
  optimistic: ViewerAnnotation[];
  /** true while a create write is in flight. */
  pending: boolean;
  startComment: () => void;
  dismissPopover: () => void;
  send: (body: string) => void;
  cancel: () => void;
  /** S-002: open the compose flow from an externally-supplied anchor (the HTML-sandbox bridge
   *  relays the selection over its port — the parent can't read the opaque iframe's selection).
   *  Mirrors the Markdown mouseup path: stash the anchor + raise the popover. */
  beginCompose: (anchor: ComposeAnchor, rect?: { top: number; left: number } | null) => void;
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
  onSent: () => void,
  /** S-002: called after a successful create with the anchor + the real annotation id, so the
   *  screen can relay a highlight DOWN to the in-iframe bridge (the parent can't draw the mark). */
  onCreated?: (anchor: SelectionAnchor, annotationId: string) => void,
): ComposeApi {
  const [popover, setPopover] = useState<{ top: number; left: number } | null>(null);
  const [active, setActive] = useState<SelectionAnchor | null>(null);
  const [quote, setQuote] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<ViewerAnnotation[]>([]);
  const [pending, setPending] = useState(false);
  // Hold the anchor the popover was raised for, so Comment uses it even after the DOM selection
  // collapses (a click can clear window.getSelection()).
  const pendingAnchor = useRef<SelectionAnchor | null>(null);

  // C-004: only attach the selection listener for a comment-capable role. A viewer-only role gets
  // no popover (and thus no composer) — the rail stays read-only.
  useEffect(() => {
    if (!canCompose || !docPaneEl) return;
    const onMouseUp = () => {
      const sel = docPaneEl.ownerDocument.getSelection();
      const anchor = selectionToAnchor(sel);
      if (!anchor) {
        // C-003: empty / whitespace-only (or out-of-block) selection → no popover, nothing created.
        return;
      }
      pendingAnchor.current = anchor;
      // Position from the selection rect; happy-dom returns zeros under test (fine — we only assert
      // the popover renders, not pixels). C-005 visual placement is [→MANUAL] + Playwright.
      let rect = { top: 0, left: 0 };
      if (sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0).getBoundingClientRect?.();
        if (r) rect = { top: r.bottom, left: r.left };
      }
      setPopover(rect);
    };
    docPaneEl.addEventListener("mouseup", onMouseUp);
    return () => docPaneEl.removeEventListener("mouseup", onMouseUp);
  }, [canCompose, docPaneEl]);

  // C-004 gate also applies to the bridge path: a viewer-only role never opens a composer even if a
  // (forged or real) selection arrives over the port. The screen only wires the bridge when
  // canCompose is true, but we re-check here so beginCompose can't be driven for a read-only role.
  const beginCompose = useCallback(
    (anchor: ComposeAnchor, rect?: { top: number; left: number } | null) => {
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
      setPopover(rect ?? { top: 0, left: 0 });
    },
    [canCompose],
  );

  const dismissPopover = useCallback(() => {
    setPopover(null);
    pendingAnchor.current = null;
  }, []);

  const startComment = useCallback(() => {
    const anchor = pendingAnchor.current;
    if (!anchor) return;
    setActive(anchor);
    setQuote(anchor.textSnippet);
    setPopover(null);
  }, []);

  const cancel = useCallback(() => {
    setActive(null);
    setQuote(null);
  }, []);

  const send = useCallback(
    (body: string) => {
      const anchor = active;
      if (!anchor || !workspaceId || !slug || body.trim().length === 0) return;

      const tempId = `optimistic-${++optimisticSeq}`;
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
            authorName: "You",
            body, // inert plaintext when rendered by ThreadCard (C-008)
            createdAt: new Date().toISOString(),
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
      setPending(true);

      // Drop the optimistic temp thread + unwrap its highlight mark. Shared by the success reconcile
      // (the real refetched row becomes the single source of truth) and the failure rollback.
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
          const commented = await addComment(workspaceId, slug, annotationId, { body });
          if (commented.error) {
            rollback();
            return;
          }
          // Success: reconcile. Clear the optimistic temp thread + its highlight mark so the
          // refetched real row is the SINGLE source of truth — otherwise the comment renders twice
          // (optimistic + real), the rail count double-counts, and the stale temp mark can collide
          // / double-wrap the same range as the real annotation's mark. onSent() refetches the real row.
          clearOptimistic();
          // S-002: relay the real highlight DOWN to the in-iframe bridge (HTML docs). For a
          // Markdown doc onCreated is undefined — the highlight is the refetched row's mark instead.
          onCreated?.(anchor, annotationId);
          onSent();
        } catch {
          // network failure (C-011/AS-013).
          rollback();
        } finally {
          setPending(false);
        }
      })();
    },
    [active, workspaceId, slug, docPaneEl, onSent, onCreated],
  );

  return { popover, quote, optimistic, pending, startComment, dismissPopover, send, cancel, beginCompose };
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
