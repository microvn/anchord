// place-popover (MƯỢT TASK 1): the PURE viewport-aware positioning math for the selection popover.
//
// Technique adopted from Plannotator (Apache-2.0) — packages/ui/components/AnnotationToolbar.tsx,
// which repositions a floating toolbar on scroll/resize and closes it when the anchored rect leaves
// the viewport (`closeOnScrollOut`). We write our own math (no @radix-ui, no @floating-ui): default
// below the selection, FLIP above when there's no room below, CLAMP into the viewport horizontally.
//
// Pure on purpose: happy-dom returns 0 for every getBoundingClientRect, so the live placement is
// [→MANUAL]/Playwright — but this math is unit-tested with SYNTHETIC rects (no real layout needed).

/** A DOM-ish rect (only the members we read — so a synthetic literal satisfies it under test). */
export interface RectLike {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PopoverSize {
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface Placement {
  top: number;
  left: number;
  /** which side of the selection the popover landed on (drives a [→MANUAL] arrow/animation later). */
  side: "below" | "above";
}

/** Gap between the selection rect and the popover, and the min margin to keep off the viewport edge. */
const GAP = 8;
const MARGIN = 8;

/**
 * placePopover — compute where to float the popover for a selection rect.
 *
 *  - DEFAULT: directly below the selection (`selRect.bottom + GAP`).
 *  - FLIP: if the popover wouldn't fit below (bottom + gap + height > viewport height) AND there IS
 *    room above, place it above instead (`selRect.top - GAP - height`). If neither side fits, keep
 *    below but clamp so it stays on-screen.
 *  - CLAMP: left is the selection's left edge, then clamped into [MARGIN, viewport.width - width -
 *    MARGIN] so a selection near the right edge doesn't push the popover off-screen. Vertical is
 *    also clamped to never go above MARGIN or below the viewport.
 *
 * All inputs are plain numbers, so this is fully unit-testable with synthetic rects.
 */
export function placePopover(selRect: RectLike, size: PopoverSize, viewport: Viewport): Placement {
  const roomBelow = viewport.height - selRect.bottom;
  const roomAbove = selRect.top;
  const needed = size.height + GAP;

  let side: "below" | "above" = "below";
  if (roomBelow < needed && roomAbove >= needed) {
    side = "above";
  }

  let top = side === "below" ? selRect.bottom + GAP : selRect.top - GAP - size.height;
  // Clamp vertically so it never escapes the viewport even when neither side fits.
  const maxTop = Math.max(MARGIN, viewport.height - size.height - MARGIN);
  top = Math.min(Math.max(top, MARGIN), maxTop);

  // Clamp horizontally: start at the selection's left, keep the whole popover on-screen.
  const maxLeft = Math.max(MARGIN, viewport.width - size.width - MARGIN);
  const left = Math.min(Math.max(selRect.left, MARGIN), maxLeft);

  return { top, left, side };
}

/** Whether a selection rect has scrolled out of the viewport (closeOnScrollOut — Plannotator). */
export function isRectOutOfViewport(selRect: RectLike, viewport: Viewport): boolean {
  return selRect.bottom < 0 || selRect.top > viewport.height;
}
