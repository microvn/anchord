import { test, expect, describe } from "bun:test";
import { placePopover, isRectOutOfViewport, type RectLike } from "@/features/viewer/place-popover";

// MƯỢT TASK 1 — viewport-aware popover positioning (PURE). happy-dom returns 0 for every
// getBoundingClientRect, so the live wiring is [→MANUAL]/Playwright; the FLIP + CLAMP math is
// unit-tested here with SYNTHETIC rects (no real layout needed).

const SIZE = { width: 160, height: 40 };
const VP = { width: 1000, height: 800 };

function rect(partial: Partial<RectLike>): RectLike {
  return { top: 0, bottom: 0, left: 0, right: 0, ...partial };
}

describe("placePopover", () => {
  // #2 (2026-06-12): the DEFAULT is now ABOVE the selection, horizontally CENTERED (Plannotator
  // center-above, Apache-2.0). `left` is the selection's CENTER x and `centered` is true, so the
  // consumer applies translateX(-50%). It flips BELOW only when there's no room above.
  test("default: positions ABOVE the selection, centered, when there's room", () => {
    const r = rect({ top: 100, bottom: 120, left: 200, right: 300 });
    const p = placePopover(r, SIZE, VP);
    expect(p.side).toBe("above");
    expect(p.centered).toBe(true);
    expect(p.top).toBe(100 - 8 - 40); // selRect.top - GAP - height
    expect(p.left).toBe(250); // center x = left + width/2 = 200 + 50
  });

  test("flip: no room above → flips BELOW the selection (still centered)", () => {
    // Selection near the viewport top: top=10, popover (40) + gap (8) = 48 > 10 room above.
    const r = rect({ top: 10, bottom: 40, left: 200, right: 300 });
    const p = placePopover(r, SIZE, VP);
    expect(p.side).toBe("below");
    expect(p.top).toBe(40 + 8); // selRect.bottom + GAP
    expect(p.left).toBe(250); // still centered on the selection
  });

  test("clamp right: a selection near the right edge keeps the centered popover on-screen", () => {
    // center x = 987.5 would push a 160-wide popover off-screen (987.5 + 80 > 1000).
    const r = rect({ top: 100, bottom: 120, left: 980, right: 995 });
    const p = placePopover(r, SIZE, VP);
    // maxCenter = 1000 - 80 - 8 = 912.
    expect(p.left).toBe(912);
  });

  test("clamp left: a selection near the left edge is pulled so the centered popover fits", () => {
    const r = rect({ top: 100, bottom: 120, left: -50, right: 10 });
    const p = placePopover(r, SIZE, VP);
    // minCenter = MARGIN + width/2 = 8 + 80 = 88.
    expect(p.left).toBe(88);
  });

  test("no room either side: stays above but clamped on-screen (never escapes)", () => {
    // A tall popover in a short viewport — neither side fits.
    const tall = { width: 160, height: 700 };
    const shortVp = { width: 1000, height: 300 };
    const r = rect({ top: 150, bottom: 170, left: 100, right: 200 });
    const p = placePopover(r, tall, shortVp);
    expect(p.side).toBe("above");
    // maxTop = max(8, 300 - 700 - 8) = 8 → clamped to MARGIN, never off-screen.
    expect(p.top).toBe(8);
  });

  // #1 (2026-06-12): the COMPOSER card passes prefer:"below" so it drops UNDER the selection
  // (Plannotator card, Apache-2.0). Default ABOVE is unchanged (the cases above) — these only cover
  // the opt-in below mode.
  describe('prefer: "below"', () => {
    test("default: positions BELOW the selection, centered, when there's room", () => {
      const r = rect({ top: 100, bottom: 120, left: 200, right: 300 });
      const p = placePopover(r, SIZE, VP, "below");
      expect(p.side).toBe("below");
      expect(p.centered).toBe(true);
      expect(p.top).toBe(120 + 8); // selRect.bottom + GAP
      expect(p.left).toBe(250); // center x = left + width/2 = 200 + 50
    });

    test("flip: no room below → flips ABOVE the selection (still centered)", () => {
      // Selection near the viewport bottom: bottom=790, popover (40) + gap (8) = 48 > 10 room below.
      const r = rect({ top: 760, bottom: 790, left: 200, right: 300 });
      const p = placePopover(r, SIZE, VP, "below");
      expect(p.side).toBe("above");
      expect(p.top).toBe(760 - 8 - 40); // selRect.top - GAP - height
      expect(p.left).toBe(250); // still centered on the selection
    });

    test("clamp: a below-preferred card near the right edge stays on-screen", () => {
      const r = rect({ top: 100, bottom: 120, left: 980, right: 995 });
      const p = placePopover(r, SIZE, VP, "below");
      expect(p.side).toBe("below");
      // maxCenter = 1000 - 80 - 8 = 912.
      expect(p.left).toBe(912);
    });

    test("no room either side: stays below but clamped on-screen (never escapes)", () => {
      const tall = { width: 160, height: 700 };
      const shortVp = { width: 1000, height: 300 };
      const r = rect({ top: 150, bottom: 170, left: 100, right: 200 });
      const p = placePopover(r, tall, shortVp, "below");
      expect(p.side).toBe("below");
      // top would be 170 + 8 = 178, but maxTop = max(8, 300 - 700 - 8) = 8 → clamped to MARGIN.
      expect(p.top).toBe(8);
    });
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
