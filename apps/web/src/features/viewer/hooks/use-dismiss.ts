import { useEffect } from "react";

// useDismissOnOutsideAndEscape (MƯỢT TASK 4): outside-click + Escape dismiss for the selection
// popover / composer.
//
// Adopted from Plannotator (Apache-2.0) — packages/ui/hooks/useDismissOnOutsideAndEscape.ts. The two
// load-bearing details we copy verbatim in spirit:
//   1. IGNORE multi-click (`event.detail >= 2`). A double/triple-click is part of an active selection
//      gesture (triple-click selects a paragraph). Dismissing on it would mutate the DOM (popover
//      unmount + our highlight unwrap/normalize), which resets the browser's click-count tracking and
//      kills the triple-click selection from ever firing.
//   2. Bind to `mousedown`, NOT `pointerdown` — only MouseEvent.detail is spec-guaranteed to carry
//      the click count (PointerEvent.detail SHOULD be 0 per the Pointer Events spec).
//
// Capture phase so a click anywhere outside the ref dismisses before inner handlers swallow it.

export function useDismissOnOutsideAndEscape(
  ref: React.RefObject<HTMLElement | null>,
  onDismiss: () => void,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;

    const handleMouseDown = (event: MouseEvent) => {
      // Multi-click guard (Plannotator): never dismiss on a double/triple-click selection gesture.
      if (event.detail >= 2) return;
      const target = event.target as Node | null;
      if (!target) return;
      if (ref.current && ref.current.contains(target)) return;
      onDismiss();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };

    document.addEventListener("mousedown", handleMouseDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [ref, onDismiss, enabled]);
}
