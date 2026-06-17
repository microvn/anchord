// Selection→anchor + placement (S-005 / C-008). PURE: only the minimal structural DOM surface from
// types.ts — no React, no app/server imports, no `lib.dom`. The SAME functions type-check
// server-side (happy-dom / jsdom) AND compile to the in-iframe IIFE that runs in the opaque sandbox.

import {
  type Anchor,
  type AnchorSegment,
  type DocumentLike,
  type ElementLike,
  type NodeLike,
  type PlaceResult,
  type SelectionLike,
  type UnwrapDocumentLike,
  type UnwrapNodeLike,
  BLOCK_SELECTOR,
  ELEMENT_NODE,
  TEXT_NODE,
  SNIPPET_CAP,
} from "./types";
import { locateRange } from "./locate";

// Extra structural members the selection→anchor walk needs (a real browser, happy-dom and jsdom all
// provide them). Kept here so types.ts stays the minimal placement surface; this is the richer walk
// surface. We keep them loose (members we actually touch) so any DOM impl satisfies them.
interface WalkNode extends NodeLike {
  firstChild: WalkNode | null;
  nextSibling: WalkNode | null;
  childNodes: ArrayLike<WalkNode>;
}
interface WalkElement extends ElementLike, WalkNode {
  ownerDocument: WalkDocument;
  contains(other: ElementLike | null): boolean;
}
interface WalkDocument extends DocumentLike {
  createTreeWalker(root: WalkNode, whatToShow: number): { nextNode(): WalkNode | null };
}

const SHOW_TEXT = 0x4;

/** The block id of an element, or null. injectBlockIds stamps a plain block as `id="block-{tag}-{n}"`
 *  and only falls back to `data-block-id` when the element ALREADY has an author id — so a block is
 *  addressable by EITHER form (a markdown block gets the `id` form). data-block-id wins. */
function blockIdOf(e: ElementLike): string | null {
  // data-block-id wins (the don't-clobber form) and may carry ANY value (a markdown block's author
  // id, or the server `block-…` form). A plain `id` only counts when it's the server `block-…` form
  // (an author's arbitrary `id` is NOT an addressable block).
  const dbi = e.getAttribute("data-block-id");
  if (dbi) return dbi;
  const id = e.getAttribute("id");
  return id && id.startsWith("block-") ? id : null;
}

/** Nearest ancestor element (incl. self) carrying a block id (data-block-id OR id="block-…"). */
function closestBlock(node: NodeLike | null): WalkElement | null {
  let el: NodeLike | null = node;
  while (el) {
    if (el.nodeType === ELEMENT_NODE && blockIdOf(el as ElementLike)) return el as WalkElement;
    el = el.parentNode;
  }
  return null;
}

/**
 * Char offset of (container, containerOffset) within `block`'s concatenated text content. Walks the
 * block's text nodes in document order (TreeWalker SHOW_TEXT), summing lengths until the target is
 * reached. An element-node container (offset = child index) is translated to the text length of the
 * children before that index. Returns the block end if the point isn't found (defensive clamp).
 */
function charOffsetWithin(block: WalkElement, container: NodeLike, containerOffset: number): number {
  if (container.nodeType === ELEMENT_NODE) {
    let acc = 0;
    const kids = (container as WalkNode).childNodes;
    for (let i = 0; i < Math.min(containerOffset, kids.length); i++) acc += (kids[i]!.textContent ?? "").length;
    return offsetOfNode(block, container) + acc;
  }
  return offsetOfNode(block, container) + containerOffset;
}

/** The char offset at which `target`'s text begins within `block`'s concatenated text. */
function offsetOfNode(block: WalkElement, target: NodeLike): number {
  const walker = block.ownerDocument.createTreeWalker(block, SHOW_TEXT);
  let pos = 0;
  let node = walker.nextNode();
  while (node) {
    if (node === target) return pos;
    // If target is an element ancestor of this text node, the element's start is this text's start.
    if (target.nodeType === ELEMENT_NODE && (target as ElementLike).contains(node as unknown as ElementLike)) return pos;
    pos += (node.textContent ?? "").length;
    node = walker.nextNode();
  }
  return pos;
}

function clampOffset(value: number, max: number): number {
  return Math.max(0, Math.min(value, max));
}

/** The block elements intersected by a cross-block range, in document order, INCLUSIVE of start +
 *  end block — found by listing every addressable block (document order) and slicing start→end by
 *  index, then keeping only LEAF blocks (a block containing no OTHER in-range block). Nested block
 *  ids (ol > li > p; table > tr > td) carry the same text at each level; keeping only leaves avoids
 *  double-wrapping. */
function blocksBetween(startBlock: WalkElement, endBlock: WalkElement, doc: WalkDocument): WalkElement[] {
  if (startBlock === endBlock) return [startBlock];
  const all = toArray(doc.querySelectorAll(BLOCK_SELECTOR)).filter((e) => blockIdOf(e)) as WalkElement[];
  const si = all.indexOf(startBlock);
  const ei = all.indexOf(endBlock);
  if (si === -1 || ei === -1) return [startBlock, endBlock]; // defensive: endpoints only
  const slice = all.slice(Math.min(si, ei), Math.max(si, ei) + 1);
  return slice.filter((b) => !slice.some((other) => other !== b && b.contains(other)));
}

function toArray<T>(list: ArrayLike<T>): T[] {
  const out: T[] = [];
  for (let i = 0; i < list.length; i++) out.push(list[i]!);
  return out;
}

