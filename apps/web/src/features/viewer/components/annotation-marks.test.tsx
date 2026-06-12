import { describe, it, expect, beforeEach } from "bun:test";

// annotation-core-ui S-003 — the anchor↔highlight engine (the hardest part). placeAnnotations is a
// PURE, JSDOM-testable function: given a rendered doc DOM + the annotation anchors, it wraps each
// anchored annotation's quoted text range in a <mark data-anno=id> highlight, and reports which
// annotations could NOT be placed (GAP-005: zero/multiple matches, block missing) — never crashing,
// never mis-placing.
//
// AS-007 (pure): an anchor {blockId, snippet, offset} → a wrapped span carrying data-anno.
// GAP-005 (couldn't place): snippet-not-found / block-missing / duplicate-snippet → unplaceable,
//   not a crash, not a wrong placement.

import {
  placeAnnotations,
  locateRange,
  type PlaceableAnnotation,
} from "@/features/viewer/components/annotation-marks";

function mountDoc(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("locateRange (S-003 anchor core)", () => {
  it("AS-007: locates the snippet at its exact offset", () => {
    expect(locateRange("Payment expires after 24h.", "expires after 24h", 8)).toEqual({
      start: 8,
      end: 25,
    });
  });

  it("AS-007: fuzzy-locates a single unambiguous occurrence when the offset is wrong", () => {
    // offset says 0 but the snippet is elsewhere — a single match still resolves.
    expect(locateRange("alpha BETA gamma", "BETA", 0)).toEqual({ start: 6, end: 10 });
  });

  it("GAP-005: returns null when the snippet is absent (zero matches)", () => {
    expect(locateRange("the quick brown fox", "missing", 0)).toBeNull();
  });

  it("FIX 3: a repeated snippet resolves to the occurrence nearest the recorded offset (no refuse)", () => {
    // "na" at 0, 3, 6. Offset 5 doesn't sit on any "na" exactly, so the exact path misses and the
    // old code would refuse (multiple occurrences → null). Nearest-to-5 is the occurrence at 6.
    expect(locateRange("na na na batman", "na", 5)).toEqual({ start: 6, end: 8 });
    // Offset 2 → nearest is the occurrence at 3 (distance 1) over the one at 0 (distance 2).
    expect(locateRange("na na na batman", "na", 2)).toEqual({ start: 3, end: 5 });
  });

  it("FIX 2: normalized tier matches a snippet whose whitespace differs from the block text", () => {
    // Block text has single spaces; the recorded snippet carries a newline + double space.
    const block = "The grace period is short.";
    const r = locateRange(block, "grace\n period  is", 4)!;
    expect(r).not.toBeNull();
    expect(block.slice(r.start, r.end)).toBe("grace period is");
  });
});

describe("placeAnnotations (S-003)", () => {
  it("AS-007: wraps the anchored range in a mark carrying data-anno", () => {
    const root = mountDoc(
      `<p id="block-p-1">Payment expires after 24h unless renewed.</p>
       <p id="block-p-2">The grace period is short.</p>`,
    );
    const annotations: PlaceableAnnotation[] = [
      {
        id: "an-1",
        anchor: { blockId: "block-p-1", textSnippet: "expires after 24h", offset: 8, length: 17 },
      },
    ];

    const { placed, unplaceable } = placeAnnotations(root, annotations);

    expect(unplaceable).toEqual([]);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.id).toBe("an-1");
    const mark = root.querySelector('[data-anno="an-1"]')!;
    expect(mark).not.toBeNull();
    expect(mark.tagName).toBe("MARK");
    expect(mark.textContent).toBe("expires after 24h");
    // The surrounding text is preserved (we split the text node, not the block).
    expect(root.querySelector("#block-p-1")!.textContent).toBe(
      "Payment expires after 24h unless renewed.",
    );
  });

  it("AS-007: resolves the block by data-block-id as well as by id", () => {
    const root = mountDoc(`<p data-block-id="block-h2-3">Stale cache can never bleed across.</p>`);
    const { placed } = placeAnnotations(root, [
      { id: "x", anchor: { blockId: "block-h2-3", textSnippet: "bleed across", offset: 22, length: 12 } },
    ]);
    expect(placed.map((p) => p.id)).toEqual(["x"]);
    expect(root.querySelector('[data-anno="x"]')!.textContent).toBe("bleed across");
  });

  it("GAP-005: a missing block marks the annotation unplaceable, does not crash", () => {
    const root = mountDoc(`<p id="block-p-1">present block</p>`);
    const { placed, unplaceable } = placeAnnotations(root, [
      { id: "ghost", anchor: { blockId: "block-p-999", textSnippet: "anything", offset: 0, length: 8 } },
    ]);
    expect(placed).toEqual([]);
    expect(unplaceable).toEqual(["ghost"]);
    expect(root.querySelector("[data-anno]")).toBeNull();
  });

  it("GAP-005: a zero-match snippet is unplaceable; a duplicate snippet now anchors via offset (FIX 3)", () => {
    // FIX 3 reverses the old "refuse duplicates" rule: a repeated snippet anchors to the occurrence
    // nearest the recorded offset instead of orphaning. Only a ZERO-match snippet stays unplaceable.
    const root = mountDoc(`<p id="b">na na na batman, na not found here</p>`);
    const res = placeAnnotations(root, [
      { id: "dup", anchor: { blockId: "b", textSnippet: "na", offset: 999, length: 2 } },
      { id: "zero", anchor: { blockId: "b", textSnippet: "ZZZ", offset: 0, length: 3 } },
    ]);
    expect(res.placed.map((p) => p.id)).toEqual(["dup"]); // duplicate now placed (nearest to offset)
    expect(res.unplaceable).toEqual(["zero"]); // only the absent snippet orphans
    expect(root.querySelector('[data-anno="dup"]')!.textContent).toBe("na");
    expect(root.querySelector('[data-anno="zero"]')).toBeNull();
  });

  it("AS-011: an isOrphaned annotation gets NO highlight (detached, never anchored)", () => {
    const root = mountDoc(`<p id="b">the v3 onboarding copy block lives here.</p>`);
    const { placed, unplaceable } = placeAnnotations(root, [
      {
        id: "det",
        isOrphaned: true,
        anchor: { blockId: "b", textSnippet: "onboarding copy", offset: 7, length: 15 },
      },
    ]);
    expect(placed).toEqual([]);
    expect(unplaceable).toEqual([]); // not a failure — deliberately skipped
    expect(root.querySelector("[data-anno]")).toBeNull();
  });

  it("REGRESSION: cross-inline highlight wraps without surroundContents (per-text-node)", () => {
    // FIX 1: a selection spanning a <strong> boundary. surroundContents would THROW
    // InvalidStateError (range partially selects a non-Text node) → silently unplaceable.
    // Per-text-node wrapping must produce N>=2 marks whose concatenated text == the selection.
    const root = mountDoc(`<p id="b">Payment <strong>expires</strong> after 24h unless renewed.</p>`);
    const original = root.querySelector("#b")!.textContent;
    // "expires after 24h" starts at offset 8 ("Payment " = 8 chars) and spans the </strong> boundary.
    const { placed, unplaceable } = placeAnnotations(root, [
      { id: "x", anchor: { blockId: "b", textSnippet: "expires after 24h", offset: 8, length: 17 } },
    ]);
    expect(unplaceable).toEqual([]);
    expect(placed.map((p) => p.id)).toEqual(["x"]);
    const marks = root.querySelectorAll('[data-anno="x"]');
    expect(marks.length).toBeGreaterThanOrEqual(2); // spans the inline boundary → multiple marks
    const concatenated = Array.from(marks)
      .map((m) => m.textContent)
      .join("");
    expect(concatenated).toBe("expires after 24h");
    // Re-placing (clear path) unwraps ALL marks and restores the original textContent (normalized).
    placeAnnotations(root, []);
    expect(root.querySelectorAll("[data-anno]")).toHaveLength(0);
    expect(root.querySelector("#b")!.textContent).toBe(original);
  });

  it("FIX 2: anchors a snippet whose recorded whitespace differs from the rendered text", () => {
    // selectionToAnchor stores literal whitespace; rendered textContent collapses it. The normalized
    // matcher tier must still anchor when the snippet has a newline/double-space the block renders flat.
    const root = mountDoc(`<p id="b">The grace period is short and final.</p>`);
    const { placed, unplaceable } = placeAnnotations(root, [
      // snippet has a literal newline + double space where the block has single spaces.
      { id: "ws", anchor: { blockId: "b", textSnippet: "grace\n period  is", offset: 4, length: 16 } },
    ]);
    expect(unplaceable).toEqual([]);
    expect(placed.map((p) => p.id)).toEqual(["ws"]);
    const concatenated = Array.from(root.querySelectorAll('[data-anno="ws"]'))
      .map((m) => m.textContent)
      .join("");
    expect(concatenated).toBe("grace period is");
  });

  it("FIX 3: a repeated snippet lands on the occurrence nearest the recorded offset", () => {
    // "true" appears twice; offset points at the second. Old code refused duplicates → orphan.
    const root = mountDoc(`<p id="b">it is true, and it is also true here.</p>`);
    const text = root.querySelector("#b")!.textContent!;
    const secondOffset = text.indexOf("true", text.indexOf("true") + 1);
    // Record an offset one char shy of the second occurrence so the exact-at-offset path misses and
    // the duplicate-tiebreaker must engage (old code refused → orphan).
    const { placed, unplaceable } = placeAnnotations(root, [
      { id: "t", anchor: { blockId: "b", textSnippet: "true", offset: secondOffset - 1, length: 4 } },
    ]);
    expect(unplaceable).toEqual([]);
    const mark = root.querySelector('[data-anno="t"]') as HTMLElement;
    expect(mark.textContent).toBe("true");
    // It must be the SECOND occurrence: the text before it contains the first "true".
    const before = text.slice(0, secondOffset);
    expect(before).toContain("true");
  });

  it("AS-010: a resolved annotation's mark carries the resolved style hook", () => {
    const root = mountDoc(`<p id="b">The last-admin invariant blocks demotion.</p>`);
    placeAnnotations(root, [
      {
        id: "r",
        status: "resolved",
        anchor: { blockId: "b", textSnippet: "last-admin invariant", offset: 4, length: 20 },
      },
    ]);
    const mark = root.querySelector('[data-anno="r"]') as HTMLElement;
    expect(mark.dataset.resolved).toBe("true");
  });
});
