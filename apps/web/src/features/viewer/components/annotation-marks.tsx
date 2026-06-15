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
  /** S-002 (C-002): a `redline` mark renders the red strikethrough + red-tint instead of the teal
   *  highlight. Absent → an ordinary comment/like/label highlight. */
  kind?: "redline";
  /** S-002 (AS-007): a drifted redline whose pinned span no longer matches the current version —
   *  rendered in a DISTINCT muted/dashed style (not a confident strike), and not acceptable. */
  stale?: boolean;
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

/**
 * All Text descendants of `root` in document order. A manual recursive descent rather than
 * `createTreeWalker(SHOW_TEXT)` because happy-dom 15's walker does NOT descend into nested inline
 * elements (`<strong>`, `<a>`, `<code>`) — it would silently drop their text, corrupting char-offset
 * accounting for cross-inline ranges. A snapshot array is returned so callers can mutate the tree
 * (split/replace nodes) while iterating without invalidating live traversal.
 */
function textNodesOf(root: Node): Text[] {
  const out: Text[] = [];
  const visit = (n: Node) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) out.push(c as Text);
      else if (c.nodeType === 1) visit(c);
    }
  };
  visit(root);
  return out;
}

function cssEscape(value: string): string {
  // happy-dom lacks CSS.escape in some builds; a conservative manual escape covers block ids
  // (which are server-generated `block-{tag}-{n}`, but stay defensive against odd ids).
  return value.replace(/["\\\]#.:>+~*^$|=()[ ]/g, "\\$&");
}

/**
 * Whitespace-normalize a string: collapse every run of whitespace to a single space and trim the
 * ends. Returns the normalized text plus a `map[]` from each normalized-char index → its original
 * index, so a hit in normalized space can be translated back to original (node-walkable) offsets.
 * Adopted from Plannotator's `normalizeWithMap` (Apache-2.0).
 */
function normalizeWithMap(text: string): { text: string; map: number[] } {
  let normalized = "";
  const map: number[] = [];
  let inWhitespace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      if (!inWhitespace) {
        normalized += " ";
        map.push(i);
        inWhitespace = true;
      }
    } else {
      normalized += ch;
      map.push(i);
      inWhitespace = false;
    }
  }
  let start = 0;
  let end = normalized.length;
  while (start < end && normalized[start] === " ") start++;
  while (end > start && normalized[end - 1] === " ") end--;
  return { text: normalized.slice(start, end), map: map.slice(start, end) };
}

/**
 * Locate the [start,end) character range of the snippet within the block's text content, in tiers:
 *   1. exact at the recorded `offset`;
 *   2. whitespace-normalized match (Plannotator normalizeWithMap) — the recorded snippet may carry
 *      literal whitespace the rendered text collapses (newlines, indentation); match in normalized
 *      space then translate back to original offsets;
 *   3. raw indexOf fallback — when the snippet occurs >1 time, pick the occurrence whose start is
 *      NEAREST the recorded `offset` (the offset disambiguates; refusing duplicates would orphan a
 *      short repeated snippet — FIX 3);
 *   4. zero occurrences → null (couldn't place, GAP-005).
 * Returns char offsets into the concatenated text of the block.
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
  // 3. raw fuzzy: gather every occurrence, pick the one nearest the recorded offset.
  const raw = nearestOccurrence(blockText, snippet, offset);
  if (raw) return raw;
  // 2. normalized: collapse whitespace on both sides, match, translate the hit back via the map.
  const haystack = normalizeWithMap(blockText);
  const needle = normalizeWithMap(snippet).text;
  if (needle.length > 0) {
    const normIdx = haystack.text.indexOf(needle);
    if (normIdx !== -1) {
      const originalStart = haystack.map[normIdx]!;
      const originalEnd = haystack.map[normIdx + needle.length - 1]! + 1;
      return { start: originalStart, end: originalEnd };
    }
  }
  return null; // 4. zero matches
}

/** All start indices of `snippet` in `text`; pick the one whose start is nearest `offset`. */
function nearestOccurrence(
  text: string,
  snippet: string,
  offset: number,
): { start: number; end: number } | null {
  let from = 0;
  let best = -1;
  let bestDist = Infinity;
  for (;;) {
    const at = text.indexOf(snippet, from);
    if (at === -1) break;
    const dist = Math.abs(at - offset);
    if (dist < bestDist) {
      bestDist = dist;
      best = at;
    }
    from = at + 1;
  }
  if (best === -1) return null;
  return { start: best, end: best + snippet.length };
}

/**
 * Wrap [start,end) of a block's text in `<mark data-anno=id>` highlights, IN PLACE. A range that
 * crosses inline boundaries (`<strong>`, `<a>`, `<code>`) spans multiple text nodes — `surroundContents`
 * THROWS InvalidStateError on those (the range partially selects a non-Text node), so instead we wrap
 * EACH intersected text node's covered slice in its own mark. One annotation id → N marks.
 *
 * The slices are wrapped in REVERSE document order so splitting/replacing an earlier text node never
 * invalidates the (still-live) references to later nodes (Plannotator's per-text-node trick, Apache-2.0).
 *
 * Returns the created mark elements (>=1) in document order, or [] if the range couldn't be realised
 * against the live nodes (defensive — treated as couldn't-place).
 */
