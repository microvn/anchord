import { describe, it, expect } from "bun:test";
import { computeTextareaHeight, DEFAULT_MIN_ROWS, DEFAULT_MAX_ROWS } from "./auto-size-textarea";

// The auto-grow MATH is extracted as a pure function so it is testable without real layout (jsdom/
// happy-dom report scrollHeight 0). `autoSizeTextarea` (the DOM wrapper) reads the element's computed
// box and delegates here; both the composer and the reply input reuse it. These cases pin the contract:
// grows with content under maxRows, clamps to a minRows floor, clamps to a maxRows ceiling + scrolls.
//
// Box used below: lineHeight 18, vertical padding 16 (8+8), vertical border 2 (1+1).
//   min(2 rows) = 18*2 + 16 + 2 = 54 ;  max(10 rows) = 18*10 + 16 + 2 = 198
const BOX = { lineHeight: 18, vPad: 16, vBorder: 2, minRows: 2, maxRows: 10 };

describe("computeTextareaHeight", () => {
  it("grows to fit content while under maxRows (no scrollbar)", () => {
    // ~5 lines of content → scrollHeight 100; sits between the 54 floor and the 198 ceiling.
    const r = computeTextareaHeight({ ...BOX, scrollHeight: 100 });
    expect(r.height).toBe(102); // scrollHeight + vBorder
    expect(r.overflowY).toBe("hidden");
  });

  it("clamps up to the minRows floor when content is shorter than the minimum", () => {
    const r = computeTextareaHeight({ ...BOX, scrollHeight: 10 });
    expect(r.height).toBe(54); // min floor, not 12
    expect(r.overflowY).toBe("hidden");
  });

  it("clamps to the maxRows ceiling and turns on the scrollbar past maxRows", () => {
    // Content taller than 10 rows → height pinned at the 198 ceiling, overflow becomes scrollable.
    const r = computeTextareaHeight({ ...BOX, scrollHeight: 300 });
    expect(r.height).toBe(198); // max ceiling
    expect(r.overflowY).toBe("auto");
  });

  it("exposes the shared default row bounds (composer baseline 3..10)", () => {
    expect(DEFAULT_MIN_ROWS).toBe(3);
    expect(DEFAULT_MAX_ROWS).toBe(10);
  });
});
