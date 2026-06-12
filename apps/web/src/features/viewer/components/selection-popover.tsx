import { useEffect, useRef } from "react";
import { Icon } from "@/components/icon";
import { useDismissOnOutsideAndEscape } from "@/features/viewer/hooks/use-dismiss";

// SelectionPopover (S-001): the floating popover that appears over a live text selection on a
// rendered Markdown doc. Mirrors the prototype `viewer.jsx` SelectionPopover. v0 surfaces only
// Comment + Dismiss here (Suggest/Resolve/React belong to the suggest-image + thread-action specs).
//
// C-004 gate is upstream (the viewer only mounts this for a comment-capable role); C-003 is also
// upstream (the viewer only sets a selection when selectionToAnchor returned a real range). So this
// component is a pure presentational affordance — if it's rendered, the selection is real and the
// role may comment.
//
// MƯỢT TASK 1: on mount/update the popover MEASURES itself (getBoundingClientRect) and reports its
// size up via `onMeasure`, so use-compose's placePopover can flip/clamp against the real width/height
// (happy-dom returns 0 — the hook falls back to a default size). `rect` is the ALREADY-positioned
// {top,left} from placePopover; this component just renders at it.
//
// MƯỢT TASK 4: outside-click + Escape dismiss via useDismissOnOutsideAndEscape (the multi-click guard
// keeps a triple-click paragraph selection alive — adopted from Plannotator, Apache-2.0).

export function SelectionPopover({
  rect,
  onComment,
  onDismiss,
  onMeasure,
}: {
  /** the already-positioned {top,left,centered} (placePopover output). When `centered`, `left` is
   *  the CENTER x of the selection → apply translateX(-50%) (above-centered, Plannotator). */
  rect: { top: number; left: number; centered?: boolean };
  onComment: () => void;
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
