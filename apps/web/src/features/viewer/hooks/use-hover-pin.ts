import { useCallback, useState } from "react";
import { placePopover, type Placement, type Viewport, type RectLike } from "@/features/viewer/lib/place-popover";
import type { HoverPeek } from "@/features/viewer/components/annotation-marks";

// useHoverPin (S-001 + S-002): the viewer-screen-side STATE for the hover peek AND the click-to-pin
// card. useAnnotationMarks owns the DOM dwell/cancel/coalesce + click detection (it lives over the raw
// doc element); this hook owns the React state the shell renders from.
//
// S-001 — the PEEK: the peeked annotation id + the placement computed from the hovered mark's rect.
//   The peek prefers ABOVE the marker (UI Notes), flipping below + clamping when it won't fit.
//
// S-002 — the PIN (C-004): a `pinnedId` DISTINCT from the peek (and from the rail's `focusedId`,
//   which lives in useAnnotations). Pinning sets pinnedId + a placement that prefers BELOW the marker
//   (UI Notes). At most ONE pin at a time (C-002): pinning a new id replaces the previous. Clicking
//   the SAME id again toggles it closed (AS-011). The caller pairs `pinnedId` with `focusedId` (it
//   sets both on pin) — this hook only owns the pin's open/closed + placement; the rail focus is the
//   caller's. `repositionPin` recomputes the placement from a fresh rect (AS-021 scroll relay), and
//   `closePin` clears it (Escape / outside / ✕ / auto-close).
//
// happy-dom has no layout, so the math is the unit-tested pure path (place-popover.test.ts +
// annotation-hover.test.tsx); these state transitions are tested directly via the hook.

/** The peek's nominal size for placement (matches AnnotationPeekCard's ~300px width). */
export const PEEK_SIZE = { width: 300, height: 120 };
/** The pinned card's nominal size for placement (~360px = the rail width; a tall thread card). */
export const PIN_SIZE = { width: 360, height: 320 };

export interface HoverPinState {
  /** The annotation id whose peek is showing, or null. */
  peekId: string | null;
  /** Where to render the peek (placePopover output), or null when no peek. */
  peekPlacement: Placement | null;
  /** Feed this to useAnnotationMarks' `onHoverPeek`: a HoverPeek shows the peek, null hides it. */
  onHoverPeek: (peek: HoverPeek | null) => void;

  /** S-002 (C-004): the annotation id whose full pinned card is open, or null. Distinct from focusedId. */
  pinnedId: string | null;
  /** S-002: where to render the pinned card (placePopover output, prefer below), or null when no pin. */
  pinPlacement: Placement | null;
  /** S-002: pin (or toggle-close, AS-011) the clicked marker. Clicking the SAME id again closes it;
   *  a different id replaces the previous (C-002). Returns the id that ended up pinned (or null when
   *  the click toggled the existing pin closed) — the caller uses it to set/clear `focusedId` in sync. */
  pinMark: (peek: HoverPeek) => string | null;
  /** S-002: recompute the pin placement from a fresh mark rect (AS-021 scroll/resize reposition). */
  repositionPin: (rect: RectLike) => void;
  /** S-002: close the pin (Escape / outside-click / ✕ / auto-close-on-orphan/scroll-out). */
  closePin: () => void;
}

function resolveViewport(viewport?: Viewport): Viewport {
  return (
    viewport ??
    (typeof window !== "undefined"
      ? { width: window.innerWidth, height: window.innerHeight }
      : { width: 1000, height: 800 })
  );
}

/** `viewport` is injectable so the placement is testable; defaults to the live window. */
export function useHoverPin(viewport?: Viewport): HoverPinState {
  const [peekId, setPeekId] = useState<string | null>(null);
  const [peekPlacement, setPeekPlacement] = useState<Placement | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [pinPlacement, setPinPlacement] = useState<Placement | null>(null);

  const onHoverPeek = useCallback(
    (peek: HoverPeek | null) => {
      if (!peek) {
        setPeekId(null);
        setPeekPlacement(null);
        return;
      }
      setPeekId(peek.annoId);
      setPeekPlacement(placePopover(peek.rect, PEEK_SIZE, resolveViewport(viewport), "above"));
    },
    [viewport],
  );

  const closePin = useCallback(() => {
    setPinnedId(null);
    setPinPlacement(null);
  }, []);

  const pinMark = useCallback(
    (peek: HoverPeek): string | null => {
      let result: string | null = null;
      setPinnedId((cur) => {
        // AS-011: clicking the SAME pinned marker again toggles it closed (exactly once).
        if (cur === peek.annoId) {
          setPinPlacement(null);
          result = null;
          return null;
        }
        // A new pin (or replacing a previous one — C-002, at most one): place it preferring BELOW.
        setPinPlacement(placePopover(peek.rect, PIN_SIZE, resolveViewport(viewport), "below"));
        result = peek.annoId;
        return peek.annoId;
      });
      return result;
    },
    [viewport],
  );

  const repositionPin = useCallback(
    (rect: RectLike) => {
      setPinPlacement(placePopover(rect, PIN_SIZE, resolveViewport(viewport), "below"));
    },
    [viewport],
  );

  return {
    peekId,
    peekPlacement,
    onHoverPeek,
    pinnedId,
    pinPlacement,
    pinMark,
    repositionPin,
    closePin,
  };
}
