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

import { useCallback, useEffect, useRef } from "react";
// S-005: the locate ladder (exact → nearest → whitespace-normalized → fuzzy) is the ONE shared
// matcher in @anchord/anchor — the SAME ladder the in-iframe sandbox bridge uses (C-008). Re-exported
// here so existing FE importers/tests keep importing `locateRange` from this module.
import { locateRange } from "@anchord/anchor";
export { locateRange };

export interface MarkAnchor {
  blockId: string;
  textSnippet: string;
  offset: number;
  length: number;
  /** Present for a multi_range (cross-block) selection — one entry per intersected block. When set
   *  (length > 1) placeAnnotations highlights EACH segment's block, not just the primary. A single
   *  range omits it (or carries one segment identical to the top-level fields). */
  segments?: { blockId: string; textSnippet: string; offset: number; length: number }[];
}

export interface PlaceableAnnotation {
  id: string;
  /** pinpoint S-003 (C-002/C-004): when `"block"`, this is a whole-block annotation — the marker is
   *  placed on the block ELEMENT (outline/tint) via the DISTINCT `data-block-anno` attribute, NOT a
   *  wrapped text sub-range. Any other value (or absent) → the normal text-range wrap. */
  type?: string;
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
  /** S-007 (C-009): this mark's status chip is toggled OFF, so its highlight is DIMMED (de-emphasized)
   *  in the doc — distinct from the resolved/redline/stale styles, which convey lifecycle, not filter
   *  state. Rendered via a `data-anno-filtered` hook the CSS reads. Absent/false → not dimmed. */
  filtered?: boolean;
  /** DESIGN.md type/tool palette: the highlight HUE (a CSS colour) for this mark — a label/like mark
   *  carries its preset colour, a plain comment the Comment amber, so the content reads multi-colour
   *  (the mark + its rail row share the hue). A redline ignores this (the red strike wins via `kind`);
   *  absent → the default teal accent. Set as a `--mark-hue` custom prop the CSS reads, so ONE rule
   *  tints any hue without N type classes. */
  hue?: string;
}

export interface PlaceResult {
  placed: { id: string; el: HTMLElement }[];
  /** annotation ids that could not be anchored at runtime (GAP-005) — thread shown, flagged. */
  unplaceable: string[];
}

const MARK_CLASS = "anno-mark";
// pinpoint S-003 (C-004): a whole-block annotation marks the block ELEMENT, keyed on a DISTINCT
// attribute so `closest()` resolves a nested range `<mark data-anno>` and its container block
// independently — a hit inside the range focuses the range, a hit on bare block area the block.
const BLOCK_MARK_CLASS = "anno-block-mark";
const BLOCK_MARK_ATTR = "data-block-anno";
// The shared resolver matches BOTH a range mark (`data-anno`) and a block mark (`data-block-anno`);
// `closest()` walks ancestors innermost-first, so a hit inside a nested range still wins the range.
export const MARK_SELECTOR = `[data-anno],[${BLOCK_MARK_ATTR}]`;

// pinpoint S-002: a block-pick TARGET is any element carrying a positional block id — either form
// the server emits (`data-block-id` for markdown, `id="block-…"` for the sandbox HTML, mirrored in
// findBlock above). The hover-outline + click both resolve the nearest such ancestor of the event
// target, so a click on inline content inside a block still picks the whole block.
export const BLOCK_PICK_SELECTOR = '[data-block-id], [id^="block-"]';
// pinpoint S-002 (AS-003): the transient hover-outline class toggled on the block under the cursor in
// Pinpoint mode. Styled in styles.css; here we only own the data hook + the toggle lifecycle.
const BLOCK_HOVER_CLASS = "anno-block-hover";

/** pinpoint S-002 (AS-003/AS-006b): resolve the pickable block for an event target — the nearest
 *  ancestor carrying a block id WHOSE text is non-empty. An empty block (`<hr>`, image-only, an empty
 *  paragraph) has no text so it is NOT a pick target (the outline never appears, the click is a
 *  no-op). Returns the block id + element, or null. PURE (no React) so it is directly testable. */
