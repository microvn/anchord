import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DocFilterPopover } from "./doc-filter-popover";
import { SORT_ORDER, SORT_LABEL, type SortKey } from "@/features/docs/lib/doc-filter";
import type { DocBrowse } from "@/features/docs/hooks/use-doc-browse";

// DocFilterBar (workspace-project-browse S-002 + S-003): the shared browse bar mounted on BOTH the
// All-docs DocsScreen and the per-project ProjectDocsScreen (C-005). Left: the Filter control (opens
// the faceted popover; shows an active dot when narrowed) + "showing X of N". Right: the Sort control
// (Updated / Created / Title, C-007) + the grid/list view toggle. NO search box — global search is a
// separate surface (C-003). Replaces the dead 3-tab All/Shared/Has-detached strip.

export function DocFilterBar({ browse, showing }: { browse: DocBrowse; showing: number }) {
  const { filter, view, setView, sort, setSort, total } = browse;
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Click-outside / Escape closes the popover (mirrors the rail's dismiss behaviour).
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="mb-[18px] flex flex-wrap items-center gap-3" data-testid="doc-filter-bar">
      <div className="relative" ref={wrapRef}>
        <button
          type="button"
          data-testid="doc-filter-button"
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen((o) => !o)}
          className={[
            "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-[11px] text-[13px] font-medium transition-colors",
            filter.active
              ? "border-accent/40 bg-accent-soft text-ink"
              : "border-line bg-sunken text-muted hover:text-ink",
          ].join(" ")}
        >
          <Icon name="settings" size={14} />
          Filter
          {filter.active && filter.narrowedCount > 0 && (
            <span
              data-testid="doc-filter-badge"
              className="grid min-w-[16px] place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold text-[var(--paper)]"
            >
              {filter.narrowedCount}
            </span>
          )}
        </button>
        {open && <DocFilterPopover filter={filter} onClose={() => setOpen(false)} />}
      </div>

      <span className="text-[13px] tabular-nums text-subtle" data-testid="doc-filter-showing">
        {filter.active ? (
          <>
            showing {showing} of {total}
          </>
        ) : (
          <>
            {total} {total === 1 ? "doc" : "docs"}
          </>
        )}
      </span>

      <div className="ml-auto flex items-center gap-[10px]">
        <div className="inline-flex items-center gap-1.5 text-[13px] text-subtle">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.07em]">Sort</span>
          <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            <SelectTrigger data-testid="doc-sort" aria-label="Sort docs" className="h-8 bg-sunken">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_ORDER.map((k) => (
                <SelectItem key={k} value={k} data-testid={`doc-sort-${k}`}>
                  {SORT_LABEL[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-0.5 rounded-md border border-line bg-sunken p-0.5">
          <ViewButton active={view === "grid"} onClick={() => setView("grid")} icon="grid" label="Grid view" testid="view-grid" />
          <ViewButton active={view === "list"} onClick={() => setView("list")} icon="list" label="List view" testid="view-list" />
        </div>
      </div>
    </div>
  );
}

function ViewButton({
  active,
  onClick,
  icon,
  label,
  testid,
}: {
  active: boolean;
  onClick: () => void;
  icon: string;
  label: string;
  testid: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      data-testid={testid}
      onClick={onClick}
      className={`grid size-7 cursor-pointer place-items-center rounded-sm transition-colors ${
        active ? "bg-surface text-accent-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-subtle hover:text-ink"
      }`}
    >
      <Icon name={icon} size={15} />
    </button>
  );
}
