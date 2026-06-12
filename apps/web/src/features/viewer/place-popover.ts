// place-popover (MƯỢT TASK 1): the PURE viewport-aware positioning math for the selection popover.
//
// Technique adopted from Plannotator (Apache-2.0) — packages/ui/components/AnnotationToolbar.tsx,
// which repositions a floating toolbar on scroll/resize and closes it when the anchored rect leaves
// the viewport (`closeOnScrollOut`). We write our own math (no @radix-ui, no @floating-ui): the
// `prefer` side (default ABOVE for the selection quick-popover; BELOW for the comment composer card),
// FLIP to the opposite side when the preferred one has no room, CLAMP into the viewport horizontally.
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
  /** when true, `left` is the CENTER x of the selection — the consumer applies translateX(-50%) so
   *  the popover is horizontally centered over the selection (Plannotator center-above, Apache-2.0). */
  centered: boolean;
}

/** Gap between the selection rect and the popover, and the min margin to keep off the viewport edge. */
const GAP = 8;
const MARGIN = 8;

/**
 * placePopover — compute where to float the popover for a selection rect.
 *
 * Adopted from Plannotator's AnnotationToolbar `center-above` mode (Apache-2.0): the popover floats
 * ABOVE the selection, horizontally CENTERED on it (`left = selRect.left + width/2`, the consumer
 * applies `translateX(-50%)`), so it reads as a tooltip pointing down at the text — less intrusive
 * than a box that drops below and covers the next line.
 *
 *  - DEFAULT side is driven by `prefer` (default `"above"`):
 *      `"above"` (the selection quick-popover, tooltip-style): float ABOVE the selection, centered
 *        (`top = selRect.top - height - GAP`); FLIP below only when there's no room above and there IS
 *        room below.
 *      `"below"` (the comment COMPOSER card, Plannotator-style — Apache-2.0): float BELOW the selection
 *        (`top = selRect.bottom + GAP`); FLIP above only when there's no room below and there IS room
 *        above. If neither side fits, keep the preferred side but clamp.
 *  - CLAMP: the CENTER x is clamped into [MARGIN + width/2, viewport.width - width/2 - MARGIN] so a
 *    selection near an edge keeps the whole (centered) popover on-screen. Vertical is clamped too.
 *
 * All inputs are plain numbers, so this is fully unit-testable with synthetic rects.
 */
export function placePopover(
  selRect: RectLike,
  size: PopoverSize,
  viewport: Viewport,
  prefer: "above" | "below" = "above",
): Placement {
  const roomAbove = selRect.top;
  const roomBelow = viewport.height - selRect.bottom;
  const needed = size.height + GAP;

  // Start on the preferred side; flip to the other side only when the preferred side doesn't fit and
  // the opposite one does. If neither fits, keep the preferred side (clamped below).
  let side: "above" | "below" = prefer;
  if (prefer === "above") {
    if (roomAbove < needed && roomBelow >= needed) side = "below";
  } else {
    if (roomBelow < needed && roomAbove >= needed) side = "above";
  }

  let top = side === "above" ? selRect.top - GAP - size.height : selRect.bottom + GAP;
  // Clamp vertically so it never escapes the viewport even when neither side fits.
  const maxTop = Math.max(MARGIN, viewport.height - size.height - MARGIN);
  top = Math.min(Math.max(top, MARGIN), maxTop);

  // Centered horizontally on the selection: `left` is the CENTER x; the consumer applies
  // translateX(-50%). Clamp the center so the whole (half-width-either-side) popover stays on-screen.
  const half = size.width / 2;
  const center = selRect.left + (selRect.right - selRect.left) / 2;
  const minCenter = MARGIN + half;
  const maxCenter = Math.max(minCenter, viewport.width - half - MARGIN);
  const left = Math.min(Math.max(center, minCenter), maxCenter);

  return { top, left, side, centered: true };
}

/** Whether a selection rect has scrolled out of the viewport (closeOnScrollOut — Plannotator). */
export function isRectOutOfViewport(selRect: RectLike, viewport: Viewport): boolean {
  return selRect.bottom < 0 || selRect.top > viewport.height;
}
