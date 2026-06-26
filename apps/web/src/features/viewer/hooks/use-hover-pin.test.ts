import { describe, it, expect } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { useHoverPin, PEEK_SIZE } from "@/features/viewer/hooks/use-hover-pin";

// S-001 — useHoverPin: the viewer-screen-side peek state. A HoverPeek (id + the hovered mark's rect)
// sets peekId + a placement (prefer above, AS-005); null clears both. The viewport is injected so the
// placement is deterministic under happy-dom (no real layout).

const VP = { width: 1000, height: 800 };
const rect = (p: Partial<DOMRect>) =>
  ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, ...p }) as DOMRect;

describe("useHoverPin (S-001)", () => {
  it("AS-001: a HoverPeek sets the peeked id and a placement above the marker", () => {
    const { result } = renderHook(() => useHoverPin(VP));
    expect(result.current.peekId).toBeNull();

    act(() => result.current.onHoverPeek({ annoId: "a1", rect: rect({ top: 400, bottom: 418, left: 200, right: 300 }) }));

    expect(result.current.peekId).toBe("a1");
    expect(result.current.peekPlacement!.side).toBe("above");
    expect(result.current.peekPlacement!.top).toBe(400 - 8 - PEEK_SIZE.height);
  });

  it("AS-002: a null HoverPeek clears the peek", () => {
    const { result } = renderHook(() => useHoverPin(VP));
    act(() => result.current.onHoverPeek({ annoId: "a1", rect: rect({ top: 400, bottom: 418 }) }));
    expect(result.current.peekId).toBe("a1");
    act(() => result.current.onHoverPeek(null));
    expect(result.current.peekId).toBeNull();
    expect(result.current.peekPlacement).toBeNull();
  });

  it("AS-005: a near-top marker flips the placement below", () => {
    const { result } = renderHook(() => useHoverPin(VP));
    act(() => result.current.onHoverPeek({ annoId: "a1", rect: rect({ top: 10, bottom: 28, left: 200, right: 300 }) }));
    expect(result.current.peekPlacement!.side).toBe("below");
  });
});
