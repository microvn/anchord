// annotation-marks (S-003): the anchor↔highlight engine. Two parts:
//   1. placeAnnotations — a PURE function (no React, JSDOM-testable) that takes the rendered
//      doc DOM + the annotation list and wraps each anchored annotation's quoted text range in a
//      <mark data-anno=<id>> highlight, pairing quote↔highlight by the annotation id. It reports
//      which annotations placed and which could NOT be placed (GAP-005: zero/multiple matches,
//      block missing) — those are NEVER crashed on and NEVER mis-placed; their thread still shows
//      in the rail, flagged, with no scroll target.
//   2. useAnnotationMarks — a hook that runs placeAnnotations against the live DocPane element
//      after render, keeps the focus/resolved classes in sync, and wires click→focus pairing.
//
// Anchor contract (pinned in annotation-core-ui-commenting § Clarifications "Anchor contract"):
//   anchor {blockId, textSnippet, offset, length} →
//     1. find the element whose id OR data-block-id === blockId;
//     2. locate textSnippet at offset (exact), else a single fuzzy match within the block;
//     3. wrap the matched char range in a mark carrying data-anno=<id>;
//     4. zero / multiple / block-missing → "couldn't place" (GAP-005), not a crash.

import { useEffect } from "react";

export interface MarkAnchor {
  blockId: string;
  textSnippet: string;
  offset: number;
  length: number;
}

export interface PlaceableAnnotation {
  id: string;
  anchor: MarkAnchor;
  /** Backend-detached annotations (isOrphaned) get NO highlight (C-004); they live in the rail's
   *  detached section instead. They are skipped here so they never render as if still anchored. */
  isOrphaned?: boolean;
  status?: "unresolved" | "resolved";
}

export interface PlaceResult {
  placed: { id: string; el: HTMLElement }[];
  /** annotation ids that could not be anchored at runtime (GAP-005) — thread shown, flagged. */
  unplaceable: string[];
}

const MARK_CLASS = "anno-mark";
export const MARK_SELECTOR = `[data-anno]`;

/** Find the block element for an anchor: id OR data-block-id === blockId. */
function findBlock(root: ParentNode, blockId: string): HTMLElement | null {
  // Escape for the attribute selector; the id form uses getElementById-style lookup via querySelector.
  const byBlock = root.querySelector<HTMLElement>(`[data-block-id="${cssEscape(blockId)}"]`);
  if (byBlock) return byBlock;
  return root.querySelector<HTMLElement>(`#${cssEscape(blockId)}`);
}

