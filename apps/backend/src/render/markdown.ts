import MarkdownIt from "markdown-it";
import DOMPurify from "isomorphic-dompurify";
import { Window } from "happy-dom";
import { injectBlockIds, BLOCK_TAGS } from "../annotation/block-id";

// Markdown render path (story S-003). MD is rendered in the APP origin (not the
// sandbox iframe), so it MUST be sanitized (C-002): markdown-it → DOMPurify strips
// scripts, event handlers, and javascript: URLs. HTML docs go the sandbox route
// instead and are NOT sanitized (their JS is meant to run, isolated by origin).

const md = new MarkdownIt({
  html: true, // allow raw HTML in MD, but DOMPurify sanitizes it afterwards
  linkify: true,
  breaks: false,
});

/** Render Markdown to sanitized HTML safe to embed in the trusted app origin. */
export function renderMarkdown(source: string): string {
  if (!source || source.trim().length === 0) return "";
  const rendered = md.render(source);
  return DOMPurify.sanitize(rendered, { USE_PROFILES: { html: true } }).trim();
}

/**
 * Normalize a doc's stored content to the HTML the re-anchor matcher needs.
 *
 * The matcher (reanchor.ts) is HTML-only: it injects block-ids and extracts blocks, and
 * block-ids (`block-h1-1`, `block-td-7`, …) only exist AFTER markdown→HTML render. A markdown
 * doc's stored content is markdown SOURCE, so feeding it raw to the matcher yields zero blocks
 * and orphans every annotation. This is the ONE place that decides whether content needs
 * rendering before anchoring: markdown is rendered, html/image pass through unchanged.
 */
export function renderForAnchoring(content: string, kind: "html" | "markdown" | "image"): string {
  return kind === "markdown" ? renderMarkdown(content) : content;
}

// ── Addressable blocks for the MCP read tool (mcp-patch-document S-001) ───────
//
// `read_document` returns each addressable block as `{ blockId, sourceText? }`. The blockId set
// is the AUTHORITATIVE rendered-HTML set (the same `injectBlockIds` ids the patch/structural guard
// and the annotation anchors use). `sourceText` is the SOURCE-LEVEL string of that block — and is
// OMITTED (the non-patchable signal, AS-023/GAP-005) for any block we cannot map back to a
// resolvable source range. The two kinds differ ONLY in what "source string" means:
//   • markdown → the block's markdown source, sliced from markdown-it `token.map` line ranges.
//   • html     → the block element's `innerHTML` (NOT its textContent — inline markup is preserved).

const BLOCK_TAG_SET = new Set<string>(BLOCK_TAGS);

/** One addressable block as the read tool returns it. `sourceText` absent ⇒ non-patchable. */
export interface AddressableBlock {
  blockId: string;
  /** The block's source-level string. OMITTED when the block has no resolvable source range. */
  sourceText?: string;
}

/**
 * The addressable blocks of a doc, in document order, for `anchord_read_document` (S-001).
 * Markdown is rendered then mapped to source via `token.map`; html maps each block to its
 * `innerHTML`. A block with no resolvable source range omits `sourceText` (AS-023).
 */
export function addressableBlocks(content: string, kind: "html" | "markdown" | "image"): AddressableBlock[] {
  if (kind === "markdown") return markdownAddressableBlocks(content);
  if (kind === "html") return htmlAddressableBlocks(content);
  return []; // image: no model-generated body text → no addressable blocks.
}

/**
 * Build `blockId → markdown sourceText` for every block whose markdown-it `token.map` is resolvable,
 * numbering ids with the SAME per-tag counter `injectBlockIds` uses (document order) so the
 * token-walk id lines up EXACTLY with the rendered-HTML id (the GAP-005 alignment requirement).
 *
 * A block token whose `.map` is absent (table cells `td`/`th` carry `map=null`) is skipped → its
 * rendered-HTML block gets NO sourceText (non-patchable). A `html_block` token has no block tag
 * (`token.tag === ""`) so it never produces a `block-*` id here, while it DOES render to a real
 * element (e.g. `<div>`) in the HTML — that divergence leaves the rendered block unmapped, which is
 * exactly the fail-closed signal for a raw-html block (AS-023). Two identical source blocks (two
 * `## Overview`) disambiguate by their distinct `token.map` ranges.
 */
