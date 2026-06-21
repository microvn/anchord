import { useRef } from "react";
import { Highlighter, MessageSquareText, Eraser, Zap, type LucideIcon } from "lucide-react";
import { Icon } from "@/components/icon";
import { useDismissOnOutsideAndEscape } from "@/features/viewer/hooks/use-dismiss";
import {
  type StatusFacet,
  type TypeFacet,
  type DecisionFacet,
  STATUS_ORDER,
  TYPE_ORDER,
  DECISION_ORDER,
} from "@/features/viewer/lib/annotation-filter";

// FilterPopover (S-007 — annotation-core-ui): the TWO-AXIS filter surface, opened from the rail's
// Filter control (C-011). It lists two facet groups — Status (Open · Resolved) and Type (Markup ·
// Comment · Redline · Label) — each facet an icon + its DYNAMIC count (C-010, computed by the parent
// against the OTHER axis). Toggling a facet applies LIVE (no Apply button); Reset re-selects all.
// Both axes default all-selected. (Bottom-sheet on mobile per C-005 is visual [→MANUAL].)
//
// STYLE: mirrors the project-detail browse filter (docs/doc-filter-popover.tsx) — checkbox ROWS
// (accent checkbox + glyph + label + dynamic count, hover bg-elev, no per-row border), a per-group
// "All" shortcut, and a Reset/Done footer — so the two filter surfaces read identically. The only
// rail-specific keep is the per-TYPE hue on the type glyph (DESIGN.md type/tool palette), which is a
// meaningful colour signal the project's status/format/access facets don't have.
//
// AS-022 lists both axes + counts, all selected by default. AS-027 Reset clears the filter.

// Type-facet hue + icon — reused from doc-mode-toolbar's TOOL_META (DESIGN.md type/tool palette:
// markup #37b3bd Highlighter · comment #d68a3e MessageSquareText · redline #f1655d Eraser · label
// #cbb24a Zap). Kept inline (a value table, not a type import) so this stays a leaf component.
const TYPE_META: Record<TypeFacet, { label: string; icon: LucideIcon; hue: string }> = {
  markup: { label: "Markup", icon: Highlighter, hue: "#37b3bd" },
  comment: { label: "Comment", icon: MessageSquareText, hue: "#d68a3e" },
  redline: { label: "Redline", icon: Eraser, hue: "#f1655d" },
  label: { label: "Label", icon: Zap, hue: "#cbb24a" },
};

// Status facets reuse the existing icon set: Open → an unresolved/pending dot (`clock`), Resolved →
// `check` (closed). No new SVG (DESIGN.md: existing glyphs).
const STATUS_META: Record<StatusFacet, { label: string; icon: string }> = {
  open: { label: "Open", icon: "clock" },
  resolved: { label: "Resolved", icon: "check" },
};

// Decision facets (S-007 third axis) — a filled tone-dot mirroring the ThreadCard lifecycle pill
// (thread-card.tsx StatusDot): Pending neutral · Accepted success · Rejected error · Stale muted. The
// dot color rides a Tailwind text-* class (not an inline hue) so it tracks the theme's success/error
// tokens, same as the pill. Decision is a SUGGESTIONS-only axis (comments/labels have no decision).
const DECISION_META: Record<DecisionFacet, { label: string; toneClass: string }> = {
  pending: { label: "Pending", toneClass: "text-subtle" },
  accepted: { label: "Accepted", toneClass: "text-success" },
  rejected: { label: "Rejected", toneClass: "text-error" },
  stale: { label: "Stale", toneClass: "text-muted" },
};

// The accent checkbox — identical to the project filter's (doc-filter-popover.tsx Checkbox).
function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={[
        "grid size-4 flex-none place-items-center rounded-[4px] border transition-colors",
        checked ? "border-accent bg-accent text-[var(--paper)]" : "border-subtle bg-transparent",
      ].join(" ")}
    >
      {checked && <Icon name="check" size={11} />}
    </span>
  );
}

// A checkbox facet row — same shape as the project filter's FacetRow. The glyph carries the type hue
// when given (type facets); status facets pass none → neutral subtle.
function FacetRow({
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
      onClick={onToggle}
      className="flex min-h-[34px] w-full cursor-pointer items-center gap-2.5 rounded-[6px] px-2 py-1.5 text-left text-[13px] text-ink transition-colors hover:bg-elev"
    >
      <Checkbox checked={active} />
      <span
        className="flex h-4 w-4 flex-none items-center justify-center text-subtle"
        style={hue ? { color: hue } : undefined}
        aria-hidden
      >
        {glyph}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span data-testid={`${testId}-count`} className="font-mono text-[11px] tabular-nums text-subtle">
        {count}
      </span>
    </button>
  );
}