/**
 * selectionToAnchor — turn a DOM Selection into a stored Anchor. ONE signature `(selection, doc)`,
 * shared by the FE (markdown, app DOM) and the in-iframe bridge.
 *
 * Single-block selection → `{blockId, textSnippet, offset, length, segments:[one]}`.
 * Cross-block selection → the same top-level fields for the START block PLUS `segments[]` (one per
 *   intersected LEAF block — start partial · full middles · end partial).
 * Empty / collapsed / whitespace-only selection, or a start outside any block → null.
 *
 * The snippet is a verbatim slice of the block's textContent (NOT selection.toString(), whose
 * cross-element \t/\n separators would never re-locate via locateRange).
 */
export function selectionToAnchor(selection: SelectionLike | null, doc: DocumentLike): Anchor | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  if (selection.toString().trim().length === 0) return null; // covers no-real-chars / whitespace-only

  const wdoc = doc as unknown as WalkDocument;
  const range = selection.getRangeAt(0);
  const startBlock = closestBlock(range.startContainer);
  if (!startBlock) return null; // start isn't inside any addressable block → no anchor
  const endBlock = closestBlock(range.endContainer) ?? startBlock;

  // Single block (start === end, or the end fell outside any block): one segment.
  if (endBlock === startBlock) {
    const blockText = startBlock.textContent ?? "";
    const startOff = clampOffset(charOffsetWithin(startBlock, range.startContainer, range.startOffset), blockText.length);
    const endOff = clampOffset(charOffsetWithin(startBlock, range.endContainer, range.endOffset), blockText.length);
    const lo = Math.min(startOff, endOff);
    const hi = Math.max(startOff, endOff);
    const textSnippet = blockText.slice(lo, hi).slice(0, SNIPPET_CAP);
    if (textSnippet.trim().length === 0) return null;
    const blockId = blockIdOf(startBlock)!;
    return { blockId, textSnippet, offset: lo, length: textSnippet.length, segments: [{ blockId, offset: lo, length: textSnippet.length, textSnippet }] };
  }

  // Cross-block: one segment per intersected LEAF block — start partial, full middles, end partial.
  const blocks = blocksBetween(startBlock, endBlock, wdoc);
  const segments: AnchorSegment[] = blocks.map((block) => {
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

function cssEscape(id: string): string {
  return id.replace(/["\\\]\[#.:>+~*^$=()| ]/g, "\\$&");
}

function findBlock(blockId: string, doc: DocumentLike): ElementLike | null {
  return (
    doc.querySelector(`[data-block-id="${cssEscape(blockId)}"]`) ??
    doc.querySelector(`#${cssEscape(blockId)}`)
  );
}

/**
 * placeAnchor — locate an anchor's text within its block in the CURRENT content using the unified
 * C-008 locate ladder (exact → nearest → normalized → fuzzy → not-found). NEVER throws: a missing
 * block / vanished snippet / below-threshold fuzzy all return an `{ok:false}` sentinel so the caller
 * (the iframe bridge especially) degrades into couldn't-place rather than crashing. Computes WHERE;
 * the caller wraps the range in a `<mark data-anno=…>`.
 */
export function placeAnchor(anchor: Anchor, doc: DocumentLike): PlaceResult {
  const el = findBlock(anchor.blockId, doc);
  if (!el) return { ok: false, reason: "no-block" };
  const text = el.textContent ?? "";
  if (anchor.textSnippet.length === 0) return { ok: false, reason: "not-found" };
  const range = locateRange(text, anchor.textSnippet, anchor.offset);
  if (!range) return { ok: false, reason: "not-found" };
  return { ok: true, blockId: anchor.blockId, start: range.start, end: range.end, text: text.slice(range.start, range.end) };
}

/**
 * placeAnchorAll — place EVERY block an anchor spans, one PlaceResult per segment. A multi_range
 * anchor carries `segments[]` (one per intersected block); a single range has none (place the
 * primary). Never throws — each segment degrades to its own `{ok:false}` sentinel.
 */
export function placeAnchorAll(anchor: Anchor, doc: DocumentLike): PlaceResult[] {
  const segs =
    anchor.segments && anchor.segments.length > 1
      ? anchor.segments
      : [{ blockId: anchor.blockId, textSnippet: anchor.textSnippet, offset: anchor.offset, length: anchor.length }];
  return segs.map((seg) => placeAnchor(seg as Anchor, doc));
}

/**
 * unwrapAnnoMarks — remove EVERY `mark[data-anno]`, moving each mark's children out before it, then
 * `.normalize()` the parent so split text nodes re-merge. The "clear" half of the idempotent
 * clear-then-redraw sync. A non-anno `<mark>` is left untouched. No-op + never throws when there are
 * no anno marks.
 */
export function unwrapAnnoMarks(doc: UnwrapDocumentLike): void {
  const marks = toArray(doc.querySelectorAll("mark[data-anno]"));
  for (const mark of marks) {
    const parent = (mark as UnwrapNodeLike).parentNode;
    if (!parent) continue;
    while ((mark as UnwrapNodeLike).firstChild) parent.insertBefore((mark as UnwrapNodeLike).firstChild!, mark as UnwrapNodeLike);
    parent.removeChild(mark as UnwrapNodeLike);
    parent.normalize();
  }
}

export { TEXT_NODE };
