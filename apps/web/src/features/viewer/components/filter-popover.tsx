import { useRef } from "react";
import { Pencil, MessageSquareText, Strikethrough, Zap, type LucideIcon } from "lucide-react";
import { Icon } from "@/components/icon";
import { useDismissOnOutsideAndEscape } from "@/features/viewer/hooks/use-dismiss";
import {
  type StatusFacet,
  type TypeFacet,
  STATUS_ORDER,
  TYPE_ORDER,
} from "@/features/viewer/lib/annotation-filter";

// FilterPopover (S-007 — annotation-core-ui): the TWO-AXIS filter surface, opened from the rail's
// Filter control (C-011). It lists two facet groups — Status (Open · Resolved) and Type (Markup ·
// Comment · Redline · Label) — each facet an icon + its DYNAMIC count (C-010, computed by the parent
// against the OTHER axis). Toggling a facet applies LIVE (no Apply button); Reset re-selects all.
// Both axes default all-selected. (Bottom-sheet on mobile per C-005 is visual [→MANUAL].)
//
// AS-022 lists both axes + counts, all selected by default. AS-027 Reset clears the filter.

// Type-facet hue + icon — reused from doc-mode-toolbar's TOOL_META (DESIGN.md type/tool palette:
// markup #37b3bd Pencil · comment #d68a3e MessageSquareText · redline #f1655d Strikethrough · label
// #cbb24a Zap). Kept inline (a value table, not a type import) so this stays a leaf component.
const TYPE_META: Record<TypeFacet, { label: string; icon: LucideIcon; hue: string }> = {
  markup: { label: "Markup", icon: Pencil, hue: "#37b3bd" },
  comment: { label: "Comment", icon: MessageSquareText, hue: "#d68a3e" },
  redline: { label: "Redline", icon: Strikethrough, hue: "#f1655d" },
  label: { label: "Label", icon: Zap, hue: "#cbb24a" },
};

// Status facets reuse the existing icon set: Open → an unresolved/pending dot (`clock`), Resolved →
// `check` (closed). No new SVG (DESIGN.md: existing glyphs).
const STATUS_META: Record<StatusFacet, { label: string; icon: string }> = {
  open: { label: "Open", icon: "clock" },
  resolved: { label: "Resolved", icon: "check" },
};

function FacetButton({
  testId,
  label,
  count,
  active,
  hue,
  glyph,
  onToggle,
}: {
  testId: string;
  label: string;
  count: number;
  active: boolean;
  /** type facets carry their per-type hue; status facets pass undefined (neutral accent). */
  hue?: string;
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
        "flex items-center gap-2 rounded-[6px] border px-2 py-1.5 text-left text-[12.5px] font-medium transition-colors",
        active ? "border-accent/40 bg-accent-soft text-ink" : "border-line bg-transparent text-subtle hover:text-ink",
      ].join(" ")}
      style={active && hue ? { color: hue, borderColor: `${hue}66`, background: `${hue}1f` } : undefined}
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

export function FilterPopover({
  activeStatus,
  activeType,
  statusCounts,
  typeCounts,
  onToggleStatus,
  onToggleType,
  onReset,
  onDismiss,
}: {
  activeStatus: ReadonlySet<StatusFacet>;
  activeType: ReadonlySet<TypeFacet>;
  /** DYNAMIC counts (C-010) — computed by the parent against the OTHER axis's selection. */
  statusCounts: Record<StatusFacet, number>;
  typeCounts: Record<TypeFacet, number>;
  onToggleStatus: (f: StatusFacet) => void;
  onToggleType: (f: TypeFacet) => void;
  onReset: () => void;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismissOnOutsideAndEscape(ref, onDismiss);

  return (
    <div
      ref={ref}
      data-testid="filter-popover"
      role="dialog"
      aria-label="Filter annotations"
      className="absolute right-0 top-full z-40 mt-1 flex w-[224px] flex-col gap-3 rounded-md border border-line bg-elev p-3 shadow-lg"
    >
      {/* Status axis */}
      <div className="flex flex-col gap-1.5" role="group" aria-label="Filter by status">
        <div className="px-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.07em] text-subtle">
          Status
        </div>
        {STATUS_ORDER.map((f) => (
          <FacetButton
            key={f}
            testId={`facet-status-${f}`}
            label={STATUS_META[f].label}
            count={statusCounts[f]}
            active={activeStatus.has(f)}
            glyph={<Icon name={STATUS_META[f].icon} size={13} />}
            onToggle={() => onToggleStatus(f)}
          />
        ))}
      </div>

      {/* Type axis */}
      <div className="flex flex-col gap-1.5" role="group" aria-label="Filter by type">
        <div className="px-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.07em] text-subtle">
          Type
        </div>
        {TYPE_ORDER.map((f) => {
          const meta = TYPE_META[f];
          const TypeIcon = meta.icon;
          return (
            <FacetButton
              key={f}
              testId={`facet-type-${f}`}
              label={meta.label}
              count={typeCounts[f]}
              active={activeType.has(f)}
              hue={meta.hue}
              glyph={<TypeIcon size={13} strokeWidth={2} />}
              onToggle={() => onToggleType(f)}
            />
          );
        })}
      </div>

      <button
        type="button"
        data-testid="filter-reset"
        onClick={onReset}
        className="rounded-[6px] border border-line px-2 py-1.5 text-[12px] font-medium text-subtle transition-colors hover:text-ink"
      >
        Reset
      </button>
    </div>
  );
}