export function resolvePickableBlock(target: EventTarget | null): { blockId: string; element: HTMLElement } | null {
  const el = target instanceof Element ? target : null;
  const block = el?.closest?.(BLOCK_PICK_SELECTOR) as HTMLElement | null;
  if (!block) return null;
  // AS-006b: an empty / whitespace-only block is not annotatable — never a pick target.
  if ((block.textContent ?? "").trim().length === 0) return null;
  const blockId = block.getAttribute("data-block-id") ?? block.id;
  if (!blockId) return null;
  return { blockId, element: block };
}

/** pinpoint S-003 (C-004): read the annotation id off a mark element, from EITHER a range mark's
 *  `data-anno` or a block mark's `data-block-anno`. A range mark always wins on its own element (it
 *  never carries both), and `closest(MARK_SELECTOR)` already walks innermost-first, so a nested range
 *  resolves before its container block. */
function annoIdOf(el: HTMLElement | null | undefined): string | undefined {
  return el?.dataset.anno ?? el?.dataset.blockAnno;
}

/** pinpoint S-003 (C-004): the SHARED hover/click resolver. Given an event target (an Element or a
 *  Text node's container), find the nearest annotation mark — a range `[data-anno]` OR a block
 *  `[data-block-anno]` — and return its id + element. `closest()` walks ancestors innermost-first, so
 *  a hit inside a nested range `<mark>` resolves to the RANGE, while a hit on bare block area resolves
 *  to the BLOCK (AS-009b). Returns null when the target is outside any mark. PURE / testable. */
export function resolveAnnoTarget(
  target: EventTarget | Node | null,
): { id: string; el: HTMLElement } | null {
  // A Text node has no closest(); resolve from its parent element instead.
  const el =
    target instanceof Element
      ? target
      : target && (target as Node).nodeType === 3
        ? (target as Node).parentElement
        : null;
  const mark = el?.closest?.(MARK_SELECTOR) as HTMLElement | null;
  const id = annoIdOf(mark);
  if (!mark || !id) return null;
  return { id, el: mark };
}

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
    // Skip a slice that is ENTIRELY whitespace: wrapping a whitespace-only text node (e.g. the
    // newline text between block elements that a boundary-spanning/corrupt range can reach) yields
    // an empty <mark> that renders as a stray 2px "dot" on its own line. Only text-bearing slices
    // become marks; the whitespace stays unwrapped (invisible either way).
    if (sliceEnd > sliceStart && node.data.slice(sliceStart, sliceEnd).trim().length > 0) {
      slices.push({ node, start: sliceStart, end: sliceEnd });
    }
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

/** pinpoint S-003: strip a block mark's attribute + class + lifecycle/hue hooks from a block element,
 *  so a re-place leaves no stale block annotation behind (the block-mark counterpart of unwrapping a
 *  range `<mark>`). Idempotent. */
