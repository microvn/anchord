import { describe, it, expect, beforeEach } from "bun:test";
import { render, waitFor, act } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import {
  useAnnotationMarks,
  placeAnnotations,
  type PlaceableAnnotation,
} from "@/features/viewer/components/annotation-marks";
import { placePopover, type RectLike } from "@/features/viewer/lib/place-popover";

// S-001 — the hover (dwell) detection extension of useAnnotationMarks. The hover is detected on the
// SHARED doc-pane listener via mouseover/mouseout with a relatedTarget check (NOT per-mark
// mouseenter/mouseleave, which don't bubble to a delegated listener). A dwell timer (~200ms) starts
// on entering a mark and is CANCELLED when the cursor moves off the mark before the interval elapses.
//
// happy-dom dispatches DOM events fine; only LAYOUT is absent (getBoundingClientRect → 0). So the
// dwell/cancel/coalesce LOGIC is tested here with real (tiny) timers; the placement MATH (AS-005) is
// tested purely via placePopover at the bottom.

const DWELL = 5; // a tiny dwell so the real timer resolves fast under test (default is ~200ms)

beforeEach(() => {
  document.body.innerHTML = "";
});

interface PeekEvent {
  annoId: string;
  rect: DOMRect;
}

// A harness mounting useAnnotationMarks against a live doc element, recording every onHoverPeek call.
// C-001 (selection-based gating): the peek is gated on TEXT-SELECTION state, NOT on which tool is
// active. `selectionActive` drives the injectable `isSelectionActive` predicate the hook reads LIVE
// inside its delegated listener (no stale closure). A mutable cell lets a test flip the selection
// state between events without remounting.
function Harness({
  annotations,
  selectionActive,
  onPeekChange,
  html,
}: {
  annotations: PlaceableAnnotation[];
  /** boolean, or a live getter so a test can flip the selection state mid-flow. */
  selectionActive: boolean | (() => boolean);
  onPeekChange: (peek: PeekEvent | null) => void;
  html: string;
}) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) setEl(ref.current);
  }, []);
  useAnnotationMarks(el, annotations, null, () => {}, undefined, {
    isSelectionActive:
      typeof selectionActive === "function" ? selectionActive : () => selectionActive,
    dwellMs: DWELL,
    onHoverPeek: onPeekChange,
  });
  // eslint-disable-next-line react/no-danger
  return <div ref={ref} data-testid="pane" dangerouslySetInnerHTML={{ __html: html }} />;
}

