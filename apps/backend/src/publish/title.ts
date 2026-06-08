// Title auto-derivation for the publish flow (story S-001, AS-003).
// HTML → <title>, falling back to the first <h1>.
// Markdown → the first ATX/setext H1.
// Image → the file name (without extension).
// The derived title is only a SUGGESTION; the author always edits it before publish
// (the service accepts an explicit editedTitle that overrides this).

import type { DocKind } from "./sniff";

function decode(content: string | Uint8Array): string {
  return typeof content === "string"
    ? content
    : new TextDecoder("utf-8").decode(content);
}

function firstHtmlTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? m[1] : undefined;
}

function firstHtmlH1(html: string): string | undefined {
  const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  // Strip any nested tags inside the h1.
  return m ? m[1].replace(/<[^>]+>/g, "") : undefined;
}

function firstMarkdownH1(md: string): string | undefined {
  const lines = md.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const atx = /^\s*#\s+(.+?)\s*#*\s*$/.exec(line);
    if (atx) return atx[1];
    // setext: a line of text underlined by ===.
    const next = lines[i + 1];
    if (line.trim() && next && /^\s*=+\s*$/.test(next)) return line.trim();
  }
  return undefined;
}

function baseName(filename: string | undefined): string | undefined {
  if (!filename) return undefined;
  const slash = Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\"));
  const base = slash === -1 ? filename : filename.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  const stem = dot <= 0 ? base : base.slice(0, dot);
  return stem || undefined;
}

const FALLBACK = "Untitled";

/**
 * Derive a suggested title from the artifact. Always returns a trimmed, non-empty
 * string (falls back to "Untitled"). This is a suggestion the author edits before
 * publishing — never the final word (AS-003).
 */
export function deriveTitle(
  kind: DocKind,
  content: string | Uint8Array,
  filename?: string,
): string {
  let candidate: string | undefined;

  if (kind === "html") {
    const text = decode(content);
    candidate = firstHtmlTitle(text) ?? firstHtmlH1(text);
  } else if (kind === "markdown") {
    candidate = firstMarkdownH1(decode(content));
  } else {
    candidate = baseName(filename);
  }

  const trimmed = candidate?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : FALLBACK;
}
