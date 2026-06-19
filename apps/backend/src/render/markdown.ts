import MarkdownIt from "markdown-it";
import DOMPurify from "isomorphic-dompurify";

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
