import { useRef } from "react";
import type { ViewerAnnotation } from "@/features/viewer/services/client";
import { ThreadCard } from "./thread-card";
import { Icon } from "@/components/icon";
import type { Placement } from "@/features/viewer/lib/place-popover";

// PinnedCardPopover (S-002): the floating wrapper that hosts the FULL interactive ThreadCard at a
// clicked marker. Unlike the read-only AnnotationPeekCard (S-001), this is the click-to-PIN surface
// — the user replies / resolves / accepts / rejects / deletes right here, reusing the SAME ThreadCard
// the rail mounts (UI Notes: reuse verbatim). The close (✕) lives on the WRAPPER, never on ThreadCard.
//
// Width = the rail width (~360px) so the ThreadCard's internal layout matches the rail exactly
// (C-007: two independent optimistic views of one thread — they must read identically). It prefers
// BELOW the marker (UI Notes), flipping/clamping via placePopover (computed by the caller and passed
// in as `placement`).
//
// Dismiss is the CALLER's job (viewer-screen owns the layered Escape + the marker-excluded outside
// test, C-004 contract) — this component only renders + exposes its root ref so the caller can wire
// the dismiss hook against it AND the close button. The ✕ stopsPropagation so the click never bubbles
// to the doc-pane click delegation (which would re-focus / re-pin).

const PINNED_WIDTH = 360; // = the rail width so the hosted ThreadCard layout matches (C-007).

export interface PinnedCardPopoverProps {
  annotation: ViewerAnnotation;
  /** placePopover output (prefer "below") — the caller computes it from the clicked mark's rect. */
  placement: Placement;
  /** wrapper close (✕) — AS-010. */
  onClose: () => void;
  /** the root ref so the caller can exclude the wrapper from the outside-dismiss test (C-004). */
  wrapperRef?: React.Ref<HTMLDivElement>;
  // The full ThreadCard wiring — forwarded verbatim from the rail's per-thread bindings so the pinned
  // card and the rail card offer the IDENTICAL role-gated actions (C-005). A viewer-only role passes
  // none → ThreadCard renders read-only (AS-014).
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

export function PinnedCardPopover({
  annotation,
  placement,
  onClose,
  wrapperRef,
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
}: PinnedCardPopoverProps) {
  const localRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={(node) => {
        localRef.current = node;
        if (typeof wrapperRef === "function") wrapperRef(node);
        else if (wrapperRef) (wrapperRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
      }}
      data-testid="pinned-card-popover"
      data-anno-pinned={annotation.id}
      className="absolute z-50"
      style={{
        top: placement.top,
        left: placement.left,
        width: PINNED_WIDTH,
        maxWidth: "92vw",
        transform: placement.centered ? "translateX(-50%)" : undefined,
      }}
    >
      <div className="relative rounded-md shadow-xl">
        {/* The wrapper-owned close (✕) — AS-010. stopPropagation so the click never bubbles to the
            doc-pane delegation (re-focus / re-pin) and never reads as an outside dismiss. */}
        <button
          type="button"
          data-testid="pinned-close"
          aria-label="Close"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="absolute right-1.5 top-1.5 z-10 flex h-6 w-6 cursor-pointer items-center justify-center rounded-[6px] bg-paper/80 text-subtle hover:bg-elev hover:text-ink"
        >
          <Icon name="x" size={14} />
        </button>
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