function markdownSourceById(markdownSource: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!markdownSource || markdownSource.trim().length === 0) return out;

  const lines = markdownSource.split("\n");
  const tokens = md.parse(markdownSource, {});
  const counters = new Map<string, number>();

  for (const t of tokens) {
    // Opening tokens of block-level tags get a positional id (mirrors injectBlockIds' per-tag walk).
    if (t.nesting !== 1) continue;
    const tag = (t.tag || "").toLowerCase();
    if (!BLOCK_TAG_SET.has(tag)) continue;

    const n = (counters.get(tag) ?? 0) + 1;
    counters.set(tag, n);
    const blockId = `block-${tag}-${n}`;

    // Fail-closed: no source-line range (e.g. td/th carry map=null) ⇒ non-patchable, no sourceText.
    if (!t.map) continue;
    const [start, end] = t.map; // [startLine, endLine) — half-open line range.
    if (start == null || end == null || end <= start) continue;
    out.set(blockId, lines.slice(start, end).join("\n"));
  }
  return out;
}

function markdownAddressableBlocks(markdownSource: string): AddressableBlock[] {
  const html = renderMarkdown(markdownSource);
  const rendered = enumerateRenderedBlocks(html); // authoritative blockId set + ordering.
  const sourceById = markdownSourceById(markdownSource);
  return rendered.map(({ blockId }) => {
    const sourceText = sourceById.get(blockId);
    // OMIT sourceText when the token walk produced no resolvable source for this rendered block
    // (cell/raw-html/token-walk↔rendered-HTML mismatch — GAP-005 fail-closed, AS-023).
    return sourceText === undefined ? { blockId } : { blockId, sourceText };
  });
}

/**
 * Enumerate EVERY addressable block in `html` as `{ blockId, innerHTML }`, in document order,
 * over the block-id-injected HTML — the SAME id set the annotation anchors / structural guard use
 * (`injectBlockIds` + the `extractAllBlocks` selector). This is the authoritative block ordering
 * for the read result. Never throws — a parse failure degrades to `[]`.
 */
function enumerateRenderedBlocks(html: string): { blockId: string; innerHTML: string }[] {
  const injected = injectBlockIds(html);
  let win: Window | null = null;
  try {
    win = new Window();
    win.document.body.innerHTML = injected;
    const out: { blockId: string; innerHTML: string }[] = [];
    const els = win.document.querySelectorAll("[data-block-id], [id^='block-']");
    for (let i = 0; i < els.length; i++) {
      const el = els[i] as unknown as Element;
      const blockId = el.getAttribute("data-block-id") ?? el.getAttribute("id");
      if (!blockId) continue;
      out.push({ blockId, innerHTML: el.innerHTML });
    }
    return out;
  } catch {
    return [];
  } finally {
    try {
      win?.happyDOM?.close?.();
    } catch {
      /* best-effort teardown */
    }
  }
}

/** Each html block's source string = its `innerHTML` (inline markup preserved, AS-002). */
function htmlAddressableBlocks(html: string): AddressableBlock[] {
  return enumerateRenderedBlocks(html).map(({ blockId, innerHTML }) => ({
    blockId,
    sourceText: innerHTML,
  }));
}

// ── Block-addressed markdown patch (mcp-patch-document S-002) ─────────────────
//
// A patch is a set of `{ blockId, find, replace }` edits. The server locates each
// addressed block's MARKDOWN SOURCE range (the same `token.map` line-range mapping the
// read tool uses for `sourceText`), finds `find` LITERALLY (never regex, C-001) WITHIN
// that source slice only, splices `find`→`replace`, reassembles the full source, and
// re-renders. The whole patch is ATOMIC (C-002): every edit must validate (block patchable,
// find present + unique) before ANY splice lands. After splicing, a STRUCTURAL guard (C-008)
// recomputes the ordered block-id list on the NEW source and refuses if it differs from the
// old — a text edit may not add/remove/reorder blocks.

/** One literal find→replace edit addressed to a block (C-001). `replace` may be empty (deletion). */
export interface BlockEdit {
  blockId: string;
  find: string;
  replace: string;
}

/** Thrown by `patchMarkdownSource` when the patch is refused; the message surfaces to the agent. */
export class MarkdownPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkdownPatchError";
  }
}

/**
 * Build `blockId → [startLine, endLine)` for every PATCHABLE markdown block (the same
 * per-tag counter + `token.map` resolution `markdownSourceById` uses). A block with no
 * resolvable source range (table cells carry `map=null`; a raw `html_block` produces no
 * `block-*` id here yet renders a real element) is absent from the map → non-patchable
 * (AS-024). Two identical source blocks disambiguate by their distinct line ranges.
 */
