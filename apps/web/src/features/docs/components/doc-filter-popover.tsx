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
// Filter control. Matches the approved option-B mockup: a header (title + "Reset all"); Status /
// Format / Access groups (multi-select CHECKBOX rows, icon + DYNAMIC count, C-004, each group with an
// "All" shortcut); an Updated group (single-select radio); a "Has detached only" toggle that is
// GREYED/disabled until the backend serves a per-doc detached count (GAP-001); and a footer (Reset +
// Done). Toggling applies LIVE (no Apply). Mirrors the annotation-rail engine. Bottom-sheet on mobile
// (C-006); pixel/responsive is [→MANUAL] + a Playwright check.

const STATUS_DOT: Record<string, string> = { live: "var(--green)", draft: "var(--subtle)" };

function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={[
        "grid size-[15px] flex-none place-items-center rounded-[4px] border transition-colors",
        checked ? "border-accent bg-accent text-[var(--paper)]" : "border-subtle bg-transparent",
      ].join(" ")}
    >
      {checked && <Icon name="check" size={11} />}
    </span>
  );
}

function FacetRow({
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
      onClick={onToggle}
      className="flex min-h-[34px] w-full cursor-pointer items-center gap-2.5 rounded-[6px] px-2 py-1.5 text-left text-[13px] text-ink transition-colors hover:bg-elev"
    >
      <Checkbox checked={active} />
      <span className="flex h-4 w-4 flex-none items-center justify-center text-subtle" aria-hidden>
        {glyph}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span data-testid={`${testId}-count`} className="font-mono text-[11px] tabular-nums text-subtle">
        {count}
      </span>
    </button>
  );
}

function GroupHeader({ label, onAll }: { label: string; onAll?: () => void }) {
  return (
    <div className="mt-1 flex items-center justify-between px-2">
      <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.07em] text-subtle">
        {label}
      </span>
      {onAll && (
        <button
          type="button"
          data-testid={`facet-all-${label.toLowerCase()}`}
          onClick={onAll}
          className="cursor-pointer text-[11px] text-subtle transition-colors hover:text-accent-ink"
        >
          All
        </button>
      )}
    </div>
  );
}

export function DocFilterPopover({ filter, onClose }: { filter: DocFilterState; onClose: () => void }) {
  const { status, format, access, updated, counts } = filter;
  return (
    <div
      data-testid="doc-filter-popover"
      role="dialog"
      aria-label="Filter docs"
      className="absolute left-0 top-full z-40 mt-1 flex w-[264px] flex-col rounded-md border border-line bg-elev p-1.5 shadow-lg max-sm:fixed max-sm:inset-x-2 max-sm:bottom-2 max-sm:top-auto max-sm:w-auto"
    >
      {/* Header — title + Reset all */}
      <div className="flex items-center justify-between px-2 pb-1.5 pt-1">
        <span className="text-[13px] font-semibold text-ink">Filter</span>
        <button
          type="button"
          data-testid="doc-filter-reset-all"
          onClick={filter.reset}
          className="cursor-pointer text-[12px] text-accent-ink transition-colors hover:underline"
        >
          Reset all
        </button>
      </div>

      {/* Status */}
      <div role="group" aria-label="Filter by status">
        <GroupHeader label="Status" onAll={filter.allStatus} />
        {STATUS_ORDER.map((f) => (
          <FacetRow
            key={f}
            testId={`facet-status-${f}`}
            label={STATUS_LABEL[f]}
            count={counts.status[f]}
            active={status.has(f)}
            glyph={<span className="size-2 rounded-full" style={{ background: STATUS_DOT[f] }} />}
            onToggle={() => filter.toggleStatus(f)}
          />
        ))}
      </div>

      {/* Format */}
      <div role="group" aria-label="Filter by format">
        <GroupHeader label="Format" onAll={filter.allFormat} />
        {FORMAT_ORDER.map((f) => (
          <FacetRow
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
      <div role="group" aria-label="Filter by access">
        <GroupHeader label="Access" onAll={filter.allAccess} />
        {ACCESS_ORDER.map((f) => (
          <FacetRow
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

      {/* Updated — single-select recency radio */}
      <div role="radiogroup" aria-label="Filter by last updated">
        <GroupHeader label="Updated" />
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
              className="flex min-h-[34px] w-full cursor-pointer items-center gap-2.5 rounded-[6px] px-2 py-1.5 text-left text-[13px] text-ink transition-colors hover:bg-elev"
            >
              <span
                aria-hidden
                className={`grid size-[15px] flex-none place-items-center rounded-full border ${isActive ? "border-accent" : "border-subtle"}`}
              >
                {isActive && <span className="size-2 rounded-full bg-accent" />}
              </span>
              <span className="min-w-0 flex-1 truncate">{UPDATED_LABEL[w]}</span>
              <span data-testid={`facet-updated-${w}-count`} className="font-mono text-[11px] tabular-nums text-subtle">
                {counts.updated[w]}
              </span>
            </button>
          );
        })}
      </div>

      {/* Has detached only — GAP-001: needs a per-doc detached count the browse row does not serve
          yet, so this is rendered DISABLED (greyed) until that backend producer ships. */}
      <div className="my-1 h-px bg-line" />
      <div
        data-testid="facet-detached"
        aria-disabled="true"
        title="Coming soon — needs a per-doc detached count from the backend"
        className="flex min-h-[34px] w-full cursor-not-allowed items-center gap-2.5 rounded-[6px] px-2 py-1.5 text-left text-[13px] text-subtle opacity-60"
      >
        <Icon name="alert" size={14} />
        <span className="min-w-0 flex-1 truncate">Has detached only</span>
        <span aria-hidden className="h-[16px] w-[28px] flex-none rounded-full border border-line bg-sunken" />
      </div>

      {/* Footer — Reset + Done */}
      <div className="mt-1 flex items-center justify-between border-t border-line px-2 pb-1 pt-2">
        <button
          type="button"
          data-testid="doc-filter-reset"
          onClick={filter.reset}
          className="cursor-pointer text-[12px] font-medium text-subtle transition-colors hover:text-ink"
        >
          Reset
        </button>
        <button
          type="button"
          data-testid="doc-filter-done"
          onClick={onClose}
          className="cursor-pointer rounded-md bg-accent px-3 py-1 text-[12px] font-semibold text-[var(--paper)] transition-colors hover:bg-accent/90"
        >
          Done
        </button>
      </div>
    </div>
  );
}
