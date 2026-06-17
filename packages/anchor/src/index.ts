// @anchord/anchor — public surface. ONE shared anchor module (S-005 / C-008): the FE markdown path
// imports these directly; the in-iframe sandbox bridge inlines the compiled IIFE (iife-entry.ts).
export type {
  Anchor,
  AnchorSegment,
  PlaceResult,
  NodeLike,
  ElementLike,
  RangeLike,
  SelectionLike,
  DocumentLike,
  UnwrapNodeLike,
  UnwrapDocumentLike,
} from "./types";
export { SNIPPET_CAP, BLOCK_SELECTOR, ELEMENT_NODE, TEXT_NODE } from "./types";
export { locateRange, nearestOccurrence, normalizeWithMap, fuzzyLocate, similarity, levenshtein } from "./locate";
export { selectionToAnchor, placeAnchor, placeAnchorAll, unwrapAnnoMarks } from "./anchor";