// Group header — label + an "All" shortcut that TOGGLES the whole axis: if every facet is already
// selected it deselects them all, otherwise it selects them all. `allOn` drives the label/intent.
function GroupHeader({ label, allOn, onAll }: { label: string; allOn: boolean; onAll: () => void }) {
  return (
    <div className="mt-1 flex items-center justify-between px-2">
      <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.07em] text-subtle">
        {label}
      </span>
      <button
        type="button"
        data-testid={`facet-all-${label.toLowerCase()}`}
        aria-pressed={allOn}
        onClick={onAll}
        className="cursor-pointer text-[11px] text-subtle transition-colors hover:text-accent-ink"
      >
        {allOn ? "None" : "All"}
      </button>
    </div>
  );
}

export function FilterPopover({
  activeStatus,
  activeType,
  activeDecision,
  statusCounts,
  typeCounts,
  decisionCounts,
  onToggleStatus,
  onToggleType,
  onToggleDecision,
  onReset,
  onDismiss,
}: {
  activeStatus: ReadonlySet<StatusFacet>;
  activeType: ReadonlySet<TypeFacet>;
  activeDecision: ReadonlySet<DecisionFacet>;
  /** DYNAMIC counts (C-010) — computed by the parent against the OTHER axes' selection. */
  statusCounts: Record<StatusFacet, number>;
  typeCounts: Record<TypeFacet, number>;
  decisionCounts: Record<DecisionFacet, number>;
  onToggleStatus: (f: StatusFacet) => void;
  onToggleType: (f: TypeFacet) => void;
  onToggleDecision: (f: DecisionFacet) => void;
  onReset: () => void;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismissOnOutsideAndEscape(ref, onDismiss);

  // Per-axis "All" shortcut TOGGLES the whole axis (live): fully selected → deselect every facet;
  // otherwise → select every facet. So one control covers both "select all" and "clear all".
  const statusAllOn = STATUS_ORDER.every((f) => activeStatus.has(f));
  const typeAllOn = TYPE_ORDER.every((f) => activeType.has(f));
  const decisionAllOn = DECISION_ORDER.every((f) => activeDecision.has(f));
  const allStatus = () => STATUS_ORDER.forEach((f) => (statusAllOn ? activeStatus.has(f) && onToggleStatus(f) : !activeStatus.has(f) && onToggleStatus(f)));
  const allType = () => TYPE_ORDER.forEach((f) => (typeAllOn ? activeType.has(f) && onToggleType(f) : !activeType.has(f) && onToggleType(f)));
  const allDecision = () => DECISION_ORDER.forEach((f) => (decisionAllOn ? activeDecision.has(f) && onToggleDecision(f) : !activeDecision.has(f) && onToggleDecision(f)));

  return (
    <div
      ref={ref}
      data-testid="filter-popover"
      role="dialog"
      aria-label="Filter annotations"
      className="absolute right-0 top-full z-40 mt-1 flex w-[240px] flex-col rounded-md border border-line bg-elev p-1.5 shadow-lg"
    >
      {/* Header — title only. Reset lives in the footer (the header "Reset all" was a duplicate). */}
      <div className="flex items-center px-2 pb-1.5 pt-1">
        <span className="text-[13px] font-semibold text-ink">Filter</span>
      </div>

      {/* Status axis */}
      <div role="group" aria-label="Filter by status">
        <GroupHeader label="Status" allOn={statusAllOn} onAll={allStatus} />
        {STATUS_ORDER.map((f) => (
          <FacetRow
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
      <div role="group" aria-label="Filter by type">
        <GroupHeader label="Type" allOn={typeAllOn} onAll={allType} />
        {TYPE_ORDER.map((f) => {
          const meta = TYPE_META[f];
          const TypeIcon = meta.icon;
          return (
            <FacetRow
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

      {/* Decision axis (S-007 third axis, C-009) — a SUGGESTIONS-only axis. Comments/labels carry no
          decision; they pass while the axis is un-narrowed and drop out once it is narrowed. Counts sum
          to the visible suggestions (C-010). The dot tone mirrors the ThreadCard lifecycle pill. */}
      <div role="group" aria-label="Filter by decision">
        <GroupHeader label="Decision" allOn={decisionAllOn} onAll={allDecision} />
        {DECISION_ORDER.map((f) => {
          const meta = DECISION_META[f];
          return (
            <FacetRow
              key={f}
              testId={`facet-decision-${f}`}
              label={meta.label}
              count={decisionCounts[f]}
              active={activeDecision.has(f)}
              glyph={<span className={`h-2 w-2 rounded-full bg-current ${meta.toneClass}`} />}
              onToggle={() => onToggleDecision(f)}
            />
          );
        })}
      </div>

      {/* Footer — Reset + Done (matches the project filter popover) */}
      <div className="mt-1 flex items-center justify-between border-t border-line px-2 pb-1 pt-2">
        <button
          type="button"
          data-testid="filter-reset"
          onClick={onReset}
          className="cursor-pointer text-[12px] font-medium text-subtle transition-colors hover:text-ink"
        >
          Reset
        </button>
        <button
          type="button"
          data-testid="filter-done"
          onClick={onDismiss}
          className="cursor-pointer rounded-md bg-accent px-3 py-1 text-[12px] font-semibold text-[var(--paper)] transition-colors hover:bg-accent/90"
        >
          Done
        </button>
      </div>
    </div>
  );
}
