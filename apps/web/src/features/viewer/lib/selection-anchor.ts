// selection-anchor (S-001, G3 — the selection→anchor half of the pinned anchor contract).
//
// S-005: the selection→anchor logic is now ONE shared, pure module (`@anchord/anchor`) imported by
// BOTH the FE markdown path (here) and the in-iframe sandbox bridge (compiled to an IIFE). This file
// is a thin FE adapter: it keeps the historical one-arg `selectionToAnchor(selection)` call shape the
// markdown viewer uses (use-compose.ts) by deriving the selection's document and delegating to the
// shared `(selection, doc)` implementation — so the markdown anchor behaviour is identical (its tests
// stay green) while the single implementation lives in the shared module.

import {
  selectionToAnchor as sharedSelectionToAnchor,
  SNIPPET_CAP as SHARED_SNIPPET_CAP,
  type Anchor,
} from "@anchord/anchor";

export const SNIPPET_CAP = SHARED_SNIPPET_CAP;

/** The FE-facing anchor shape (segments[] is always present here — single range → one segment). */
export interface SelectionAnchor {
  blockId: string;
  textSnippet: string;
  offset: number;
  length: number;
  segments: { blockId: string; textSnippet: string; offset: number; length: number }[];
}

/** Resolve the owning Document for a live Selection (the markdown viewer runs in the app DOM). */
function documentOf(selection: Selection): Document {
  if (selection.rangeCount > 0) {
    const node = selection.getRangeAt(0).startContainer;
    const doc = node.ownerDocument ?? (node as Document);
    if (doc) return doc;
  }
  return document;
}

/**
 * Build a block anchor from a live Selection (markdown path). Delegates to the shared
 * `selectionToAnchor(selection, doc)`; returns null for an empty / collapsed / whitespace-only
 * selection or a start outside any block. The shared module always emits a `segments[]` (single
 * range → one segment identical to the top-level fields), which the markdown engine relies on.
 */
export function selectionToAnchor(selection: Selection | null): SelectionAnchor | null {
  if (!selection) return null;
  const anchor = sharedSelectionToAnchor(selection as unknown as Parameters<typeof sharedSelectionToAnchor>[0], documentOf(selection));
  if (!anchor) return null;
  return normalizeSegments(anchor);
}

/** Ensure the FE shape always carries a segments[] (the shared module already does for the cases the
 *  markdown viewer hits, but stay defensive so the type stays non-optional). */
function normalizeSegments(anchor: Anchor): SelectionAnchor {
  const segments =
    anchor.segments && anchor.segments.length > 0
      ? anchor.segments
      : [{ blockId: anchor.blockId, textSnippet: anchor.textSnippet, offset: anchor.offset, length: anchor.length }];
  return { blockId: anchor.blockId, textSnippet: anchor.textSnippet, offset: anchor.offset, length: anchor.length, segments };
}
