import type { ActivityCategory, ActivityCategoryCounts } from "@/features/activity/types";

// The feed category filter segment (workspace-activity S-003 / C-003) — All / Comments / Versions /
// Sharing / People, each with its per-category count. Presentational: takes the active category +
// the counts and reports a change; the screen owns the state and the fetch. Matches the prototype
// `.act-segment` (sunken pill, active = raised surface with accent ink + accent count).
//
// AS-011: selecting a segment narrows the feed (the screen re-fetches with ?category=). AS-012: the
// counts shown here come from the server's visible-set bucketing — never recomputed client-side, so
// they can't disagree with what the feed shows.

const SEGMENTS: { id: ActivityCategory; label: string }[] = [
  { id: "all", label: "All" },
  { id: "comments", label: "Comments" },
  { id: "versions", label: "Versions" },
  { id: "sharing", label: "Sharing" },
  { id: "people", label: "People" },
];

const ZERO: ActivityCategoryCounts = { all: 0, comments: 0, versions: 0, sharing: 0, people: 0 };

export function ActivityFilterSegment({
  active,
  counts,
  onChange,
}: {
  active: ActivityCategory;
  counts?: ActivityCategoryCounts;
  onChange: (category: ActivityCategory) => void;
}) {
  const c = counts ?? ZERO;
  return (
    <div
      role="tablist"
      aria-label="Filter activity by category"
      data-testid="activity-filter-segment"
      className="inline-flex gap-0.5 rounded-[9px] border border-line bg-sunken p-0.5"
    >
      {SEGMENTS.map((seg) => {
        const isActive = seg.id === active;
        return (
          <button
            key={seg.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-testid={`activity-filter-${seg.id}`}
            data-active={isActive ? "1" : "0"}
            onClick={() => onChange(seg.id)}
            className={
              "inline-flex h-7 items-center gap-1.5 rounded-[7px] px-[11px] text-[12.5px] font-medium transition-colors " +
              (isActive
                ? "bg-surface text-accent-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
                : "text-muted hover:text-ink")
            }
          >
            {seg.label}
            <span
              className={"font-mono text-[10px] tabular-nums " + (isActive ? "text-accent" : "text-subtle")}
              data-testid={`activity-filter-count-${seg.id}`}
            >
              {c[seg.id]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
