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
} from "../src/features/viewer/annotation-marks";

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

  it("GAP-005: returns null when the snippet occurs more than once (ambiguous)", () => {
    expect(locateRange("na na na batman", "na", 99)).toBeNull();
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

  it("GAP-005: a snippet that matches zero/multiple times is unplaceable, not mis-placed", () => {
    const root = mountDoc(`<p id="b">na na na batman, na not found here</p>`);
    const res = placeAnnotations(root, [
      { id: "dup", anchor: { blockId: "b", textSnippet: "na", offset: 999, length: 2 } },
      { id: "zero", anchor: { blockId: "b", textSnippet: "ZZZ", offset: 0, length: 3 } },
    ]);
    expect(res.placed).toEqual([]);
    expect(res.unplaceable.sort()).toEqual(["dup", "zero"]);
    // Nothing was wrapped — no mis-placement.
    expect(root.querySelector("[data-anno]")).toBeNull();
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
