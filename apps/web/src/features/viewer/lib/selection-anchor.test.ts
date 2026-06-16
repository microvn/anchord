import { describe, it, expect, beforeEach } from "bun:test";

// selection-anchor (S-001, G3) — the selection→anchor half of the pinned-anchor contract.
// selectionToAnchor reads a live DOM Selection over rendered Markdown and produces the block-anchored
// {blockId, textSnippet, offset, length, segments[]} the create-write sends.
//
// These tests pin the CROSS-BLOCK behaviour: a selection whose start and end live in DIFFERENT blocks
// must fan out into one AnchorSegment per intersected block (start partial · full middles · end
// partial), instead of returning null (the old bug: commonAncestor of a cross-block range is a
// non-block container → closestBlock null → no anchor → no popover).

import { selectionToAnchor, SNIPPET_CAP } from "@/features/viewer/lib/selection-anchor";

/** Mount the given HTML into the document body and return the container. */
function mountDoc(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

/** First text node descendant of an element. */
function firstText(el: Element): Text {
  let n: Node | null = el.firstChild;
  while (n && n.nodeType !== 3) n = n.firstChild ?? n.nextSibling;
  return n as Text;
}

/** Build a Selection over [startNode:startOffset → endNode:endOffset]. */
function selectRange(startNode: Node, startOffset: number, endNode: Node, endOffset: number): Selection {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return sel;
}

beforeEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

describe("selectionToAnchor — single block (regression)", () => {
  it("returns null for no selection / collapsed / whitespace-only", () => {
    expect(selectionToAnchor(null)).toBeNull();
    const root = mountDoc(`<p id="block-p-1">Hello world.</p>`);
    const t = firstText(root.querySelector("#block-p-1")!);
    // collapsed
    const collapsed = selectRange(t, 2, t, 2);
    expect(selectionToAnchor(collapsed)).toBeNull();
  });

  it("a single-block selection → exactly one segment whose fields equal the top-level anchor", () => {
    const root = mountDoc(`<p id="block-p-1">Payment expires after 24h unless renewed.</p>`);
    const t = firstText(root.querySelector("#block-p-1")!);
    // select "expires after 24h" — starts at char 8.
    const sel = selectRange(t, 8, t, 25);
    const anchor = selectionToAnchor(sel)!;
    expect(anchor).not.toBeNull();
    expect(anchor.blockId).toBe("block-p-1");
    expect(anchor.offset).toBe(8);
    expect(anchor.textSnippet).toBe("expires after 24h");
    expect(anchor.length).toBe("expires after 24h".length);
    expect(anchor.segments).toHaveLength(1);
    // The single segment is identical to the top-level anchor fields.
    expect(anchor.segments[0]).toEqual({
      blockId: "block-p-1",
      offset: 8,
      length: "expires after 24h".length,
      textSnippet: "expires after 24h",
    });
  });
});

describe("selectionToAnchor — cross block", () => {
  it("a 2-block selection (start partial + end partial) → 2 segments", () => {
    const root = mountDoc(
      `<p id="block-p-1">First paragraph text here.</p>` +
        `<p id="block-p-2">Second paragraph text here.</p>`,
    );
    const t1 = firstText(root.querySelector("#block-p-1")!);
    const t2 = firstText(root.querySelector("#block-p-2")!);
    // start mid-block-1 (at "paragraph" → char 6), end mid-block-2 (after "Second" → char 6).
    const block1Text = "First paragraph text here.";
    const sel = selectRange(t1, 6, t2, 6);
    const anchor = selectionToAnchor(sel)!;
    expect(anchor).not.toBeNull();
    expect(anchor.segments).toHaveLength(2);

    // segment 0 = start block, covers [6, end of block text]
    expect(anchor.segments[0]!.blockId).toBe("block-p-1");
    expect(anchor.segments[0]!.offset).toBe(6);
    expect(anchor.segments[0]!.textSnippet).toBe(block1Text.slice(6));
    expect(anchor.segments[0]!.length).toBe(block1Text.slice(6).length);

    // segment 1 = end block, covers [0, endOffset)
    expect(anchor.segments[1]!.blockId).toBe("block-p-2");
    expect(anchor.segments[1]!.offset).toBe(0);
    expect(anchor.segments[1]!.textSnippet).toBe("Second");
    expect(anchor.segments[1]!.length).toBe("Second".length);

    // top-level fields = the START block's segment exactly.
    expect(anchor.blockId).toBe("block-p-1");
    expect(anchor.offset).toBe(6);
    expect(anchor.textSnippet).toBe(block1Text.slice(6));
    expect(anchor.length).toBe(block1Text.slice(6).length);
  });

  it("a 3-block selection → 3 segments, the middle one covers the full middle block", () => {
    const root = mountDoc(
      `<p id="block-p-1">Alpha block one.</p>` +
        `<p id="block-p-2">Beta block two.</p>` +
        `<p id="block-p-3">Gamma block three.</p>`,
    );
    const t1 = firstText(root.querySelector("#block-p-1")!);
    const t3 = firstText(root.querySelector("#block-p-3")!);
    const block1Text = "Alpha block one.";
    const sel = selectRange(t1, 6, t3, 5); // "block one." ... "Gamma"
    const anchor = selectionToAnchor(sel)!;
    expect(anchor.segments).toHaveLength(3);

    expect(anchor.segments[0]!.blockId).toBe("block-p-1");
    expect(anchor.segments[0]!.offset).toBe(6);
    expect(anchor.segments[0]!.textSnippet).toBe(block1Text.slice(6));

    // middle = full block text, offset 0
    expect(anchor.segments[1]!.blockId).toBe("block-p-2");
    expect(anchor.segments[1]!.offset).toBe(0);
    expect(anchor.segments[1]!.textSnippet).toBe("Beta block two.");
    expect(anchor.segments[1]!.length).toBe("Beta block two.".length);

    expect(anchor.segments[2]!.blockId).toBe("block-p-3");
    expect(anchor.segments[2]!.offset).toBe(0);
    expect(anchor.segments[2]!.textSnippet).toBe("Gamma");
    expect(anchor.segments[2]!.length).toBe("Gamma".length);
  });

  it("caps each segment's snippet at SNIPPET_CAP", () => {
    const long = "x".repeat(SNIPPET_CAP + 50);
    const root = mountDoc(
      `<p id="block-p-1">${long}</p>` + `<p id="block-p-2">${long}</p>`,
    );
    const t1 = firstText(root.querySelector("#block-p-1")!);
    const t2 = firstText(root.querySelector("#block-p-2")!);
    const sel = selectRange(t1, 0, t2, long.length);
    const anchor = selectionToAnchor(sel)!;
    expect(anchor.segments).toHaveLength(2);
    for (const seg of anchor.segments) {
      expect(seg.textSnippet.length).toBeLessThanOrEqual(SNIPPET_CAP);
    }
  });

  it("falls back to null when the start point isn't inside any block", () => {
    const root = mountDoc(`<div>no block id here<p id="block-p-2">but here</p></div>`);
    const looseText = firstText(root); // the bare "no block id here" text
    const t2 = firstText(root.querySelector("#block-p-2")!);
    const sel = selectRange(looseText, 0, t2, 3);
    expect(selectionToAnchor(sel)).toBeNull();
  });
});
