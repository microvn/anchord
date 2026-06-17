// @anchord/anchor — shared anchor model (S-005 / C-008).
//
// ONE source for the selection→anchor + placement (locate ladder) logic, imported by the FE
// markdown path AND inlined (compiled to an IIFE) into the backend's in-iframe sandbox bridge.
// PURE: no React, no app/server imports, no `lib.dom` reliance — only the minimal structural DOM
// surface below, so the SAME module type-checks server-side (happy-dom / jsdom) and compiles to a
// browser IIFE that runs inside the opaque sandbox.

/** One segment of a (possibly multi-) range anchor. A single range has one segment. */
export interface AnchorSegment {
  blockId: string;
  textSnippet: string;
  offset: number;
  length: number;
}

/**
 * Anchor descriptor (block-anchored text range). Structurally compatible with the backend's
 * `Anchor` and the FE's `SelectionAnchor`/`MarkAnchor` — those re-export this shape so the one
 * module serves all three callers without a cast.
 */
export interface Anchor {
  blockId: string;
  textSnippet: string;
  offset: number;
  length: number;
  /** Present only for a multi_range (cross-block) selection; a single range omits it. */
  segments?: AnchorSegment[];
}

/** Located char range within a block's text content, or a couldn't-place sentinel. */
export type PlaceResult =
  | { ok: true; blockId: string; start: number; end: number; text: string }
  | { ok: false; reason: "no-block" | "not-found" | "ambiguous" };

// --- Minimal structural DOM types (so this module type-checks without `lib.dom`). happy-dom,
// jsdom, and a real browser all satisfy these; we only use the members declared here.

export interface NodeLike {
  nodeType: number;
  parentNode: NodeLike | null;
  textContent: string | null;
}
export interface ElementLike extends NodeLike {
  closest(selector: string): ElementLike | null;
  getAttribute(name: string): string | null;
  contains(other: ElementLike | null): boolean;
}
export interface RangeLike {
  startContainer: NodeLike;
  startOffset: number;
  endContainer: NodeLike;
  endOffset: number;
}
export interface SelectionLike {
  isCollapsed: boolean;
  rangeCount: number;
  toString(): string;
  getRangeAt(i: number): RangeLike;
}
export interface DocumentLike {
  querySelectorAll(selector: string): ArrayLike<ElementLike>;
  querySelector(selector: string): ElementLike | null;
}

// --- DOM mutation surface for unwrap (the "clear" half of clear-then-redraw). Kept minimal so it
// type-checks server-side; happy-dom / jsdom / a real browser all satisfy them.
export interface UnwrapNodeLike {
  parentNode: UnwrapNodeLike | null;
  firstChild: UnwrapNodeLike | null;
  insertBefore(node: UnwrapNodeLike, ref: UnwrapNodeLike | null): UnwrapNodeLike;
  removeChild(node: UnwrapNodeLike): UnwrapNodeLike;
  normalize(): void;
}
export interface UnwrapDocumentLike {
  querySelectorAll(selector: string): ArrayLike<UnwrapNodeLike>;
}

export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;

/** Max chars stored in text_snippet — keeps the anchor jsonb bounded. */
export const SNIPPET_CAP = 400;

/** CSS selector matching either block-id attribute form (plain `id="block-…"` OR `data-block-id`). */
export const BLOCK_SELECTOR = '[data-block-id], [id^="block-"]';
