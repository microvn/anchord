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

/** The block id of an element, or null. injectBlockIds (block-id.ts) stamps a plain block as
 *  `id="block-{tag}-{n}"` and only falls back to `data-block-id` when the element ALREADY has an
 *  author id. So a block is addressable by EITHER form — must accept both, or markdown (whose
 *  blocks get the `id` form) never resolves. Mirrors annotation-marks.ts findBlock + the backend
 *  bridge BLOCK_SELECTOR. */
function blockIdOf(e: HTMLElement): string | null {
  const dbi = e.getAttribute?.("data-block-id");
  if (dbi) return dbi;
  const id = e.id;
  return id && id.startsWith("block-") ? id : null;
}

/** Nearest ancestor element (incl. self) carrying a block id (data-block-id OR id="block-…"). */
function closestBlock(node: Node | null): HTMLElement | null {
  let el: Node | null = node;
  while (el) {
    if (el.nodeType === 1) {
      const e = el as HTMLElement;
      if (blockIdOf(e)) return e;
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

function clampOffset(value: number, max: number): number {
  return Math.max(0, Math.min(value, max));
}

/** The block elements intersected by a cross-block range, in document order, INCLUSIVE of the start
 *  and end block. Found by listing every addressable block under the smallest element that contains
 *  both endpoints (querySelectorAll is document order) and slicing start→end by index — deterministic
 *  + SSR/happy-dom safe (no reliance on range.intersectsNode, which happy-dom may not implement). */
function blocksBetween(startBlock: HTMLElement, endBlock: HTMLElement): HTMLElement[] {
  if (startBlock === endBlock) return [startBlock];
  // Smallest ancestor element that contains BOTH endpoints (the common block container).
  let container: HTMLElement | null = startBlock.parentElement;
  while (container && !container.contains(endBlock)) container = container.parentElement;
  const root: ParentNode = container ?? startBlock.ownerDocument;
  const all = Array.from(
    root.querySelectorAll<HTMLElement>("[data-block-id], [id^='block-']"),
  ).filter((e) => blockIdOf(e));
  const si = all.indexOf(startBlock);
  const ei = all.indexOf(endBlock);
  if (si === -1 || ei === -1) return [startBlock, endBlock]; // defensive: endpoints only
  const slice = all.slice(Math.min(si, ei), Math.max(si, ei) + 1);
  // Keep only LEAF blocks. Markdown lists render as ol > li > p where EACH level carries a block id
  // over the SAME text; an ancestor block in the slice would wrap the same text its descendant does
  // → double-highlight. Drop any block that contains another block in the slice (keep the innermost).
  return slice.filter((b) => !slice.some((other) => other !== b && b.contains(other)));
}

/**
 * Build a block anchor from a live Selection. Returns null for an empty / collapsed /
 * whitespace-only selection, or when the selection's START isn't inside a data-block-id element
 * (C-003). A selection spanning MULTIPLE blocks fans out into one segment per intersected block
 * (start partial · full middles · end partial); the top-level fields mirror the START segment so the
 * primary stays self-placeable as a fallback.
 */
export function selectionToAnchor(selection: Selection | null): SelectionAnchor | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

  const raw = selection.toString();
  // C-003: a selection that covers no real characters (empty or only whitespace) creates nothing.
  if (raw.trim().length === 0) return null;

  const range = selection.getRangeAt(0);
  const startBlock = closestBlock(range.startContainer);
  if (!startBlock) return null; // the selection's start isn't inside any block → no anchor (C-003)
  const endBlock = closestBlock(range.endContainer) ?? startBlock;

  // Single block (start === end, or the end fell outside any block): one segment.
  if (endBlock === startBlock) {
    const blockText = startBlock.textContent ?? "";
    const startOff = clampOffset(charOffsetWithin(startBlock, range.startContainer, range.startOffset), blockText.length);
    // The end offset WITHIN this block. If the end container sits outside the block (the end fell
    // outside any block → endBlock collapsed to startBlock), charOffsetWithin returns the block's
    // end, so the snippet is clamped to this block's own text rather than overrunning.
    const endOff = clampOffset(charOffsetWithin(startBlock, range.endContainer, range.endOffset), blockText.length);
    const lo = Math.min(startOff, endOff);
    const hi = Math.max(startOff, endOff);
    // Snippet from the block's OWN textContent — NOT selection.toString(). selection.toString()
    // inserts \t/\n separators across cells/elements (a table row, multi-element selection) that
    // textContent — what the placement side reads (locateRange) — does NOT have, so such a snippet
    // could never re-locate → "couldn't place". A verbatim slice of textContent always re-locates.
    const textSnippet = blockText.slice(lo, hi).slice(0, SNIPPET_CAP);
    if (textSnippet.trim().length === 0) return null;
    const blockId = blockIdOf(startBlock)!;
    return { blockId, textSnippet, offset: lo, length: textSnippet.length, segments: [{ blockId, offset: lo, length: textSnippet.length, textSnippet }] };
  }

  // Cross-block: one segment per intersected block — start partial, full middles, end partial.
  const blocks = blocksBetween(startBlock, endBlock);
  const segments = blocks.map((block) => {
    const blockId = blockIdOf(block)!;
    const blockText = block.textContent ?? "";
    let offset = 0;
    let slice = blockText;
    if (block === startBlock) {
      offset = clampOffset(charOffsetWithin(block, range.startContainer, range.startOffset), blockText.length);
      slice = blockText.slice(offset);
    } else if (block === endBlock) {
      const end = clampOffset(charOffsetWithin(block, range.endContainer, range.endOffset), blockText.length);
      slice = blockText.slice(0, end);
    }
    const textSnippet = slice.slice(0, SNIPPET_CAP);
    return { blockId, offset, length: textSnippet.length, textSnippet };
  });

  const first = segments[0]!;
  return { blockId: first.blockId, textSnippet: first.textSnippet, offset: first.offset, length: first.length, segments };
}
