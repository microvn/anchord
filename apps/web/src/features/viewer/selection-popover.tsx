import { Icon } from "../../components/icon";

// SelectionPopover (S-001): the floating popover that appears over a live text selection on a
// rendered Markdown doc. Mirrors the prototype `viewer.jsx` SelectionPopover. v0 surfaces only
// Comment + Dismiss here (Suggest/Resolve/React belong to the suggest-image + thread-action specs).
//
// C-004 gate is upstream (the viewer only mounts this for a comment-capable role); C-003 is also
// upstream (the viewer only sets a selection when selectionToAnchor returned a real range). So this
// component is a pure presentational affordance — if it's rendered, the selection is real and the
// role may comment.

export function SelectionPopover({
  rect,
  onComment,
  onDismiss,
}: {
  /** viewport-ish coordinates of the selection (top/left); under test happy-dom gives 0s — fine. */
  rect: { top: number; left: number };
  onComment: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      data-testid="selection-popover"
      role="toolbar"
      aria-label="Selection actions"
      // .selection-popover (prototype): floats over the range; elev surface, line border, r-md.
      className="absolute z-40 flex items-center gap-0.5 rounded-md border border-line bg-elev p-1 shadow-lg"
      style={{ top: rect.top, left: rect.left }}
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
