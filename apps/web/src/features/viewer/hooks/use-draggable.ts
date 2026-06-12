import { useCallback, useState } from "react";

// useDraggable (#2, 2026-06-12): grab a HEADER handle and drag a floating card to reposition it
// freely. Modeled on Plannotator's draggable composer card (Apache-2.0): the popup drops below the
// selection, and the user can pick it up by its quote-ref header and move it anywhere.
//
// Behavior:
//   - `onPointerDown` (wired to the drag-handle region) records the start pointer + the card's
//     current top/left, captures the pointer, and begins tracking. It stopsPropagation so the
//     outside-dismiss guard (a single mousedown) never sees a drag-start as an outside click.
//   - While dragging, pointermove updates a manual {top,left}. pointerup/pointercancel ends it.
//   - Once `dragged` is true, the consumer uses `pos` (manual absolute position) and STOPS letting
//     the anchor auto-reposition on scroll/resize — a manual position wins.
//
// happy-dom has no real layout (getBoundingClientRect → 0) and limited pointer-capture support, so
// the actual on-screen drag is [→MANUAL]/Playwright; the position-state transition is unit-tested by
// driving these handlers with synthetic pointer coords.

export interface DraggableState {
  /** the manual absolute position once dragged; null before the first drag. */
  pos: { top: number; left: number } | null;
  /** true once the user has started dragging — the consumer should drop auto-repositioning + centering. */
  dragged: boolean;
  /** true while a drag is in progress (drives `cursor: grabbing`). */
  dragging: boolean;
  /** wire to the drag-handle's onPointerDown. `from` is the card's CURRENT absolute top/left. */
  onHandlePointerDown: (event: React.PointerEvent, from: { top: number; left: number }) => void;
}

export function useDraggable(): DraggableState {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [dragged, setDragged] = useState(false);
  const [dragging, setDragging] = useState(false);

  const onHandlePointerDown = useCallback(
    (event: React.PointerEvent, from: { top: number; left: number }) => {
      // Only a primary button / touch starts a drag. Let modified clicks (e.g. context menu) pass.
      if (event.button !== 0 && event.pointerType === "mouse") return;
      // A drag-start must NOT bubble to the document mousedown that powers the outside-dismiss guard
      // (a single mousedown that then moves would otherwise be read as an outside click).
      event.stopPropagation();

      const startX = event.clientX;
      const startY = event.clientY;
      const startTop = from.top;
      const startLeft = from.left;

      setDragging(true);
      setDragged(true);
      setPos({ top: startTop, left: startLeft });

      const target = event.currentTarget as Element;
      try {
        target.setPointerCapture?.(event.pointerId);
      } catch {
        // happy-dom / older browsers may not implement pointer capture — drag still works via the
        // window listeners below.
      }

      const onMove = (e: PointerEvent) => {
        setPos({ top: startTop + (e.clientY - startY), left: startLeft + (e.clientX - startX) });
      };
      const end = () => {
        setDragging(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        try {
          target.releasePointerCapture?.(event.pointerId);
        } catch {
          /* no-op */
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    },
    [],
  );

  return { pos, dragged, dragging, onHandlePointerDown };
}