function cssEscape(value: string): string {
  // happy-dom lacks CSS.escape in some builds; a conservative manual escape covers block ids
  // (which are server-generated `block-{tag}-{n}`, but stay defensive against odd ids).
  return value.replace(/["\\\]#.:>+~*^$|=()[ ]/g, "\\$&");
}

/**
 * Locate the [start,end) character range of the snippet within the block's text content.
 * Exact at `offset` first; if that doesn't match, a fuzzy locate = the snippet must occur
 * EXACTLY ONCE in the block text (a single unambiguous match). Zero or multiple → null
 * (couldn't place). Returns char offsets into the concatenated text of the block.
 */
export function locateRange(
  blockText: string,
  snippet: string,
  offset: number,
): { start: number; end: number } | null {
  if (snippet.length === 0) return null;
  // 1. exact: the snippet sits at the recorded offset.
  if (offset >= 0 && blockText.substr(offset, snippet.length) === snippet) {
    return { start: offset, end: offset + snippet.length };
  }
  // 2. fuzzy: a single unambiguous occurrence anywhere in the block.
  const first = blockText.indexOf(snippet);
  if (first === -1) return null; // zero matches
  const second = blockText.indexOf(snippet, first + 1);
  if (second !== -1) return null; // multiple matches → ambiguous, refuse (GAP-005)
  return { start: first, end: first + snippet.length };
}

/**
 * Wrap [start,end) of a block's text in a <mark data-anno=id> in place. Walks the block's text
 * nodes, splitting at the boundaries. Returns the created mark element, or null if the range
 * couldn't be realised against the live nodes (defensive — treated as couldn't-place).
 */
function wrapRange(block: HTMLElement, range: { start: number; end: number }, id: string): HTMLElement | null {
  const doc = block.ownerDocument;
  const walker = doc.createTreeWalker(block, 0x4 /* NodeFilter.SHOW_TEXT */);
  let pos = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;

  let node = walker.nextNode() as Text | null;
  while (node) {
    const len = node.data.length;
    if (startNode === null && pos + len > range.start) {
      startNode = node;
      startOffset = range.start - pos;
    }
    if (pos + len >= range.end) {
      endNode = node;
      endOffset = range.end - pos;
      break;
    }
    pos += len;
    node = walker.nextNode() as Text | null;
  }
  if (!startNode || !endNode) return null;

  // For a single-text-node range (the common case), split precisely and wrap the middle.
  if (startNode === endNode) {
    const text = startNode;
    const before = text.data.slice(0, startOffset);
    const mid = text.data.slice(startOffset, endOffset);
    const after = text.data.slice(endOffset);
    const mark = doc.createElement("mark");
    mark.className = MARK_CLASS;
    mark.setAttribute("data-anno", id);
    mark.textContent = mid;
    const frag = doc.createDocumentFragment();
    if (before) frag.appendChild(doc.createTextNode(before));
    frag.appendChild(mark);
    if (after) frag.appendChild(doc.createTextNode(after));
    text.replaceWith(frag);
    return mark;
  }

  // Cross-node range: wrap with a DOM Range surround when possible, else bail (couldn't place).
  try {
    const r = doc.createRange();
    r.setStart(startNode, startOffset);
    r.setEnd(endNode, endOffset);
    const mark = doc.createElement("mark");
    mark.className = MARK_CLASS;
    mark.setAttribute("data-anno", id);
    r.surroundContents(mark);
    return mark;
  } catch {
    return null;
  }
}

/**
 * PURE: place each anchored annotation as a highlight mark in `docRoot`. Idempotent-ish — call on
 * freshly-rendered content; existing marks are cleared first so a re-place doesn't double-wrap.
 */
export function placeAnnotations(
  docRoot: HTMLElement,
  annotations: PlaceableAnnotation[],
): PlaceResult {
  // Clear any prior marks (unwrap) so re-runs are stable.
  docRoot.querySelectorAll<HTMLElement>(MARK_SELECTOR).forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  });

  const placed: { id: string; el: HTMLElement }[] = [];
  const unplaceable: string[] = [];

  for (const ann of annotations) {
    if (ann.isOrphaned) continue; // detached: no highlight (C-004) — handled by the rail.
    const block = findBlock(docRoot, ann.anchor.blockId);
    if (!block) {
      unplaceable.push(ann.id); // block missing (GAP-005)
      continue;
    }
    const range = locateRange(block.textContent ?? "", ann.anchor.textSnippet, ann.anchor.offset);
    if (!range) {
      unplaceable.push(ann.id); // zero / multiple matches (GAP-005)
      continue;
    }
    const mark = wrapRange(block, range, ann.id);
    if (!mark) {
      unplaceable.push(ann.id);
      continue;
    }
    if (ann.status === "resolved") mark.dataset.resolved = "true";
    placed.push({ id: ann.id, el: mark });
  }

  return { placed, unplaceable };
}

/**
 * Hook: place marks against the live doc element, keep focus/resolved styling in sync, and wire
 * click-on-mark → focus its thread (AS-008). Re-runs when the content element, the annotations,
 * or the focused id changes.
 */
export function useAnnotationMarks(
  contentEl: HTMLElement | null,
  annotations: PlaceableAnnotation[],
  focusedId: string | null,
  onFocusAnno: (id: string) => void,
): void {
  // Place / re-place marks when the content or the annotation set changes.
  useEffect(() => {
    if (!contentEl) return;
    placeAnnotations(contentEl, annotations);
  }, [contentEl, annotations]);

  // Click-on-mark → focus its thread (event delegation on the content element).
  useEffect(() => {
    if (!contentEl) return;
    const handler = (e: Event) => {
      const target = e.target as HTMLElement | null;
      const mark = target?.closest?.(MARK_SELECTOR) as HTMLElement | null;
      if (mark?.dataset.anno) onFocusAnno(mark.dataset.anno);
    };
    contentEl.addEventListener("click", handler);
    return () => contentEl.removeEventListener("click", handler);
  }, [contentEl, onFocusAnno]);

  // Keep the focus emphasis class in sync with the focused id.
  useEffect(() => {
    if (!contentEl) return;
    contentEl.querySelectorAll<HTMLElement>(MARK_SELECTOR).forEach((m) => {
      m.classList.toggle("anno-mark--focus", m.dataset.anno === focusedId);
    });
  }, [contentEl, focusedId, annotations]);
}

/** Scroll the highlight for `id` into view + emphasise it (AS-009). Returns the mark, if any. */
export function scrollToAnno(contentEl: HTMLElement | null, id: string): HTMLElement | null {
  if (!contentEl) return null;
  const mark = contentEl.querySelector<HTMLElement>(`[data-anno="${id}"]`);
  if (mark) mark.scrollIntoView({ behavior: "smooth", block: "center" });
  return mark;
}
