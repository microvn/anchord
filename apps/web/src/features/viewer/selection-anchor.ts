// selection-anchor (S-001, G3 — the selection→anchor half of the pinned anchor contract). PURE,
// no React, JSDOM/happy-dom testable. Given a DOM Selection over rendered Markdown (app origin),
// produce the block-anchored `{blockId, textSnippet, offset, length, segments[]}` the create-write
// sends. The anchor→highlight half lives in annotation-marks.ts (placeAnnotations); the two are
// symmetric so a freshly-created annotation re-places onto the same range.
//
// Contract (Clarifications "Anchor contract", MD path):
//   - walk up from the selection's common ancestor to the nearest element carrying data-block-id;
//   - within that block's text, capture text_snippet (the selected substring, capped), offset
//     (char offset of the selection start within the block text), length;
//   - a selection spanning blocks → segments[], one {blockId, offset, length} per block (here we
//     emit the primary block's anchor + a single-segment list; cross-block fan-out is a later add).
//   - empty / whitespace-only selection → null (C-003: never creates an annotation).

/** Cap on the stored snippet so a giant selection doesn't bloat the anchor; matches the read side
 *  staying able to locate it (a longer real selection still anchors via offset). */
export const SNIPPET_CAP = 400;

export interface SelectionAnchor {
  blockId: string;
  textSnippet: string;
  offset: number;
  length: number;
  segments: { blockId: string; textSnippet: string; offset: number; length: number }[];
}

/** Nearest ancestor element (incl. self) carrying a data-block-id, walking up from `node`. */
function closestBlock(node: Node | null): HTMLElement | null {
  let el: Node | null = node;
  while (el) {
    if (el.nodeType === 1) {
      const e = el as HTMLElement;
      if (e.hasAttribute?.("data-block-id")) return e;
    }
    el = el.parentNode;
  }
  return null;
}

/**
 * Char offset of (container, containerOffset) within `block`'s concatenated text content. Walks
 * the block's text nodes in document order, summing lengths until the target node is reached.
 * Returns 0 if the point isn't found within the block (defensive — start of block).
 */
function charOffsetWithin(block: HTMLElement, container: Node, containerOffset: number): number {
  // A point inside an element node (container is the element, offset = child index): translate to
  // the text length of the children before that index.
  if (container.nodeType === 1) {
    let acc = 0;
    const children = Array.from(container.childNodes).slice(0, containerOffset);
    for (const c of children) acc += (c.textContent ?? "").length;
    // Then add the offset of `container` itself within the block.
    return offsetOfNode(block, container) + acc;
  }
  return offsetOfNode(block, container) + containerOffset;
}

/** The char offset at which `target`'s text begins within `block`'s concatenated text. */
function offsetOfNode(block: HTMLElement, target: Node): number {
  const doc = block.ownerDocument;
  const walker = doc.createTreeWalker(block, 0x4 /* SHOW_TEXT */);
  let pos = 0;
  let node = walker.nextNode();
  while (node) {
    if (node === target) return pos;
    // If target is an element ancestor of this text node, the element's start is this text's start.
    if (target.nodeType === 1 && target.contains(node)) return pos;
    pos += (node as Text).data.length;
    node = walker.nextNode();
  }
  return pos;
}

/**
 * Build a block anchor from a live Selection. Returns null for an empty / collapsed /
 * whitespace-only selection, or when the selection isn't inside a data-block-id element (C-003).
 */
export function selectionToAnchor(selection: Selection | null): SelectionAnchor | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

  const raw = selection.toString();
  // C-003: a selection that covers no real characters (empty or only whitespace) creates nothing.
  if (raw.trim().length === 0) return null;

  const range = selection.getRangeAt(0);
  const block = closestBlock(range.commonAncestorContainer);
  if (!block) return null;

  const blockText = block.textContent ?? "";
  let offset = charOffsetWithin(block, range.startContainer, range.startOffset);
  if (offset < 0 || offset > blockText.length) offset = Math.max(0, Math.min(offset, blockText.length));

  const length = raw.length;
  const textSnippet = raw.slice(0, SNIPPET_CAP);
  const blockId = block.getAttribute("data-block-id")!;

  const segment = { blockId, offset, length, textSnippet };
  return { blockId, textSnippet, offset, length, segments: [segment] };
}
