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
