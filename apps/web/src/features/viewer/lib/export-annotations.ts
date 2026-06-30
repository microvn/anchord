import { format, parseISO } from "date-fns";
import type { ViewerAnnotation, AnnotationComment } from "@/features/viewer/services/client";

// Client-side "Download annotations" serializer (viewer-overflow-menu S-004) — own-your-data: the
// rail's annotation threads, exactly as the viewer already holds them (no extra fetch, no backend
// export endpoint), rendered to a portable Markdown document. Pure + DOM-free so it is unit-testable;
// the component turns the returned string into a Blob download.
//
// One thread per annotation: a heading carries its type + status + the anchored quote, then the
// comment thread in order (root first, replies indented). A redline/suggestion shows its from→to.

export interface ExportDocMeta {
  title: string;
  version: number;
}

// An absolute timestamp (the export is an offline artifact, so it carries the real time, not the
// rail's relative "3h"), parsed with date-fns (never hand-rolled Date math). Unparseable → verbatim.
function stamp(value: string): string {
  try {
    const d = parseISO(value);
    if (Number.isNaN(d.getTime())) return value;
    return format(d, "yyyy-MM-dd HH:mm");
  } catch {
    return value;
  }
}

function authorOf(c: AnnotationComment): string {
  return c.authorName ?? c.guestName ?? "Unknown";
}

// The human label for an annotation's type/lifecycle, shown in its heading.
function typeLabel(a: ViewerAnnotation): string {
  if (a.suggestion) {
    const kind = a.suggestion.kind === "delete" ? "Redline" : "Suggestion";
    const status = a.suggestionStatus ? ` · ${a.suggestionStatus}` : "";
    return `${kind}${status}`;
  }
  if (a.label === "looks-good") return "Like";
  if (a.label) return `Label · ${a.label}`;
  return "Comment";
}

function annotationToMarkdown(a: ViewerAnnotation, index: number): string {
  const lines: string[] = [];
  const flags = [
    a.status === "resolved" ? "resolved" : null,
    a.isOrphaned ? "orphaned" : null,
  ].filter(Boolean);
  const flagStr = flags.length ? ` _(${flags.join(", ")})_` : "";
  lines.push(`### ${index}. ${typeLabel(a)}${flagStr}`);

  const quote = a.anchor?.textSnippet?.trim();
  if (quote) lines.push(`> ${quote.replace(/\n+/g, " ")}`);

  if (a.suggestion?.kind === "delete") {
    lines.push("", `- **Remove:** ${a.suggestion.from}`);
  } else if (a.suggestion?.kind === "replace") {
    lines.push("", `- **From:** ${a.suggestion.from}`, `- **To:** ${a.suggestion.to}`);
  }

  if (a.comments.length) {
    lines.push("");
    for (const c of a.comments) {
      const indent = c.parentId ? "  " : "";
      lines.push(`${indent}- **${authorOf(c)}** · ${stamp(c.createdAt)}`);
      // Keep multi-line bodies under the bullet, indented to align with the text (AS-014).
      for (const bodyLine of c.body.split("\n")) {
        lines.push(`${indent}  ${bodyLine}`);
      }
    }
  }
  return lines.join("\n");
}

// Render the full annotations export for a doc. `annotations` is the rail list (already ordered).
export function annotationsToMarkdown(doc: ExportDocMeta, annotations: ViewerAnnotation[]): string {
  const head = [
    `# Annotations — ${doc.title}`,
    "",
    `Document version: v${doc.version}`,
    `Exported: ${format(new Date(), "yyyy-MM-dd HH:mm")}`,
    `Total: ${annotations.length}`,
    "",
    "---",
    "",
  ];
  if (!annotations.length) {
    return [...head, "_No annotations yet._", ""].join("\n");
  }
  const body = annotations.map((a, i) => annotationToMarkdown(a, i + 1)).join("\n\n");
  return [...head, body, ""].join("\n");
}

// A filesystem-safe filename from the doc title (kept short, ascii-ish). Empty/symbol-only title →
// the bare "annotations.md" fallback.
export function exportFilename(title: string): string {
  const stem = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return stem ? `${stem}-annotations.md` : "annotations.md";
}
