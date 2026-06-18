import { Icon } from "@/components/icon";
import { FORMAT_META, ACCESS_META } from "@/features/docs/types";
import {
  STATUS_ORDER,
  FORMAT_ORDER,
  ACCESS_ORDER,
  UPDATED_ORDER,
  STATUS_LABEL,
  UPDATED_LABEL,
} from "@/features/docs/lib/doc-filter";
import type { DocFilterState } from "@/features/docs/hooks/use-doc-browse";

// DocFilterPopover (workspace-project-browse S-002): the faceted filter surface opened from the bar's
// Filter control. Four groups — Status / Format / Access (multi-select, icon + DYNAMIC count, C-004)
// and Updated (single-select recency radio). Toggling applies LIVE (no Apply button); Reset re-selects
// every facet + Updated=Any. Mirrors the annotation-rail FilterPopover. Bottom-sheet on mobile (C-006)
// is the responsive class below; pixel/responsive is [→MANUAL] + a Playwright check.

const STATUS_ICON: Record<string, string> = { live: "check", draft: "pencil" };

function FacetButton({
  testId,
  label,
  count,
  active,
  glyph,
  onToggle,
}: {
  testId: string;
  label: string;
  count: number;
  active: boolean;
  glyph: React.ReactNode;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-count={count}
      aria-pressed={active}
      aria-label={`${label} ${count}`}
      title={`${label} · ${count}`}
      onClick={onToggle}
      className={[
        "flex min-h-[34px] cursor-pointer items-center gap-2 rounded-[6px] border px-2 py-1.5 text-left text-[12.5px] font-medium transition-colors",
        active
          ? "border-accent/40 bg-accent-soft text-ink"
          : "border-line bg-transparent text-subtle hover:text-ink",
      ].join(" ")}
    >
      <span className="flex h-4 w-4 flex-none items-center justify-center" aria-hidden>
        {glyph}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span data-testid={`${testId}-count`} className="font-mono text-[11px] tabular-nums">
        {count}
      </span>
    </button>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.07em] text-subtle">
      {children}
    </div>
  );
}

export function DocFilterPopover({ filter }: { filter: DocFilterState }) {
  const { status, format, access, updated, counts } = filter;
  return (
    <div
      data-testid="doc-filter-popover"
      role="dialog"
      aria-label="Filter docs"
      className="absolute right-0 top-full z-40 mt-1 flex w-[248px] flex-col gap-3 rounded-md border border-line bg-elev p-3 shadow-lg max-sm:fixed max-sm:inset-x-2 max-sm:bottom-2 max-sm:top-auto max-sm:w-auto"
    >
      {/* Status */}
      <div className="flex flex-col gap-1.5" role="group" aria-label="Filter by status">
        <GroupLabel>Status</GroupLabel>
        {STATUS_ORDER.map((f) => (
          <FacetButton
            key={f}
            testId={`facet-status-${f}`}
            label={STATUS_LABEL[f]}
            count={counts.status[f]}
            active={status.has(f)}
            glyph={<Icon name={STATUS_ICON[f]} size={13} />}
            onToggle={() => filter.toggleStatus(f)}
          />
        ))}
      </div>

      {/* Format */}
      <div className="flex flex-col gap-1.5" role="group" aria-label="Filter by format">
        <GroupLabel>Format</GroupLabel>
        {FORMAT_ORDER.map((f) => (
          <FacetButton
            key={f}
            testId={`facet-format-${f}`}
            label={FORMAT_META[f].label}
            count={counts.format[f]}
            active={format.has(f)}
            glyph={<Icon name={FORMAT_META[f].icon} size={13} />}
            onToggle={() => filter.toggleFormat(f)}
          />
        ))}
      </div>

      {/* Access */}
      <div className="flex flex-col gap-1.5" role="group" aria-label="Filter by access">
        <GroupLabel>Access</GroupLabel>
        {ACCESS_ORDER.map((f) => (
          <FacetButton
            key={f}
            testId={`facet-access-${f}`}
            label={ACCESS_META[f].label}
            count={counts.access[f]}
            active={access.has(f)}
            glyph={<Icon name={ACCESS_META[f].icon} size={13} />}
            onToggle={() => filter.toggleAccess(f)}
          />
        ))}
      </div>

      {/* Updated — single-select recency window */}
      <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Filter by last updated">
        <GroupLabel>Updated</GroupLabel>
        {UPDATED_ORDER.map((w) => {
          const isActive = updated === w;
          return (
            <button
              key={w}
              type="button"
              role="radio"
              data-testid={`facet-updated-${w}`}
              data-count={counts.updated[w]}
              aria-checked={isActive}
              onClick={() => filter.setUpdated(w)}
              className={[
                "flex min-h-[34px] cursor-pointer items-center gap-2 rounded-[6px] border px-2 py-1.5 text-left text-[12.5px] font-medium transition-colors",
                isActive
                  ? "border-accent/40 bg-accent-soft text-ink"
                  : "border-line bg-transparent text-subtle hover:text-ink",
              ].join(" ")}
            >
              <span className="flex h-4 w-4 flex-none items-center justify-center" aria-hidden>
                <span
                  className={`size-2.5 rounded-full border ${isActive ? "border-accent bg-accent" : "border-subtle"}`}
                />
              </span>
              <span className="min-w-0 flex-1 truncate">{UPDATED_LABEL[w]}</span>
              <span data-testid={`facet-updated-${w}-count`} className="font-mono text-[11px] tabular-nums">
                {counts.updated[w]}
              </span>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        data-testid="doc-filter-reset"
        onClick={filter.reset}
        className="min-h-[34px] cursor-pointer rounded-[6px] border border-line px-2 py-1.5 text-[12px] font-medium text-subtle transition-colors hover:text-ink"
      >
        Reset
      </button>
    </div>
  );
}
