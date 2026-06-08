// S-003 shared primitive: a small labelled badge for a doc's kind (HTML / Markdown / image).
// web-core owns it so every feature screen (ProjectBrowser, viewer) renders the same badge.
// Dark-operator tokens, muted text, teal-on-soft accent — no raw hex (C-003).
export type DocFormat = "html" | "markdown" | "image";

const LABELS: Record<DocFormat, string> = {
  html: "HTML",
  markdown: "Markdown",
  image: "Image",
};

export function FormatBadge({ format }: { format?: string | null }) {
  // Unknown / empty kind → a safe fallback label, never a crash or blank (edge case).
  const known = format && format in LABELS ? (format as DocFormat) : null;
  const label = known ? LABELS[known] : "Doc";

  return (
    <span
      data-format={known ?? "unknown"}
      className="inline-flex items-center rounded-sm bg-accent-soft px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wide text-accent-ink"
    >
      {label}
    </span>
  );
}
