import { useEffect, useRef } from "react";
import { Icon } from "@/components/icon";
import { useDismissOnOutsideAndEscape } from "@/features/viewer/hooks/use-dismiss";

// SelectionPopover (S-001 — annotation-core-ui-types-modes): the floating Markup popover that
// appears over a live text selection on a rendered Markdown doc. Mirrors the prototype `viewer.jsx`
// SelectionPopover. It is the SINGLE entry that maps a selection to one create path: the chosen
// action sets the annotation `type`/`label`. It offers the five annotation types
// Comment · Like · Label · Redline · Suggest (+ Dismiss).
//
// SCOPE (S-001): this surface only DISPATCHES the chosen intent — Comment keeps its own dedicated
// `onComment` seam (the built commenting create path); Like/Label/Redline/Suggest fire `onSelectType`
// with the type, which the later stories (S-002 Redline / S-003 Like / S-004 Label, and the suggest-
// image sibling for Suggest) consume to open the labeled-create / picker / redline paths. This file
// does NOT build the LabelPicker, the redline strike, or any client create call.
//
// C-001 gate is upstream (the viewer only mounts this for a comment-capable role); C-003/C-008 are
// also upstream (the viewer only sets a selection when selectionToAnchor returned a real block-scoped
// range). So this component is a pure presentational affordance — if it's rendered, the selection is
// real and the role may comment; clicking a type dispatches an intent, it never touches the anchor.
//
// MƯỢT TASK 1: on mount/update the popover MEASURES itself (getBoundingClientRect) and reports its
// size up via `onMeasure`, so use-compose's placePopover can flip/clamp against the real width/height
// (happy-dom returns 0 — the hook falls back to a default size). `rect` is the ALREADY-positioned
// {top,left} from placePopover; this component just renders at it.
//
// MƯỢT TASK 4: outside-click + Escape dismiss via useDismissOnOutsideAndEscape (the multi-click guard
// keeps a triple-click paragraph selection alive — adopted from Plannotator, Apache-2.0).

/** The Markup types this popover dispatches via `onSelectType` (Comment rides its own `onComment`
 *  seam). The chosen action sets the annotation `type`/`label` downstream (S-002/S-003/S-004). */
export type MarkupType = "like" | "label" | "redline" | "suggest";

export function SelectionPopover({
  rect,
  onComment,
  onSelectType,
  onDismiss,
  onMeasure,
}: {
  /** the already-positioned {top,left,centered} (placePopover output). When `centered`, `left` is
   *  the CENTER x of the selection → apply translateX(-50%) (above-centered, Plannotator). */
  rect: { top: number; left: number; centered?: boolean };
  /** Comment keeps its dedicated handler — the built commenting create path (not a type intent). */
  onComment: () => void;
  /** Like/Label/Redline/Suggest dispatch the chosen type intent for the later create paths to consume. */
  onSelectType?: (type: MarkupType) => void;
  onDismiss: () => void;
  /** MƯỢT TASK 1: report the popover's measured size so the positioner can flip/clamp. */
  onMeasure?: (size: { width: number; height: number }) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Measure after layout so the next reposition uses the real size.
  useEffect(() => {
    const el = ref.current;
    if (!el || !onMeasure) return;
    const r = el.getBoundingClientRect();
    onMeasure({ width: r.width, height: r.height });
  }, [onMeasure]);

  useDismissOnOutsideAndEscape(ref, onDismiss);

  return (
    <div
      ref={ref}
      data-testid="selection-popover"
      role="toolbar"
      aria-label="Selection actions"
      // .selection-popover (prototype): floats over the range; elev surface, line border, r-md.
      className="absolute z-40 flex items-center gap-0.5 rounded-md border border-line bg-elev p-1 shadow-lg"
      // centered: `left` is the selection's center x → translateX(-50%) centers the popover over it
      // (above-centered tooltip, Plannotator center-above, Apache-2.0).
      style={{ top: rect.top, left: rect.left, transform: rect.centered ? "translateX(-50%)" : undefined }}
    >
      <button
        type="button"
        data-testid="popover-comment"
        onClick={onComment}
        className="inline-flex items-center gap-1.5 rounded-[5px] px-2 py-1 text-[12.5px] font-medium text-ink hover:bg-sunken"
      >
        <Icon name="inbox" size={14} />
        Comment
      </button>
      <button
        type="button"
        data-testid="popover-like"
        onClick={() => onSelectType?.("like")}
        className="inline-flex items-center gap-1.5 rounded-[5px] px-2 py-1 text-[12.5px] font-medium text-ink hover:bg-sunken"
      >
        <Icon name="check" size={14} />
        Like
      </button>
      <button
        type="button"
        data-testid="popover-label"
        onClick={() => onSelectType?.("label")}
        className="inline-flex items-center gap-1.5 rounded-[5px] px-2 py-1 text-[12.5px] font-medium text-ink hover:bg-sunken"
      >
        <Icon name="pin" size={14} />
        Label
      </button>
      <button
        type="button"
        data-testid="popover-redline"
        onClick={() => onSelectType?.("redline")}
        className="inline-flex items-center gap-1.5 rounded-[5px] px-2 py-1 text-[12.5px] font-medium text-ink hover:bg-sunken"
      >
        <Icon name="trash" size={14} />
        Redline
      </button>
      <button
        type="button"
        data-testid="popover-suggest"
        onClick={() => onSelectType?.("suggest")}
        className="inline-flex items-center gap-1.5 rounded-[5px] px-2 py-1 text-[12.5px] font-medium text-ink hover:bg-sunken"
      >
        <Icon name="pencil" size={14} />
        Suggest
      </button>
      <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-line" />
      <button
        type="button"
        data-testid="popover-dismiss"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="inline-flex items-center rounded-[5px] p-1 text-subtle hover:bg-sunken hover:text-ink"
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
