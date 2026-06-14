import type { DiffLine } from "@/features/versioning/services/client";

// SourceLineDiff (S-003 / AS-007 / C-004) — the Source tab body: a monospace line-diff (prototype
// `.line-diff`/`.dline`, styled viewer-dialogs.css). Added lines are highlighted teal, removed lines
// red + struck through, context lines plain; a `+`/`−` gutter marks each changed line. Pure
// presentation off the `lines[]` the diff read returns — no fetching here.
export function SourceLineDiff({
  lines,
  fromLabel,
  toLabel,
}: {
  lines: DiffLine[];
  fromLabel: string;
  toLabel: string;
}) {
  return (
    <div data-testid="source-line-diff" className="flex min-h-0 flex-col">
      <div className="flex-none border-b border-line px-3 py-1.5 font-mono text-[11px] text-subtle">
        Source · {fromLabel} → {toLabel}
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1 font-mono text-[12px] leading-[1.55]">
        {lines.map((line, i) => {
          const added = line.type === "added";
          const removed = line.type === "removed";
          return (
            <div
              key={i}
              data-testid={`dline-${i}`}
              data-line-type={line.type}
              className={`flex gap-2 px-3 ${
                added
                  ? "bg-accent-soft text-accent-ink"
                  : removed
                    ? "bg-error/10 text-error line-through"
                    : "text-ink"
              }`}
            >
              <span
                aria-hidden="true"
                className="w-3 flex-none select-none text-right text-subtle"
              >
                {added ? "+" : removed ? "−" : ""}
              </span>
              <span className="whitespace-pre-wrap break-words">{line.text || " "}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
