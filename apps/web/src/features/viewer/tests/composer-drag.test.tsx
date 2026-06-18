import { describe, it, expect, mock } from "bun:test";
import { renderHook, act, render } from "@testing-library/react";
import { useRef } from "react";

// #2 (2026-06-12) — the inline comment composer popover is DRAGGABLE by its quote-ref HEADER
// (Plannotator card, Apache-2.0). happy-dom has no real layout (getBoundingClientRect → 0) and limited
// pointer-capture support, so the ACTUAL on-screen drag is [→MANUAL]/Playwright. Here we drive the
// hook's pointer handlers with SYNTHETIC coords and assert the position STATE transitions, then render
// the real Composer to assert the drag-handle affordance + that a pointerdown→move updates the
// rendered card's inline top/left.

// Keep the network client inert — these tests never write.
mock.module("@/features/viewer/services/client", () => ({
  // S-002: stub the redline create/decide so this file's partial client mock still satisfies the
  // imports useCompose/viewer-screen now make (bun mock.module binds exports at load).
  createRedline: mock(async () => ({ data: { success: true, data: { suggestionId: "rl-x" } }, error: null })),
  decideSuggestion: mock(async () => ({ data: { success: true, data: { status: "accepted" } }, error: null })),
  createAnnotation: mock(async () => ({ data: { annotationId: "a1" }, error: null })),
  addComment: mock(async () => ({ data: {}, error: null })),
  deleteAnnotation: mock(async () => ({ data: { success: true, data: { deleted: true } }, error: null })),
  restoreAnnotation: mock(async () => ({ data: { success: true, data: { restored: true } }, error: null })),
  dismissAnnotation: mock(async () => ({ data: { success: true, data: { dismissed: true } }, error: null })),
  reattachAnnotation: mock(async () => ({ data: { success: true, data: { isOrphaned: false } }, error: null })),
}));

const { useDraggable } = await import("@/features/viewer/hooks/use-draggable");
const { Composer } = await import("@/features/viewer/components/composer");

/** A minimal synthetic React.PointerEvent for the handler (only the members it reads). */
function pointerDownEvent(x: number, y: number): unknown {
  return {
    button: 0,
    pointerType: "mouse",
    pointerId: 1,
    clientX: x,
    clientY: y,
    stopPropagation() {},
    currentTarget: { setPointerCapture() {}, releasePointerCapture() {} },
  };
}

describe("#2 useDraggable", () => {
  it("starts undragged (no manual position, not dragging)", () => {
    const { result } = renderHook(() => useDraggable());
    expect(result.current.pos).toBeNull();
    expect(result.current.dragged).toBe(false);
    expect(result.current.dragging).toBe(false);
  });

  it("pointerdown → move → up updates the manual position, then pins it (manual wins)", () => {
    const { result } = renderHook(() => useDraggable());

    // Grab the card at its current top/left (100,200) with the pointer starting at (300,400).
    act(() => {
      result.current.onHandlePointerDown(pointerDownEvent(300, 400) as never, { top: 100, left: 200 });
    });
    expect(result.current.dragged).toBe(true);
    expect(result.current.dragging).toBe(true);
    expect(result.current.pos).toEqual({ top: 100, left: 200 });

    // Move the pointer +50x / +30y → position shifts by the same delta.
    act(() => {
      window.dispatchEvent(new (window as any).PointerEvent("pointermove", { clientX: 350, clientY: 430 }));
    });
    expect(result.current.pos).toEqual({ top: 130, left: 250 });

    // Release → dragging ends, but the manual position (and `dragged`) is RETAINED so it wins over
    // any later auto-reposition.
    act(() => {
      window.dispatchEvent(new (window as any).PointerEvent("pointerup", {}));
    });
    expect(result.current.dragging).toBe(false);
    expect(result.current.dragged).toBe(true);
    expect(result.current.pos).toEqual({ top: 130, left: 250 });
  });
});

describe("#2 Composer drag handle", () => {
  function DraggableComposerHarness() {
    const ref = useRef<HTMLDivElement>(null);
    const drag = useDraggable();
    const anchor = { top: 100, left: 200, centered: true };
    const dragged = drag.dragged && drag.pos !== null;
    const top = dragged ? drag.pos!.top : anchor.top;
    const left = dragged ? drag.pos!.left : anchor.left;
    const centered = !dragged && anchor.centered;
    return (
      <div
        ref={ref}
        data-testid="inline-composer-popover"
        style={{ position: "absolute", top, left, transform: centered ? "translateX(-50%)" : undefined }}
      >
        <Composer
          quote="Payment expires after 24h"
          onSend={() => {}}
          onCancel={() => {}}
          dragging={drag.dragging}
          dragHandleProps={{
            "data-testid": "composer-drag-handle",
            onPointerDown: (e) => drag.onHandlePointerDown(e, { top, left }),
          }}
        />
      </div>
    );
  }

  it("renders a composer-drag-handle and a pointerdown→move updates the card's inline top/left", () => {
    const { getByTestId } = render(<DraggableComposerHarness />);
    const handle = getByTestId("composer-drag-handle");
    const card = getByTestId("inline-composer-popover");

    // Undragged: tracks the anchor, still centered.
    expect(card.style.top).toBe("100px");
    expect(card.style.left).toBe("200px");
    expect(card.style.transform).toContain("translateX(-50%)");

    // Grab the header at (10,10) and move to (60,40): +50x / +30y.
    act(() => {
      handle.dispatchEvent(new (window as any).PointerEvent("pointerdown", { button: 0, pointerType: "mouse", pointerId: 1, clientX: 10, clientY: 10, bubbles: true }));
    });
    act(() => {
      window.dispatchEvent(new (window as any).PointerEvent("pointermove", { clientX: 60, clientY: 40 }));
    });

    // Dragged: pinned to the manual absolute position, centering dropped.
    expect(card.style.top).toBe("130px");
    expect(card.style.left).toBe("250px");
    expect(card.style.transform).toBe("");
  });
});
