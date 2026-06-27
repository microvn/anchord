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
  scrollToAnno,
  resolveAnnoTarget,
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

  it("REGRESSION: a range spanning a whitespace-only text node creates NO empty mark (no stray dot)", () => {
    // A corrupt/boundary-spanning anchor whose range covers a whitespace-only text node (e.g. the
    // newline text between block elements) must NOT wrap that node in its own <mark> — an empty
    // whitespace mark renders as a 2px-wide "dot" dropped onto its own line. Only text-bearing
    // slices become marks; the whitespace stays unwrapped.
    const root = mountDoc(`<p id="b">alpha<span>\n  \n</span>beta</p>`);
    const blockText = root.querySelector("#b")!.textContent!; // "alpha\n  \nbeta"
    const { placed, unplaceable } = placeAnnotations(root, [
      { id: "x", anchor: { blockId: "b", textSnippet: blockText, offset: 0, length: blockText.length } },
    ]);
    expect(unplaceable).toEqual([]);
    expect(placed.map((p) => p.id)).toEqual(["x"]);
    const marks = Array.from(root.querySelectorAll('[data-anno="x"]'));
    // No mark is whitespace-only (the stray-dot artifact).
    expect(marks.every((m) => (m.textContent ?? "").trim().length > 0)).toBe(true);
    // The visible words are still highlighted.
    expect(marks.map((m) => m.textContent)).toEqual(["alpha", "beta"]);
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

  it("AS-004: a redline mark carries the redline kind hook (red strike), NOT the teal highlight", () => {
    // annotation-core-ui-types-modes S-002: a delete-kind suggestion renders the red strikethrough +
    // red-tint. placeAnnotations tags the mark `data-anno-kind=redline` so the CSS applies the strike;
    // it must NOT carry the stale hook (the span still matches the current version).
    const root = mountDoc(`<p id="b">Implementation Plan: Real-time Collaboration.</p>`);
    const { placed, unplaceable } = placeAnnotations(root, [
      {
        id: "rl",
        kind: "redline",
        anchor: { blockId: "b", textSnippet: "Real-time Collaboration", offset: 20, length: 23 },
      },
    ]);
    expect(unplaceable).toEqual([]);
    expect(placed.map((p) => p.id)).toEqual(["rl"]);
    const mark = root.querySelector('[data-anno="rl"]') as HTMLElement;
    expect(mark.dataset.annoKind).toBe("redline");
    expect(mark.dataset.annoStale).toBeUndefined();
    // C-002: the doc content is NOT edited — the struck text is still present in the block.
    expect(root.querySelector("#b")!.textContent).toBe("Implementation Plan: Real-time Collaboration.");
  });

  it("AS-007: a STALE redline mark carries the stale hook (muted/dashed), distinct from a confident strike", () => {
    // S-002 (C-002): a drifted redline renders a DISTINCT stale style, not a confident strike on
    // possibly-wrong text. placeAnnotations tags `data-anno-stale=true` so the CSS uses the muted-
    // dashed treatment. (The kind hook is still present so the rail/badge can identify it as a redline.)
    const root = mountDoc(`<p id="b">Implementation Plan: Real-time Collaboration.</p>`);
    placeAnnotations(root, [
      {
        id: "stale-rl",
        kind: "redline",
        stale: true,
        anchor: { blockId: "b", textSnippet: "Real-time Collaboration", offset: 20, length: 23 },
      },
    ]);
    const mark = root.querySelector('[data-anno="stale-rl"]') as HTMLElement;
    expect(mark.dataset.annoKind).toBe("redline");
    expect(mark.dataset.annoStale).toBe("true");
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

// Cross-block (multi_range): a selection spanning blocks anchors as segments[]; placeAnnotations must
// place a highlight in EVERY segment's block (not just the primary), tagging them all uniformly.
describe("placeAnnotations — multi-segment (cross-block)", () => {
  const TWO = `<p data-block-id="b1">First block text here.</p><p data-block-id="b2">Second block text here.</p>`;

  it("places a highlight in EVERY block of a multi-segment anchor", () => {
    const root = mountDoc(TWO);
    placeAnnotations(root, [
      {
        id: "m1",
        anchor: {
          blockId: "b1",
          textSnippet: "block text here.",
          offset: 6,
          length: 16,
          segments: [
            { blockId: "b1", textSnippet: "block text here.", offset: 6, length: 16 },
            { blockId: "b2", textSnippet: "Second", offset: 0, length: 6 },
          ],
        },
      },
    ]);
    expect(root.querySelector('[data-block-id="b1"] [data-anno="m1"]')).not.toBeNull();
    expect(root.querySelector('[data-block-id="b2"] [data-anno="m1"]')).not.toBeNull();
  });

  it("tags the type hue on the marks of ALL segments", () => {
    const root = mountDoc(TWO);
    placeAnnotations(root, [
      {
        id: "m2",
        hue: "#cbb24a",
        anchor: {
          blockId: "b1",
          textSnippet: "block text here.",
          offset: 6,
          length: 16,
          segments: [
            { blockId: "b1", textSnippet: "block text here.", offset: 6, length: 16 },
            { blockId: "b2", textSnippet: "Second", offset: 0, length: 6 },
          ],
        },
      },
    ]);
    const marks = Array.from(root.querySelectorAll('[data-anno="m2"]')) as HTMLElement[];
    expect(marks.length).toBeGreaterThanOrEqual(2);
    for (const m of marks) expect(m.dataset.annoHue).toBe("true");
  });

  it("still places the resolvable segments when one segment's block is missing", () => {
    const root = mountDoc(`<p data-block-id="b1">First block text here.</p>`); // b2 absent
    const { unplaceable } = placeAnnotations(root, [
      {
        id: "m3",
        anchor: {
          blockId: "b1",
          textSnippet: "block text here.",
          offset: 6,
          length: 16,
          segments: [
            { blockId: "b1", textSnippet: "block text here.", offset: 6, length: 16 },
            { blockId: "b2", textSnippet: "Second", offset: 0, length: 6 },
          ],
        },
      },
    ]);
    expect(root.querySelector('[data-block-id="b1"] [data-anno="m3"]')).not.toBeNull();
    expect(unplaceable).not.toContain("m3"); // at least one segment placed → not unplaceable
  });
});

// pinpoint S-003 (AS-007/AS-008/AS-009/AS-009b, C-002/C-004): a `type=block` annotation marks the
// WHOLE block ELEMENT (outline/tint) via a DISTINCT `data-block-anno` attribute — never a wrapped
// text sub-range — and reuses the same interaction surfaces (hover peek / click pin / rail focus) as
// a range, resolved independently so a nested range `<mark data-anno>` never steals the block's hit.
describe("placeAnnotations — block annotation (pinpoint S-003)", () => {
  it("AS-007: a block annotation marks the whole block element via data-block-anno (NOT a wrapped sub-range)", () => {
    const root = mountDoc(
      `<p data-block-id="block-p-7">The whole paragraph is the annotation target here.</p>`,
    );
    const block = root.querySelector('[data-block-id="block-p-7"]') as HTMLElement;
    const { placed, unplaceable } = placeAnnotations(root, [
      {
        id: "blk-1",
        type: "block",
        anchor: {
          blockId: "block-p-7",
          textSnippet: "The whole paragraph is the annotation target here.",
          offset: 0,
          length: 50,
        },
      },
    ]);
    expect(unplaceable).toEqual([]);
    expect(placed.map((p) => p.id)).toEqual(["blk-1"]);
    // The marker is keyed on data-block-anno on the BLOCK element itself — distinct from a range's data-anno.
    expect(block.dataset.blockAnno).toBe("blk-1");
    expect(block.classList.contains("anno-block-mark")).toBe(true);
    // It is NOT a wrapped text sub-range: no <mark data-anno> was created.
    expect(root.querySelector("[data-anno]")).toBeNull();
    // The placed el reported for focus/scroll IS the block element.
    expect(placed[0]!.el).toBe(block);
    // The block's text is untouched (no wrapping).
    expect(block.textContent).toBe("The whole paragraph is the annotation target here.");
  });

  it("AS-007: a comment block carries its type hue (--mark-hue), a redline block the redline hook (red)", () => {
    const root = mountDoc(
      `<p data-block-id="block-c">comment block</p><p data-block-id="block-r">redline block</p>`,
    );
    placeAnnotations(root, [
      { id: "c", type: "block", hue: "#cbb24a", anchor: { blockId: "block-c", textSnippet: "comment block", offset: 0, length: 13 } },
      { id: "r", type: "block", kind: "redline", anchor: { blockId: "block-r", textSnippet: "redline block", offset: 0, length: 13 } },
    ]);
    const cBlock = root.querySelector('[data-block-id="block-c"]') as HTMLElement;
    const rBlock = root.querySelector('[data-block-id="block-r"]') as HTMLElement;
    // amber-tinted block outline: the --mark-hue prop + the hue hook, reusing the shared system.
    expect(cBlock.dataset.annoHue).toBe("true");
    expect(cBlock.style.getPropertyValue("--mark-hue")).toBe("#cbb24a");
    // redline block → red (the redline kind hook; the hue is ignored, as for a range redline).
    expect(rBlock.dataset.annoKind).toBe("redline");
    expect(rBlock.dataset.annoHue).toBeUndefined();
  });

  it("AS-007: a block annotation whose block is missing is unplaceable (GAP-005), not a crash", () => {
    const root = mountDoc(`<p data-block-id="block-here">present</p>`);
    const { placed, unplaceable } = placeAnnotations(root, [
      { id: "ghost-blk", type: "block", anchor: { blockId: "block-gone", textSnippet: "x", offset: 0, length: 1 } },
    ]);
    expect(placed).toEqual([]);
    expect(unplaceable).toEqual(["ghost-blk"]);
    expect(root.querySelector("[data-block-anno]")).toBeNull();
  });

  it("AS-007: re-placing clears a prior block mark (idempotent — no stale data-block-anno)", () => {
    const root = mountDoc(`<p data-block-id="block-p-7">a block</p>`);
    const block = root.querySelector('[data-block-id="block-p-7"]') as HTMLElement;
    placeAnnotations(root, [
      { id: "blk-1", type: "block", anchor: { blockId: "block-p-7", textSnippet: "a block", offset: 0, length: 7 } },
    ]);
    expect(block.dataset.blockAnno).toBe("blk-1");
    // Re-place with an empty set → the block mark is removed (no lingering attribute/class).
    placeAnnotations(root, []);
    expect(block.dataset.blockAnno).toBeUndefined();
    expect(block.classList.contains("anno-block-mark")).toBe(false);
  });

  it("AS-008/C-004: resolveAnnoTarget matches a block mark by data-block-anno (the SAME resolver as a range mark)", () => {
    const root = mountDoc(`<p data-block-id="block-p-7">Out of <strong>scope</strong> block.</p>`);
    placeAnnotations(root, [
      { id: "blk-1", type: "block", anchor: { blockId: "block-p-7", textSnippet: "Out of scope block.", offset: 0, length: 19 } },
    ]);
    const block = root.querySelector('[data-block-id="block-p-7"]') as HTMLElement;
    const inline = root.querySelector("strong") as HTMLElement;
    // A hover/click on the bare block area (or inline content inside it, with no nested range) resolves
    // to the BLOCK annotation — the same way a range mark resolves to its data-anno.
    expect(resolveAnnoTarget(block)?.id).toBe("blk-1");
    expect(resolveAnnoTarget(inline)?.id).toBe("blk-1");
    expect(resolveAnnoTarget(block)?.el).toBe(block);
  });

  it("AS-009: scrollToAnno finds a block annotation's element by data-block-anno (shared focusedId)", () => {
    const root = mountDoc(`<p data-block-id="block-p-7">A block annotation row.</p>`);
    placeAnnotations(root, [
      { id: "blk-1", type: "block", anchor: { blockId: "block-p-7", textSnippet: "A block annotation row.", offset: 0, length: 23 } },
    ]);
    const block = root.querySelector('[data-block-id="block-p-7"]') as HTMLElement;
    // A range row finds [data-anno]; a block row must find [data-block-anno] — the rail row click path.
    const found = scrollToAnno(root, "blk-1");
    expect(found).toBe(block);
  });

  it("AS-009b: a block + a nested range on the SAME block resolve independently (innermost wins)", () => {
    // The block carries BOTH a whole-block annotation (data-block-anno) AND a nested range annotation
    // (a <mark data-anno> wrapping a phrase inside it). A hit inside the nested range must resolve to
    // the RANGE; a hit on the bare block area must resolve to the BLOCK — the nested mark never steals it.
    const root = mountDoc(
      `<p data-block-id="block-p-7">Margin text and a <em>highlighted phrase</em> after it.</p>`,
    );
    placeAnnotations(root, [
      // The block annotation on the whole paragraph...
      { id: "blk-1", type: "block", anchor: { blockId: "block-p-7", textSnippet: "Margin text and a highlighted phrase after it.", offset: 0, length: 46 } },
      // ...AND a range annotation on the phrase "highlighted phrase" inside it.
      { id: "rng-1", anchor: { blockId: "block-p-7", textSnippet: "highlighted phrase", offset: 18, length: 18 } },
    ]);
    const block = root.querySelector('[data-block-id="block-p-7"]') as HTMLElement;
    const rangeMark = root.querySelector('[data-anno="rng-1"]') as HTMLElement;
    expect(block.dataset.blockAnno).toBe("blk-1");
    expect(rangeMark).not.toBeNull();
    // A hit inside the nested range resolves to the RANGE (innermost wins, not the container block).
    expect(resolveAnnoTarget(rangeMark)?.id).toBe("rng-1");
    // A hit on the bare block area (a text node child outside any range mark) resolves to the BLOCK.
    const bareTextNode = block.firstChild as Node; // "Margin text and a " — outside the range mark
    expect(resolveAnnoTarget(bareTextNode.parentElement === block ? block : bareTextNode as unknown as Element)?.id).toBe("blk-1");
    // And directly on the block element itself → the block.
    expect(resolveAnnoTarget(block)?.id).toBe("blk-1");
  });
});
