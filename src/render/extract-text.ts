// Plain-text extraction for the search index (workspace-project S-005, GAP-003).
//
// GAP-003 is resolved to PUBLISH-TIME extraction: when a version is published we
// strip its rendered content down to plain text and store it on
// doc_versions.extracted_text (a portable `text` column). The search index (C-006)
// is built over that stored text + the doc title + comment bodies — the query never
// re-renders content.
//
// Extraction reuses the SAME render/sanitize path as the viewer so what gets indexed
// matches what a reader sees:
//   - markdown → markdown-it render → DOMPurify (renderMarkdown) → strip tags.
//   - html     → DOMPurify sanitize (drop scripts/handlers) → strip tags. We index
//                the VISIBLE text only; an AI-HTML doc's <script> body is never
//                indexed (it is removed by sanitize before stripping), which is the
//                right call — search matches what a human reads, not script source.
//   - image    → there is no body text; index the alt/caption text the caller has
//                (we receive it as `content` for images — the filename/alt), so an
//                image doc is still findable by its title-adjacent text.

import DOMPurify from "isomorphic-dompurify";
import { renderMarkdown } from "./markdown";

export type ExtractKind = "html" | "markdown" | "image";

/** Collapse runs of whitespace (incl. the newlines tag-stripping leaves) to single spaces. */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Strip a sanitized HTML fragment down to its visible text.
 *
 * DOMPurify sanitizes first (so any script/style/event-handler is gone), then we
 * remove the remaining tags. Block-level tags are turned into spaces so adjacent
 * words don't fuse ("<p>a</p><p>b</p>" → "a b", not "ab"). HTML entities that
 * DOMPurify emits (&amp; etc.) are decoded back to their characters so a search for
 * "a&b" can match. This is best-effort plain text, not a perfect renderer — good
 * enough for an FTS index.
 */
function htmlToText(html: string): string {
  // Sanitize: scripts, style bodies, and event handlers are removed before we read
  // the text, so script/style source never lands in the index.
  const clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    // Drop the CONTENT of style (and any leftover script) tags, not just the tags.
    FORBID_TAGS: ["style", "script"],
  });
  const spaced = clean
    // Turn tags into spaces so word boundaries survive stripping.
    .replace(/<[^>]*>/g, " ");
  const decoded = decodeEntities(spaced);
  return normalizeWhitespace(decoded);
}

/** Decode the handful of HTML entities DOMPurify emits, so indexed text reads naturally. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Extract searchable plain text from a published artifact's content.
 *
 * @param content raw stored content — HTML/MD source text, or (for an image) the
 *                filename/alt the publish path stored as the doc's content.
 * @param kind    the doc kind, deciding the render path.
 * @returns plain text suitable for an FTS index (whitespace-normalized; empty string
 *          for empty/whitespace-only input).
 */
export function extractText(content: string, kind: ExtractKind): string {
  if (!content || content.trim().length === 0) return "";
  switch (kind) {
    case "markdown":
      // Render MD (which sanitizes), then strip to text.
      return htmlToText(renderMarkdown(content));
    case "html":
      return htmlToText(content);
    case "image":
      // No body to render — the stored content is the alt/filename text already.
      return normalizeWhitespace(decodeEntities(content));
  }
}
