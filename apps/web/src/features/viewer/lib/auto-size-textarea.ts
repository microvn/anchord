// Shared textarea auto-grow helper. A textarea grows with its content from a minRows floor up to a
// maxRows ceiling, then scrolls. Reused by the comment Composer (composer.tsx, 3..10) and the inline
// reply input (thread-card.tsx, 2..10) so the two surfaces behave identically.
//
// The MATH is a pure function (`computeTextareaHeight`) so it is unit-testable without real layout —
// jsdom/happy-dom report scrollHeight 0, so a pixel-height assertion on a rendered element is vacuous.
// The DOM wrapper (`autoSizeTextarea`) reads the element's computed box + scrollHeight and delegates.

export const DEFAULT_MIN_ROWS = 3;
export const DEFAULT_MAX_ROWS = 10;

/**
 * The clamped height + overflow for a textarea, given its box metrics and current `scrollHeight`.
 * Heights are derived from the element's own computed line-height/padding/border so they stay correct
 * under the design tokens (and box-sizing: border-box — scrollHeight is the padding-box, so the border
 * is added back). Grows to fit content between [minRows, maxRows]; past maxRows it pins to the ceiling
 * and the scrollbar turns on.
 */
export function computeTextareaHeight(m: {
  lineHeight: number;
  vPad: number;
  vBorder: number;
  scrollHeight: number;
  minRows: number;
  maxRows: number;
}): { height: number; overflowY: "auto" | "hidden" } {
  const min = m.lineHeight * m.minRows + m.vPad + m.vBorder;
  const max = m.lineHeight * m.maxRows + m.vPad + m.vBorder;
  const content = m.scrollHeight + m.vBorder;
  const height = Math.min(Math.max(content, min), max);
  // Only show the scrollbar once content exceeds maxRows — below that the box grows, no scroll.
  const overflowY: "auto" | "hidden" = content > max ? "auto" : "hidden";
  return { height, overflowY };
}

/** Measure + resize a live textarea element. Resets height to `auto` first so `scrollHeight` reflects
 *  the content (lets the box SHRINK too), then applies the clamped height + overflow. */
export function autoSizeTextarea(
  el: HTMLTextAreaElement,
  opts: { minRows?: number; maxRows?: number } = {},
): void {
  const { minRows = DEFAULT_MIN_ROWS, maxRows = DEFAULT_MAX_ROWS } = opts;
  const cs = getComputedStyle(el);
  const lineHeight = parseFloat(cs.lineHeight) || 18;
  const vPad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const vBorder = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  el.style.height = "auto"; // reset first so scrollHeight reflects content
  const { height, overflowY } = computeTextareaHeight({
    lineHeight,
    vPad,
    vBorder,
    scrollHeight: el.scrollHeight,
    minRows,
    maxRows,
  });
  el.style.height = `${height}px`;
  el.style.overflowY = overflowY;
}