function wrapRange(block: HTMLElement, range: { start: number; end: number }, id: string): HTMLElement[] {
  const doc = block.ownerDocument;

  // Collect each intersected text node's covered slice {node, start, end} (offsets local to the node).
  const slices: { node: Text; start: number; end: number }[] = [];
  let pos = 0;
  for (const node of textNodesOf(block)) {
    const len = node.data.length;
    const nodeStart = pos;
    const nodeEnd = pos + len;
    // Overlap of [range.start,range.end) with this node's [nodeStart,nodeEnd).
    const sliceStart = Math.max(range.start, nodeStart) - nodeStart;
    const sliceEnd = Math.min(range.end, nodeEnd) - nodeStart;
    if (sliceEnd > sliceStart) slices.push({ node, start: sliceStart, end: sliceEnd });
    if (nodeEnd >= range.end) break;
    pos = nodeEnd;
  }
  if (slices.length === 0) return [];

  const makeMark = (): HTMLElement => {
    const mark = doc.createElement("mark");
    mark.className = MARK_CLASS;
    mark.setAttribute("data-anno", id);
    return mark;
  };

  const marks: HTMLElement[] = [];
  // REVERSE order: replacing an earlier text node would invalidate later node refs otherwise.
  for (let i = slices.length - 1; i >= 0; i--) {
    const { node: text, start, end } = slices[i]!;
    const before = text.data.slice(0, start);
    const mid = text.data.slice(start, end);
    const after = text.data.slice(end);
    const mark = makeMark();
    mark.textContent = mid;
    const frag = doc.createDocumentFragment();
    if (before) frag.appendChild(doc.createTextNode(before));
    frag.appendChild(mark);
    if (after) frag.appendChild(doc.createTextNode(after));
    text.replaceWith(frag);
    marks.unshift(mark); // unshift to keep document order in the returned list
  }
  return marks;
}

/**
 * PURE: place each anchored annotation as a highlight mark in `docRoot`. Idempotent-ish — call on
 * freshly-rendered content; existing marks are cleared first so a re-place doesn't double-wrap.
 */
export function placeAnnotations(
  docRoot: HTMLElement,
  annotations: PlaceableAnnotation[],
): PlaceResult {
  // Clear any prior marks (unwrap) so re-runs are stable. One id may map to N marks (cross-inline
  // ranges); unwrap them all and normalize() each parent so split text nodes re-merge.
  const parentsToNormalize = new Set<Node>();
  docRoot.querySelectorAll<HTMLElement>(MARK_SELECTOR).forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parentsToNormalize.add(parent);
  });
  parentsToNormalize.forEach((p) => (p as Element).normalize());

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
    const marks = wrapRange(block, range, ann.id);
    if (marks.length === 0) {
      unplaceable.push(ann.id);
      continue;
    }
    // One id → N marks (cross-inline range). Tag resolved on each; report the first as the anchor el.
    if (ann.status === "resolved") marks.forEach((m) => (m.dataset.resolved = "true"));
    // S-002: tag the redline kind + stale state so the CSS renders the red strike / muted-dashed
    // stale style (C-002/AS-007). A stale redline is the muted-dashed, NOT a confident red strike.
    if (ann.kind === "redline") {
      marks.forEach((m) => {
        m.dataset.annoKind = "redline";
        if (ann.stale) m.dataset.annoStale = "true";
      });
    }
    placed.push({ id: ann.id, el: marks[0]! });
  }

  return { placed, unplaceable };
}

/**
 * Hook: place marks against the live doc element, keep focus/resolved styling in sync, and wire
 * click-on-mark → focus its thread (AS-008). Re-runs when the content element, the annotations,
 * or the focused id changes.
 *
 * BUG #1 (2026-06-12): placing marks must happen in EXACTLY ONE place — this POST-COMMIT effect.
 * The screen previously ALSO called placeAnnotations inside a render-time useMemo (to derive the
 * unplaceable ids), a DOM side-effect during render. We now report the unplaceable ids FROM this
 * effect (via onUnplaceable) so the screen no longer needs that side-effecting memo. The effect's
 * deps (`contentEl`, `annotations`) are stable across a selection re-render — react-query keeps the
 * annotations array referentially stable — so selecting text triggers NO re-place.
 */
export function useAnnotationMarks(
  contentEl: HTMLElement | null,
  annotations: PlaceableAnnotation[],
  focusedId: string | null,
  onFocusAnno: (id: string) => void,
  /** Reports which annotations couldn't be anchored at runtime (GAP-005), lifted out of a
   *  render-time memo into this post-commit effect (BUG #1). */
  onUnplaceable?: (ids: string[]) => void,
): void {
  // Place / re-place marks when the content or the annotation set changes.
  useEffect(() => {
    if (!contentEl) return;
    const { unplaceable } = placeAnnotations(contentEl, annotations);
    onUnplaceable?.(unplaceable);
    // onUnplaceable is intentionally omitted from deps: it's a setter-wrapper the caller memoizes;
    // re-placing on every identity change of it would defeat the single-place guarantee.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
