import { test, expect, describe } from "bun:test";
import { placePopover, isRectOutOfViewport, type RectLike } from "../src/features/viewer/place-popover";

// MƯỢT TASK 1 — viewport-aware popover positioning (PURE). happy-dom returns 0 for every
// getBoundingClientRect, so the live wiring is [→MANUAL]/Playwright; the FLIP + CLAMP math is
// unit-tested here with SYNTHETIC rects (no real layout needed).

const SIZE = { width: 160, height: 40 };
const VP = { width: 1000, height: 800 };

function rect(partial: Partial<RectLike>): RectLike {
  return { top: 0, bottom: 0, left: 0, right: 0, ...partial };
}

describe("placePopover", () => {
  test("default: positions BELOW the selection when there's room", () => {
    const r = rect({ top: 100, bottom: 120, left: 200, right: 300 });
    const p = placePopover(r, SIZE, VP);
    expect(p.side).toBe("below");
    expect(p.top).toBe(120 + 8); // selRect.bottom + GAP
    expect(p.left).toBe(200); // selRect.left (no clamp needed)
  });

  test("flip: no room below → flips ABOVE the selection", () => {
    // Selection near the viewport bottom: bottom=790, popover (40) + gap (8) = 48 > 10 room below.
    const r = rect({ top: 760, bottom: 790, left: 200, right: 300 });
    const p = placePopover(r, SIZE, VP);
    expect(p.side).toBe("above");
    expect(p.top).toBe(760 - 8 - 40); // selRect.top - GAP - height
  });

  test("clamp right: a selection near the right edge is clamped into the viewport", () => {
    // left=980 would push a 160-wide popover off-screen (980+160 > 1000).
    const r = rect({ top: 100, bottom: 120, left: 980, right: 995 });
    const p = placePopover(r, SIZE, VP);
    // maxLeft = 1000 - 160 - 8 = 832.
    expect(p.left).toBe(832);
  });

  test("clamp left: a negative left is pulled to the MARGIN", () => {
    const r = rect({ top: 100, bottom: 120, left: -50, right: 10 });
    const p = placePopover(r, SIZE, VP);
    expect(p.left).toBe(8); // MARGIN
  });

  test("no room either side: stays below but clamped on-screen (never escapes)", () => {
    // A tall popover in a short viewport — neither side fits.
    const tall = { width: 160, height: 700 };
    const shortVp = { width: 1000, height: 300 };
    const r = rect({ top: 150, bottom: 170, left: 100, right: 200 });
    const p = placePopover(r, tall, shortVp);
    expect(p.side).toBe("below");
    // maxTop = max(8, 300 - 700 - 8) = 8 → clamped to MARGIN, never off-screen.
    expect(p.top).toBe(8);
  });
});

describe("isRectOutOfViewport", () => {
  test("inside the viewport → false", () => {
    expect(isRectOutOfViewport(rect({ top: 100, bottom: 120 }), VP)).toBe(false);
  });
  test("scrolled above the top → true", () => {
    expect(isRectOutOfViewport(rect({ top: -50, bottom: -10 }), VP)).toBe(true);
  });
  test("scrolled below the bottom → true", () => {
    expect(isRectOutOfViewport(rect({ top: 850, bottom: 870 }), VP)).toBe(true);
  });
});