function markdownBlockRanges(markdownSource: string): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  if (!markdownSource || markdownSource.trim().length === 0) return out;

  const tokens = md.parse(markdownSource, {});
  const counters = new Map<string, number>();

  for (const t of tokens) {
    if (t.nesting !== 1) continue;
    const tag = (t.tag || "").toLowerCase();
    if (!BLOCK_TAG_SET.has(tag)) continue;

    const n = (counters.get(tag) ?? 0) + 1;
    counters.set(tag, n);
    const blockId = `block-${tag}-${n}`;

    // Fail-closed: no source-line range (td/th carry map=null) ⇒ non-patchable.
    if (!t.map) continue;
    const [start, end] = t.map;
    if (start == null || end == null || end <= start) continue;
    out.set(blockId, [start, end]);
  }
  return out;
}

/** The ordered block-id list of rendered markdown — the structural-guard fingerprint (C-008). */
function orderedMarkdownBlockIds(markdownSource: string): string[] {
  return addressableBlocks(markdownSource, "markdown").map((b) => b.blockId);
}

/** Count non-overlapping LITERAL occurrences of `needle` in `haystack` (never regex — C-001). */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) break;
    count += 1;
    from = i + needle.length;
  }
  return count;
}

/**
 * Apply a set of block-addressed edits to a markdown document's SOURCE, returning the new
 * source. ATOMIC (C-002): every edit is validated up front and the splice is computed on a
 * copy; if ANY edit fails (non-patchable block / find absent / find ambiguous) the whole
 * patch throws and the original source is untouched. After splicing, the STRUCTURAL guard
 * (C-008) refuses any patch whose ordered block-id sequence changed.
 *
 * Edits are LITERAL find/replace within ONE block's source slice (never regex, C-001). Two
 * edits addressing the same block are applied to that block's slice in order; an edit whose
 * `find` becomes ambiguous/absent within its (possibly already-edited) slice is refused.
 */
export function patchMarkdownSource(markdownSource: string, edits: BlockEdit[]): string {
  if (edits.length === 0) {
    throw new MarkdownPatchError("a patch requires a non-empty edits array (at least one edit)");
  }

  const lines = markdownSource.split("\n");
  const ranges = markdownBlockRanges(markdownSource);

  // Work on a per-block slice string keyed by blockId, so multiple edits on one block compose.
  const sliceById = new Map<string, string>();
  const sliceText = (blockId: string): string => {
    if (sliceById.has(blockId)) return sliceById.get(blockId)!;
    const range = ranges.get(blockId)!;
    const text = lines.slice(range[0], range[1]).join("\n");
    sliceById.set(blockId, text);
    return text;
  };

  for (const edit of edits) {
    const range = ranges.get(edit.blockId);
    if (!range) {
      // AS-024 / AS-006: the block is non-patchable (no resolvable source) or not in the doc.
      throw new MarkdownPatchError(
        `block '${edit.blockId}' is not patchable (no editable source range) — ` +
          `use anchord_update_document to replace the whole document instead`,
      );
    }
    const current = sliceText(edit.blockId);
    const occurrences = countOccurrences(current, edit.find);
    if (occurrences === 0) {
      // AS-006: find absent in the addressed block.
      throw new MarkdownPatchError(
        `find text was not found in block '${edit.blockId}'`,
      );
    }
    if (occurrences > 1) {
      // AS-007: find ambiguous — occurs more than once in the block.
      throw new MarkdownPatchError(
        `find text is ambiguous in block '${edit.blockId}' (occurs ${occurrences} times) — make it unique`,
      );
    }
    // Splice the single occurrence (literal — split/join avoids regex special chars, C-001).
    const idx = current.indexOf(edit.find);
    sliceById.set(
      edit.blockId,
      current.slice(0, idx) + edit.replace + current.slice(idx + edit.find.length),
    );
  }

  // Reassemble: replace each edited block's line range with its spliced slice (descending
  // by start line so earlier splices don't shift later ranges).
  const edited = [...sliceById.entries()]
    .map(([blockId, text]) => ({ range: ranges.get(blockId)!, text }))
    .sort((a, b) => b.range[0] - a.range[0]);
  const outLines = [...lines];
  for (const { range, text } of edited) {
    outLines.splice(range[0], range[1] - range[0], ...text.split("\n"));
  }
  const newSource = outLines.join("\n");

  // C-008 structural guard: the ordered block-id sequence must be identical before/after.
  const before = orderedMarkdownBlockIds(markdownSource);
  const after = orderedMarkdownBlockIds(newSource);
  if (before.length !== after.length || before.some((id, i) => id !== after[i])) {
    throw new MarkdownPatchError(
      "patch changes the block structure (the ordered block-id sequence differs) — " +
        "a text edit may not add, remove, or reorder blocks",
    );
  }

  return newSource;
}
