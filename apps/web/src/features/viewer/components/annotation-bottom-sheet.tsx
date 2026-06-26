import { useRef } from "react";
import type { ViewerAnnotation } from "@/features/viewer/services/client";
import { ThreadCard } from "./thread-card";
import { Icon } from "@/components/icon";

// AnnotationBottomSheet (S-004): the mobile/touch counterpart of the desktop pinned card. On a
// narrow / touch (drawer-mode) device there is no hover, so tapping a marker slides UP a bottom sheet
// hosting the FULL interactive ThreadCard (reused verbatim — UI Notes) for that one annotation. The
// rail drawer + CommentFab stay reachable by their own controls; this is additive (Not in Scope to
// retire them).
//
// At most one sheet open at a time (C-002): the shell drives it off the SAME useHoverPin pin state the
// desktop pin uses (pinMark replaces / toggles), so opening a new sheet closes the prior — one-at-a-time
// consistent with the pin. The desktop hover-peek never appears on touch (AS-019): the shell wires no
// hover option in drawer mode.
//
// Actions are role-gated by reusing the ThreadCard's OWN per-role gating (C-005 → AS-020): a commenter
// gets Reply + Resolve, a viewer-only role passes no callbacks → the thread renders read-only. The
// backend re-authorizes every write; the affordance is only a hint.
//
// DESIGN.md §Responsive (<600 mobile): the comment rail becomes a bottom-sheet; tap targets ≥44px, the
// single deep-teal accent (inherited by the hosted ThreadCard), chrome recedes behind the thread. The
// grab handle + ✕ are sheet-owned (the hosted card is unchanged). The ✕ stopsPropagation so the click
// never bubbles to the doc-pane delegation (re-focus / re-open).

export interface AnnotationBottomSheetProps {
  annotation: ViewerAnnotation;
  /** sheet close — the ✕ / grab-handle dismiss (AS-018). */
  onClose: () => void;
  // The full ThreadCard wiring — forwarded verbatim from the rail's per-thread bindings so the sheet
  // and the rail card offer the IDENTICAL role-gated actions (C-005). A viewer-only role passes none
  // → ThreadCard renders read-only (AS-020).
  focused: boolean;
  unplaceable: boolean;
  onFocus: (id: string) => void;
  currentUserId?: string | null;
  currentAuthorName?: string | null;
  currentAuthorIsGuest?: boolean;
  isOwner?: boolean;
  onReply?: (body: string) => unknown | Promise<unknown>;
  onResolve?: (resolved: boolean) => Promise<boolean>;
  onDecide?: (decision: "accept" | "reject") => Promise<boolean>;
  onDelete?: () => unknown | Promise<unknown>;
}

export function AnnotationBottomSheet({
  annotation,
  onClose,
  focused,
  unplaceable,
  onFocus,
  currentUserId,
  currentAuthorName = null,
  currentAuthorIsGuest = false,
  isOwner = false,
  onReply,
  onResolve,
  onDecide,
  onDelete,
}: AnnotationBottomSheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <div
      ref={ref}
      data-testid="annotation-bottom-sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Annotation thread"
      // Slide-up sheet pinned to the bottom edge, full-width, capped height with its own scroll so a
      // long thread never grows past the viewport. z above the rail drawer/scrim. On click stop so a
      // tap inside never bubbles to the doc-pane delegation.
      onClick={stop}
      className="fixed inset-x-0 bottom-0 z-50 max-h-[80dvh] overflow-y-auto rounded-t-2xl border-t border-line bg-paper shadow-xl"
    >
      {/* Grab handle — a centered pill (visual affordance the prototype's bottom-sheet uses); the whole
          header row is a ≥44px dismiss target (DESIGN.md). */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 bg-paper/95 px-3 pb-1 pt-2 backdrop-blur">
        <span className="flex-1" />
        <button
          type="button"
          data-testid="bottom-sheet-handle"
          aria-label="Close"
          onClick={(e) => {
            stop(e);
            onClose();
          }}
          className="flex h-11 flex-1 cursor-pointer items-center justify-center"
        >
          <span aria-hidden className="h-1 w-10 rounded-full bg-line" />
        </button>
        <span className="flex flex-1 justify-end">
          <button
            type="button"
            data-testid="bottom-sheet-close"
            aria-label="Close"
            onClick={(e) => {
              stop(e);
              onClose();
            }}
            className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-[8px] text-subtle hover:bg-elev hover:text-ink"
          >
            <Icon name="x" size={18} />
          </button>
        </span>
      </div>
      {/* The reused FULL ThreadCard — role-gated actions come from the forwarded callbacks (C-005). */}
      <div className="px-3 pb-[max(env(safe-area-inset-bottom),12px)]">
        <ThreadCard
          annotation={annotation}
          focused={focused}
          unplaceable={unplaceable}
          onFocus={onFocus}
          currentUserId={currentUserId}
          currentAuthorName={currentAuthorName}
          currentAuthorIsGuest={currentAuthorIsGuest}
          isOwner={isOwner}
          onReply={onReply}
          onResolve={onResolve}
          onDecide={onDecide}
          onDelete={onDelete}
        />
      </div>
    </div>
  );
}
