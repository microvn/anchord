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