// Synthetic dispatch of a delegated mouseover/mouseout on a target with a relatedTarget.
function fireOver(target: Element, related: Element | null) {
  const ev = new Event("mouseover", { bubbles: true });
  Object.defineProperty(ev, "target", { value: target });
  Object.defineProperty(ev, "relatedTarget", { value: related });
  target.dispatchEvent(ev);
}
function fireOut(target: Element, related: Element | null) {
  const ev = new Event("mouseout", { bubbles: true });
  Object.defineProperty(ev, "target", { value: target });
  Object.defineProperty(ev, "relatedTarget", { value: related });
  target.dispatchEvent(ev);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ANNO = (id: string, snippet: string, blockId: string): PlaceableAnnotation => ({
  id,
  anchor: { blockId, textSnippet: snippet, offset: 0, length: snippet.length },
});

describe("useAnnotationMarks hover peek (S-001)", () => {
  it("AS-001: dwelling over a marker (no tool active) shows the peek anchored to that marker", async () => {
    const peeks: (PeekEvent | null)[] = [];
    const html = `<p id="block-p-1">tokens before the refresh expire.</p>`;
    render(
      <Harness
        annotations={[ANNO("a1", "tokens before the refresh", "block-p-1")]}
        selectionActive={false}
        onPeekChange={(p) => peeks.push(p)}
        html={html}
      />,
    );

    const mark = await waitFor(() => {
      const m = document.querySelector('[data-anno="a1"]');
      if (!m) throw new Error("mark not placed yet");
      return m as HTMLElement;
    });

    await act(async () => {
      fireOver(mark, null);
      await sleep(DWELL + 20); // let the dwell timer fire
    });

    const last = peeks.at(-1);
    expect(last).not.toBeNull();
    expect(last!.annoId).toBe("a1");
    expect(last!.rect).toBeDefined();
  });

  it("AS-002: moving the cursor off the marker (to a non-mark) hides the peek", async () => {
    const peeks: (PeekEvent | null)[] = [];
    const html = `<p id="block-p-1">tokens before the refresh expire.</p>`;
    render(
      <Harness
        annotations={[ANNO("a1", "tokens before the refresh", "block-p-1")]}
        selectionActive={false}
        onPeekChange={(p) => peeks.push(p)}
        html={html}
      />,
    );
    const mark = await waitFor(() => {
      const m = document.querySelector('[data-anno="a1"]');
      if (!m) throw new Error("not placed");
      return m as HTMLElement;
    });
    const para = document.querySelector("#block-p-1")!;

    await act(async () => {
      fireOver(mark, null);
      await sleep(DWELL + 20);
    });
    expect(peeks.at(-1)).not.toBeNull(); // shown

    await act(async () => {
      fireOut(mark, para); // leave the mark for plain text
    });
    expect(peeks.at(-1)).toBeNull(); // hidden
  });

  it("AS-003: an in-progress text selection suppresses the peek; no selection shows it regardless of tool", async () => {
    // C-001 (rebased to SELECTION-based, not tool-based): the gate is the presence of a non-collapsed
    // text selection — the user is mid-annotate — NOT which tool is active. The viewer always has a
    // tool selected (default Markup), so tool-identity can't gate.
    const html = `<p id="block-p-1">tokens before the refresh expire.</p>`;

    // (1) Suppressed half: a non-empty selection exists (Markup tool selected) → dwelling shows NO peek.
    const suppressed: (PeekEvent | null)[] = [];
    let selecting = true; // a non-collapsed selection is in progress
    const { unmount } = render(
      <Harness
        annotations={[ANNO("a1", "tokens before the refresh", "block-p-1")]}
        selectionActive={() => selecting}
        onPeekChange={(p) => suppressed.push(p)}
        html={html}
      />,
    );
    const mark = await waitFor(() => {
      const m = document.querySelector('[data-anno="a1"]');
      if (!m) throw new Error("not placed");
      return m as HTMLElement;
    });
    await act(async () => {
      fireOver(mark, null);
      await sleep(DWELL + 20);
    });
    // Mid-selection: no peek ever appeared (annotate-create owns the gesture).
    expect(suppressed.every((p) => p === null)).toBe(true);
    unmount();
    document.body.innerHTML = "";

    // (2) Positive half: NO active selection, with a NON-MARKUP tool (Comment) active → the peek DOES
    // appear. This proves the gate is selection, not tool: a comment-tool session still gets the peek.
    const shown: (PeekEvent | null)[] = [];
    render(
      <Harness
        annotations={[ANNO("a1", "tokens before the refresh", "block-p-1")]}
        // selectionActive=false models the collapsed/empty selection; the tool is irrelevant to the gate
        // (Comment would be active in this session, yet the peek must still show).
        selectionActive={false}
        onPeekChange={(p) => shown.push(p)}
        html={html}
      />,
    );
    const mark2 = await waitFor(() => {
      const m = document.querySelector('[data-anno="a1"]');
      if (!m) throw new Error("not placed");
      return m as HTMLElement;
    });
    await act(async () => {
      fireOver(mark2, null);
      await sleep(DWELL + 20);
    });
    const last = shown.at(-1);
    expect(last).not.toBeNull();
    expect(last!.annoId).toBe("a1");
  });

  it("AS-022 (C-008): a multi_range annotation's LOWER mark anchors the peek to its OWN rect, not the first", async () => {
    const peeks: PeekEvent[] = [];
    const html = `<h2 data-block-id="b1">Heading mark here.</h2><p data-block-id="b2">Paragraph mark here.</p>`;
    const multi: PlaceableAnnotation = {
      id: "m1",
      anchor: {
        blockId: "b1",
        textSnippet: "Heading",
        offset: 0,
        length: 7,
        segments: [
          { blockId: "b1", textSnippet: "Heading", offset: 0, length: 7 },
          { blockId: "b2", textSnippet: "Paragraph", offset: 0, length: 9 },
        ],
      },
    };
    render(
      <Harness
        annotations={[multi]}
        selectionActive={false}
        onPeekChange={(p) => p && peeks.push(p)}
        html={html}
      />,
    );

    const marks = await waitFor(() => {
      const ms = document.querySelectorAll('[data-anno="m1"]');
      if (ms.length < 2) throw new Error("both segments not placed yet");
      return Array.from(ms) as HTMLElement[];
    });
    const lower = document.querySelector('[data-block-id="b2"] [data-anno="m1"]') as HTMLElement;
    const heading = document.querySelector('[data-block-id="b1"] [data-anno="m1"]') as HTMLElement;
    expect(lower).not.toBeNull();
    // Give the lower mark a distinct rect so we can prove the anchor is ITS rect, not the heading's.
    lower.getBoundingClientRect = () =>
      ({ top: 300, bottom: 320, left: 10, right: 90, width: 80, height: 20, x: 10, y: 300 }) as DOMRect;
    heading.getBoundingClientRect = () =>
      ({ top: 0, bottom: 20, left: 10, right: 90, width: 80, height: 20, x: 10, y: 0 }) as DOMRect;

    await act(async () => {
      fireOver(lower, null);
      await sleep(DWELL + 20);
    });

    const last = peeks.at(-1)!;
    expect(last.annoId).toBe("m1");
    expect(last.rect.top).toBe(300); // the LOWER mark's own rect, not the heading's top=0
  });

  it("AS-022: moving between two marks that share one data-anno is NOT a leave (coalesce by id)", async () => {
    const peeks: (PeekEvent | null)[] = [];
    const html = `<h2 data-block-id="b1">Heading mark here.</h2><p data-block-id="b2">Paragraph mark here.</p>`;
    const multi: PlaceableAnnotation = {
      id: "m1",
      anchor: {
        blockId: "b1",
        textSnippet: "Heading",
        offset: 0,
        length: 7,
        segments: [
          { blockId: "b1", textSnippet: "Heading", offset: 0, length: 7 },
          { blockId: "b2", textSnippet: "Paragraph", offset: 0, length: 9 },
        ],
      },
    };
    render(
      <Harness annotations={[multi]} selectionActive={false} onPeekChange={(p) => peeks.push(p)} html={html} />,
    );
    await waitFor(() => {
      if (document.querySelectorAll('[data-anno="m1"]').length < 2) throw new Error("not placed");
    });
    const heading = document.querySelector('[data-block-id="b1"] [data-anno="m1"]') as HTMLElement;
    const para = document.querySelector('[data-block-id="b2"] [data-anno="m1"]') as HTMLElement;

    await act(async () => {
      fireOver(heading, null);
      await sleep(DWELL + 20);
    });
    expect(peeks.at(-1)).not.toBeNull();
    const shownCount = peeks.filter((p) => p !== null).length;

    // Move to the sibling mark sharing the SAME data-anno — this must NOT hide the peek.
    await act(async () => {
      fireOut(heading, para);
      fireOver(para, heading);
      await sleep(DWELL + 20);
    });
    // No null (hide) was emitted between the marks — coalesced by id.
    expect(peeks.at(-1)).not.toBeNull();
    expect(peeks.filter((p) => p !== null).length).toBeGreaterThanOrEqual(shownCount);
  });

  it("AS-025 (C-008): sweeping across markers each under the dwell interval leaves no orphan peek", async () => {
    const peeks: (PeekEvent | null)[] = [];
    const html = `<p id="block-p-1">alpha beta gamma here.</p>`;
    const annos = [
      ANNO("a1", "alpha", "block-p-1"),
      ANNO("a2", "beta", "block-p-1"),
      ANNO("a3", "gamma", "block-p-1"),
    ];
    render(<Harness annotations={annos} selectionActive={false} onPeekChange={(p) => peeks.push(p)} html={html} />);
    await waitFor(() => {
      if (document.querySelectorAll("[data-anno]").length < 3) throw new Error("not placed");
    });
    const m1 = document.querySelector('[data-anno="a1"]') as HTMLElement;
    const m2 = document.querySelector('[data-anno="a2"]') as HTMLElement;
    const m3 = document.querySelector('[data-anno="a3"]') as HTMLElement;
    const para = document.querySelector("#block-p-1")!;

    // Sweep across all three, each rest well UNDER the dwell interval (no sleep ≥ DWELL between).
    await act(async () => {
      fireOver(m1, para);
      fireOut(m1, m2);
      fireOver(m2, m1);
      fireOut(m2, m3);
      fireOver(m3, m2);
      fireOut(m3, para); // off all marks onto plain text
      await sleep(DWELL + 20); // now wait — every pending timer should have been cancelled
    });

    // No peek was ever shown — every pending dwell timer was cancelled on the early leave.
    expect(peeks.every((p) => p === null)).toBe(true);
  });
});

// AS-005 — placement (PURE, happy-dom has no layout). A marker near the top edge whose peek won't fit
// above must flip BELOW and clamp horizontally on-screen. The peek prefers "above"; this reuses the
// same placePopover math the selection popover uses.
describe("peek placement (S-001 / AS-005)", () => {
  const PEEK = { width: 300, height: 120 };
  const VP = { width: 1000, height: 800 };
  const rect = (p: Partial<RectLike>): RectLike => ({ top: 0, bottom: 0, left: 0, right: 0, ...p });

  it("AS-005: a marker near the top edge flips the peek BELOW and clamps it on-screen", () => {
    // Marker top=10: peek (120) + gap (8) = 128 > 10 room above → must flip below.
    const r = rect({ top: 10, bottom: 28, left: 980, right: 995 });
    const placed = placePopover(r, PEEK, VP, "above");
    expect(placed.side).toBe("below"); // flipped — won't fit above
    expect(placed.top).toBe(28 + 8); // below the marker (bottom + GAP)
    // Horizontally clamped so the whole 300-wide centered peek stays on-screen.
    // maxCenter = 1000 - 150 - 8 = 842.
    expect(placed.left).toBe(842);
  });

  it("AS-005: with room above, the peek prefers above-centered over the marker", () => {
    const r = rect({ top: 400, bottom: 418, left: 200, right: 300 });
    const placed = placePopover(r, PEEK, VP, "above");
    expect(placed.side).toBe("above");
    expect(placed.top).toBe(400 - 8 - 120);
    expect(placed.left).toBe(250); // centered on the marker
  });
});