function clearBlockMark(block: HTMLElement): void {
  block.removeAttribute(BLOCK_MARK_ATTR);
  block.classList.remove(BLOCK_MARK_CLASS, "anno-mark--focus");
  delete block.dataset.resolved;
  delete block.dataset.annoFiltered;
  delete block.dataset.annoKind;
  delete block.dataset.annoStale;
  delete block.dataset.annoHue;
  block.style.removeProperty("--mark-hue");
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
  docRoot.querySelectorAll<HTMLElement>("[data-anno]").forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parentsToNormalize.add(parent);
  });
  parentsToNormalize.forEach((p) => (p as Element).normalize());
  // pinpoint S-003: clear any prior BLOCK marks too — they live ON the block element (no unwrap), so
  // strip the attribute + class/hue hooks so a re-place leaves no stale block-anno behind.
  docRoot.querySelectorAll<HTMLElement>(`[${BLOCK_MARK_ATTR}]`).forEach((b) => clearBlockMark(b));

  const placed: { id: string; el: HTMLElement }[] = [];
  const unplaceable: string[] = [];

  for (const ann of annotations) {
    if (ann.isOrphaned) continue; // detached: no highlight (C-004) — handled by the rail.

    // pinpoint S-003 (C-002/C-004): a `type=block` annotation marks the whole block ELEMENT, not a
    // text sub-range. Branch BEFORE the locate/wrap path: find the block, tag the ELEMENT with the
    // DISTINCT `data-block-anno` attribute + the outline class (reusing the same lifecycle/hue hooks),
    // so it reads independently from any nested range `<mark data-anno>`. A missing block → GAP-005.
    if (ann.type === "block") {
      const block = findBlock(docRoot, ann.anchor.blockId);
      if (!block) {
        unplaceable.push(ann.id);
        continue;
      }
      block.classList.add(BLOCK_MARK_CLASS);
      block.setAttribute(BLOCK_MARK_ATTR, ann.id);
      if (ann.status === "resolved") block.dataset.resolved = "true";
      if (ann.filtered) block.dataset.annoFiltered = "true";
      if (ann.kind === "redline") {
        block.dataset.annoKind = "redline";
        if (ann.stale) block.dataset.annoStale = "true";
      } else if (ann.hue) {
        // Reuse the shared `--mark-hue` system (NOT a new hue scheme) for the block outline/tint.
        block.dataset.annoHue = "true";
        block.style.setProperty("--mark-hue", ann.hue);
      }
      placed.push({ id: ann.id, el: block });
      continue;
    }

    // A multi_range anchor carries segments[] (one per intersected block); place EACH. A single
    // range has no segments (or one identical to the top-level fields) → place the primary anchor.
    const segs =
      ann.anchor.segments && ann.anchor.segments.length > 1
        ? ann.anchor.segments
        : [
            {
              blockId: ann.anchor.blockId,
              textSnippet: ann.anchor.textSnippet,
              offset: ann.anchor.offset,
              length: ann.anchor.length,
            },
          ];

    // Place every segment that resolves; collect the marks across all of them under the one id. A
    // segment whose block is missing or whose snippet doesn't match is skipped (GAP-005) — the rest
    // still highlight (the backend detaches the whole annotation if ALL are lost; at runtime we show
    // what we can). Cross-inline ranges still yield N marks per segment.
    const marks: HTMLElement[] = [];
    for (const seg of segs) {
      const block = findBlock(docRoot, seg.blockId);
      if (!block) continue;
      const range = locateRange(block.textContent ?? "", seg.textSnippet, seg.offset);
      if (!range) continue;
      marks.push(...wrapRange(block, range, ann.id));
    }
    if (marks.length === 0) {
      unplaceable.push(ann.id); // no segment resolved (block missing / zero|multiple matches, GAP-005)
      continue;
    }

    // Tag EVERY mark (across all segments) uniformly so a multi-block highlight reads consistently.
    if (ann.status === "resolved") marks.forEach((m) => (m.dataset.resolved = "true"));
    // S-007 (C-009): a mark whose status chip is toggled off is DIMMED. Orthogonal to the lifecycle
    // styles (resolved/redline/stale) — they all still read, just de-emphasized while filtered out.
    if (ann.filtered) marks.forEach((m) => (m.dataset.annoFiltered = "true"));
    // S-002: tag the redline kind + stale state so the CSS renders the red strike / muted-dashed
    // stale style (C-002/AS-007). A stale redline is the muted-dashed, NOT a confident red strike.
    if (ann.kind === "redline") {
      marks.forEach((m) => {
        m.dataset.annoKind = "redline";
        if (ann.stale) m.dataset.annoStale = "true";
      });
    } else if (ann.hue) {
      // DESIGN.md type/tool palette: tint a non-redline mark with its type/label hue (the rail row +
      // its mark share a colour) via a --mark-hue custom prop the CSS reads. Skipped for redlines
      // (the red strike wins) and for a hue-less default (the teal accent).
      marks.forEach((m) => {
        m.dataset.annoHue = "true";
        m.style.setProperty("--mark-hue", ann.hue!);
      });
    }
    placed.push({ id: ann.id, el: marks[0]! }); // report the first mark as the anchor el (focus/scroll)
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
/** S-001: the hover-peek event — the annotation id under the cursor + the HOVERED mark's OWN rect
 *  (C-008: never `placed.el`, so a multi_range's lower segment anchors to itself). `null` = no peek. */
export interface HoverPeek {
  annoId: string;
  rect: DOMRect;
}

/** S-002 (C-001/C-004): the click-to-PIN options for useAnnotationMarks. Absent → the click only
 *  focuses (S-003 back-compat). When present, a marker click ALSO carries the clicked mark's OWN rect
 *  up so the caller can pin a floating card anchored there (C-008: the clicked mark, never placed.el).
 *  Suppression (C-001) is SELECTION-based, identical to the peek: a marker click pins ONLY when there
 *  is no in-progress / non-empty text selection (the annotate-create flow owns that gesture); it pins
 *  for ANY active tool. The probe is read LIVE inside the delegated listener (no stale closure). */
export interface PinOptions {
  /** C-001 (selection-based): true while a non-collapsed text selection exists → no pin. Optional:
   *  absent → the live `window.getSelection()` collapsed/empty read. Injectable for the test env. */
  isSelectionActive?: () => boolean;
  /** Called with the clicked mark's id + its OWN rect when the click is NOT suppressed by a selection. */
  onPinMark: (peek: HoverPeek) => void;
}

/** S-001 (C-001/C-008): the hover-peek options for useAnnotationMarks. Absent → no hover behavior
 *  (back-compat: existing callers that only place + focus pass nothing). */
export interface HoverPeekOptions {
  /** C-001 (selection-based, NOT tool-based): the peek is SUPPRESSED only while a non-collapsed /
   *  non-empty text selection exists — the user is mid-annotate, so the annotate-create flow owns the
   *  gesture. It is shown for ANY active tool (Markup is the resting default; there is no none/read
   *  tool, so tool-identity can't gate). Optional: absent → read the live `window.getSelection()`
   *  collapsed/empty state. Read via a ref inside the delegated listener so it never sees a stale
   *  closure value (the contract's stale-closure guard); injectable for the layout-less test env. */
  isSelectionActive?: () => boolean;
  /** The dwell interval before a hover shows the peek (~200ms in production; tiny under test). */
  dwellMs?: number;
  /** Called with the peek (on dwell) or `null` (on leave / suppression). */
  onHoverPeek: (peek: HoverPeek | null) => void;
}

const DEFAULT_DWELL_MS = 200;

/** Default selection probe (C-001): true when the live window selection is non-collapsed AND carries
 *  actual text — i.e. the user is mid-annotate. A collapsed caret or empty/absent selection → false,
 *  so the peek is shown. SSR / no-window → false. */
function hasActiveTextSelection(): boolean {
  if (typeof window === "undefined" || typeof window.getSelection !== "function") return false;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  return sel.toString().trim().length > 0;
}

export function useAnnotationMarks(
  contentEl: HTMLElement | null,
  annotations: PlaceableAnnotation[],
  focusedId: string | null,
  onFocusAnno: (id: string) => void,
  /** Reports which annotations couldn't be anchored at runtime (GAP-005), lifted out of a
   *  render-time memo into this post-commit effect (BUG #1). */
  onUnplaceable?: (ids: string[]) => void,
  /** S-001: hover-peek (dwell) detection on the shared doc-pane listener. Absent → no hover. */
  hover?: HoverPeekOptions,
  /** S-002: click-to-pin on the shared doc-pane listener. Absent → click only focuses (back-compat). */
  pin?: PinOptions,
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

  // Click-on-mark → focus its thread (event delegation on the content element). S-002: when a `pin`
  // option is wired, a non-suppressed click ALSO pins the full card at the CLICKED mark's own rect
  // (C-008). Suppression (C-001) is SELECTION-based: a click that ended a text selection (the user is
  // mid-annotate) focuses but does NOT pin (the annotate-create flow owns the gesture, AS-013) — it
  // pins for ANY active tool. The pin handler/probe live in a ref so the listener binds once and never
  // reads a stale closure (the same stale-closure guard as the hover path).
  const pinRef = useRef(pin);
  pinRef.current = pin;
  useEffect(() => {
    if (!contentEl) return;
    const handler = (e: Event) => {
      // S-003 (C-004): resolve a range mark (data-anno) OR a block mark (data-block-anno), innermost
      // wins — a click inside a nested range focuses the range, on bare block area the block.
      const resolved = resolveAnnoTarget(e.target);
      if (!resolved) return;
      const { id, el: mark } = resolved;
      onFocusAnno(id);
      const pinOpts = pinRef.current;
      if (!pinOpts) return;
      // C-001 (AS-013): a non-collapsed text selection in progress → focus only, no pin.
      const selectionActive = (pinOpts.isSelectionActive ?? hasActiveTextSelection)();
      if (selectionActive) return;
      pinOpts.onPinMark({ annoId: id, rect: mark.getBoundingClientRect() });
    };
    contentEl.addEventListener("click", handler);
    return () => contentEl.removeEventListener("click", handler);
    // onFocusAnno is stable per caller; pin is read live through pinRef so a handler change never
    // re-binds and never goes stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentEl, onFocusAnno]);

  // S-001: hover (dwell) detection → the read-only peek. Detected on the SHARED content listener via
  // mouseover/mouseout (which BUBBLE, unlike mouseenter/mouseleave) with a relatedTarget check.
  //
  // (a) Entering a mark starts a dwell timer (~200ms); the callback re-checks the cursor is still
  //     over the SAME mark before showing — a fast sweep cancels every pending timer (AS-025).
  // (b) The anchor rect is the HOVERED mark's OWN getBoundingClientRect (e.target.closest), never
  //     placed.el — so a multi_range's lower segment anchors to itself (C-008 / AS-022).
  // (c) Moving between two marks that share one data-anno is NOT a leave — coalesced by id (C-008).
  // (d) C-001 (SELECTION-based, NOT tool-based): the suppression probe is read through a ref so the
  //     delegated handler never sees a stale closure value; the peek is suppressed ONLY while a
  //     non-collapsed text selection exists (the user is mid-annotate). It shows for ANY active tool
  //     (AS-003) — Markup is the resting default; there is no none/read tool, so tool-identity can't
  //     gate. Default probe reads the live `window.getSelection()`.
  //
  // The handlers/options live in refs so the listener is bound ONCE (not re-bound per render) and
  // always reads the latest probe/callback — avoiding the stale-closure hazard the contract calls out.
  const hoverRef = useRef(hover);
  hoverRef.current = hover;
  useEffect(() => {
    if (!contentEl || !hover) return;
    const dwellMs = hover.dwellMs ?? DEFAULT_DWELL_MS;

    let pendingId: string | null = null; // the mark id whose dwell timer is armed (not yet shown)
    let pendingMark: HTMLElement | null = null;
    let shownId: string | null = null; // the annotation id whose peek is currently shown
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pendingId = null;
      pendingMark = null;
    };
    const hide = () => {
      clearTimer();
      if (shownId !== null) {
        shownId = null;
        hoverRef.current?.onHoverPeek(null);
      }
    };

    const selectionActive = () => (hoverRef.current?.isSelectionActive ?? hasActiveTextSelection)();

    const onOver = (e: Event) => {
      const opts = hoverRef.current;
      if (!opts) return;
      // (d) C-001: a non-collapsed text selection is in progress → no peek (annotate-create owns it).
      if (selectionActive()) {
        hide();
        return;
      }
      const target = (e as MouseEvent).target as HTMLElement | null;
      const mark = target?.closest?.(MARK_SELECTOR) as HTMLElement | null;
      const id = annoIdOf(mark); // a range mark (data-anno) OR a block mark (data-block-anno)
      if (!mark || !id) return; // not over a mark — leave any shown peek to onOut to clear
      // (c) Already showing this annotation, OR already dwelling on it → coalesce, do nothing.
      if (id === shownId || (id === pendingId && timer)) return;
      // A new mark (or a different annotation): re-arm the dwell timer on it.
      clearTimer();
      pendingId = id;
      pendingMark = mark;
      timer = setTimeout(() => {
        timer = null;
        // Re-check the cursor is still over the same mark before showing (the dwell guard).
        const stillThere = pendingMark;
        if (!stillThere || annoIdOf(stillThere) !== id) return;
        if (selectionActive()) return; // a selection began during the dwell → suppress
        pendingId = null;
        pendingMark = null;
        shownId = id;
        hoverRef.current?.onHoverPeek({ annoId: id, rect: stillThere.getBoundingClientRect() });
      }, dwellMs);
    };

    const onOut = (e: Event) => {
      const ev = e as MouseEvent;
      const fromMark = (ev.target as HTMLElement | null)?.closest?.(MARK_SELECTOR) as HTMLElement | null;
      const fromId = annoIdOf(fromMark);
      if (!fromId) return;
      const related = ev.relatedTarget as HTMLElement | null;
      const toMark = related?.closest?.(MARK_SELECTOR) as HTMLElement | null;
      const toId = annoIdOf(toMark);
      // (c) Coalesce: moving to another mark with the SAME annotation id is NOT a leave.
      if (toId && toId === fromId) {
        // Keep the dwelling mark pointed at the segment under the cursor (so the dwell guard passes).
        if (pendingId === fromId) pendingMark = toMark;
        return;
      }
      // Left this annotation's marks (to plain text, another annotation, or out): cancel + hide.
      hide();
    };

    contentEl.addEventListener("mouseover", onOver);
    contentEl.addEventListener("mouseout", onOut);
    return () => {
      contentEl.removeEventListener("mouseover", onOver);
      contentEl.removeEventListener("mouseout", onOut);
      clearTimer();
    };
    // Bind ONCE per content element (+ whether hover is enabled at all). The tool flag + callback are
    // read live through hoverRef, so a tool/handler change never re-binds and never goes stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentEl, Boolean(hover)]);

  // Keep the focus emphasis class in sync with the focused id.
  useEffect(() => {
    if (!contentEl) return;
    contentEl.querySelectorAll<HTMLElement>(MARK_SELECTOR).forEach((m) => {
      // S-003 (C-004): the SAME focus emphasis for a range mark (data-anno) and a block mark
      // (data-block-anno) — both read focusedId off the shared annoIdOf.
      m.classList.toggle("anno-mark--focus", annoIdOf(m) === focusedId);
    });
  }, [contentEl, focusedId, annotations]);
}

/** Scroll the highlight for `id` into view + emphasise it (AS-009). Returns the mark, if any. */
export function scrollToAnno(contentEl: HTMLElement | null, id: string): HTMLElement | null {
  if (!contentEl) return null;
  // S-003 (C-004): a rail row may target a range mark (data-anno) OR a block mark (data-block-anno) —
  // the shared focusedId linkage finds either, so a block row scrolls/focuses its block element.
  const esc = cssEscape(id);
  const mark = contentEl.querySelector<HTMLElement>(
    `[data-anno="${esc}"],[${BLOCK_MARK_ATTR}="${esc}"]`,
  );
  if (mark) mark.scrollIntoView({ behavior: "smooth", block: "center" });
  return mark;
}

/** pinpoint S-002 (AS-004): the block-pick payload — the picked block's id, its element, and its
 *  OWN bounding rect (so the caller can synthesize the popover position there — the same role the
 *  selection rect plays in the text path). */
export interface BlockPick {
  blockId: string;
  element: HTMLElement;
  rect: DOMRect;
}

/**
 * pinpoint S-002 (AS-003/AS-004/C-001): hover-outline + click block targeting on the doc pane, ACTIVE
 * only in Pinpoint mode (`enabled`). It is a SEPARATE listener pair from useAnnotationMarks' click/
 * hover (which target EXISTING marks) — this targets BLOCKS to CREATE a new one:
 *
 *  (AS-003) mouseover a pickable block → add the hover-outline class; mouseout (to a non-same block) →
 *           remove it. An empty/zero-length block is never a target (resolvePickableBlock returns null,
 *           so no outline), so AS-006b's "the block never carries a hover-outline pick target" holds.
 *  (AS-004) click a pickable block → report the pick (blockId + element + the block's own rect) so the
 *           caller opens the 5-type popover there. The caller clears the outline when the popover is
 *           dismissed (the lifecycle lives in the screen; `clearHoverOutline` is exposed for that).
 *
 * Disabled (Select mode) → no listeners bound, no outline, so a block click does nothing special and
 * the normal text-selection create path owns the doc (C-001 mutual exclusivity).
 */
export function useBlockPick(
  contentEl: HTMLElement | null,
  enabled: boolean,
  onPick: (pick: BlockPick) => void,
): { clearHoverOutline: () => void } {
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  // Track the currently-outlined block so we can clear it on leave, on a new pick, or on demand
  // (the screen calls clearHoverOutline when it dismisses the synthesized popover).
  const outlinedRef = useRef<HTMLElement | null>(null);

  const clearHoverOutline = useCallback(() => {
    if (outlinedRef.current) {
      outlinedRef.current.classList.remove(BLOCK_HOVER_CLASS);
      outlinedRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!contentEl || !enabled) {
      // Leaving Pinpoint (or unmount): drop any lingering outline so a stale block isn't left lit.
      clearHoverOutline();
      return;
    }

    const setOutline = (block: HTMLElement | null) => {
      if (outlinedRef.current === block) return;
      if (outlinedRef.current) outlinedRef.current.classList.remove(BLOCK_HOVER_CLASS);
      outlinedRef.current = block;
      if (block) block.classList.add(BLOCK_HOVER_CLASS);
    };

    const onOver = (e: Event) => {
      const pickable = resolvePickableBlock((e as MouseEvent).target);
      // AS-003 / AS-006b: only a non-empty block outlines; an empty one resolves to null → clear.
      setOutline(pickable?.element ?? null);
    };
    const onOut = (e: Event) => {
      const ev = e as MouseEvent;
      const from = resolvePickableBlock(ev.target)?.element ?? null;
      const to = resolvePickableBlock(ev.relatedTarget)?.element ?? null;
      // Moving WITHIN the same block (between its inline children) is not a leave.
      if (from && to && from === to) return;
      if (!to) setOutline(null);
    };
    const onClick = (e: Event) => {
      const pickable = resolvePickableBlock((e as MouseEvent).target);
      if (!pickable) return; // AS-006b: a click on an empty block (or non-block area) is a no-op.
      setOutline(pickable.element); // keep the picked block outlined while the popover is open.
      onPickRef.current({
        blockId: pickable.blockId,
        element: pickable.element,
        rect: pickable.element.getBoundingClientRect(),
      });
    };

    contentEl.addEventListener("mouseover", onOver);
    contentEl.addEventListener("mouseout", onOut);
    contentEl.addEventListener("click", onClick);
    return () => {
      contentEl.removeEventListener("mouseover", onOver);
      contentEl.removeEventListener("mouseout", onOut);
      contentEl.removeEventListener("click", onClick);
      clearHoverOutline();
    };
  }, [contentEl, enabled, clearHoverOutline]);

  return { clearHoverOutline };
}
