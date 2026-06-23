import { initials } from "@/lib/initials";
import type { ActivityStats } from "@/features/activity/types";

// The activity stats rail (workspace-activity S-007 — the `ActivityStatsRail` presentational piece).
//
// PRESENTATIONAL: takes the stats payload (+ loading) as props, NOT bound to any fetch — the
// ActivityScreen wrapper does the fetch and passes the result down. Three cards, ported from the
// prototype's `.act-rail` (Anchord-Design/activity.jsx + activity.css):
//   - RailStatCard: "Last 7 days" headline count + a 2x2 mini-grid (comments/versions/shares/people)
//   - "Most active": a ContributorRow list ranked highest-first with a proportional bar
//   - "Busiest doc": the doc name + its event count
//
// All three cover a trailing 7-day window and the viewer's VISIBLE set — the server computed both
// (C-006/C-003), so a member's rail never names a doc they can't open (AS-028). All names are PLAIN
// TEXT (escaped by React) — never dangerouslySetInnerHTML (F-12).

/** The flat rail card shell — matches the feed's `border-line bg-surface` chrome + prototype padding. */
function RailCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[11px] border border-line bg-surface px-4 py-3.5">
      <div className="mb-2.5 font-mono text-[11px] uppercase tracking-[0.1em] text-subtle">{label}</div>
      {children}
    </div>
  );
}

/** One contributor row: avatar + name + a proportional bar + the count (prototype `.contrib-row`). */
function ContributorRow({ name, count, max }: { name: string; count: number; max: number }) {
  const isSystem = name === "System";
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2.5 border-t border-soft py-1.5 first:border-t-0" data-testid="contributor-row">
      <span
        aria-hidden="true"
        className="grid size-[22px] flex-none place-items-center rounded-full bg-elev text-[9px] font-semibold text-muted"
      >
        {isSystem ? "◆" : initials(name)}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{name}</span>
      <span className="h-[5px] w-[54px] flex-none overflow-hidden rounded-[3px] bg-elev">
        <i className="block h-full rounded-[3px] bg-accent" style={{ width: `${pct}%` }} />
      </span>
      <span className="w-3.5 flex-none text-right font-mono text-[10.5px] text-subtle tabular-nums">{count}</span>
    </div>
  );
}

export function ActivityStatsRail({
  stats,
  loading = false,
}: {
  stats?: ActivityStats;
  loading?: boolean;
}) {
  // The rail is a secondary summary — while it loads (or if the read failed and stats is absent) it
  // simply renders nothing rather than pushing a skeleton into the layout.
  if (loading || !stats) return null;

  const { counts, contributors, busiestDoc } = stats;
  const max = contributors[0]?.count ?? 0;

  return (
    <aside
      data-testid="activity-stats-rail"
      className="flex flex-row flex-wrap gap-3.5 lg:sticky lg:top-[22px] lg:flex-col"
    >
      {/* Last-7-days headline + the per-category mini-grid. */}
      <RailCard label="Last 7 days">
        <div className="flex items-baseline gap-2">
          <span className="font-serif text-[27px] font-medium leading-none tracking-[-0.01em] text-ink tabular-nums" data-testid="stat-recent-count">
            {counts.all}
          </span>
          <span className="text-[11.5px] text-muted">events</span>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2.5">
          <div>
            <div className="font-serif text-[19px] font-medium text-ink tabular-nums">{counts.comments}</div>
            <div className="text-[10.5px] text-subtle">comments</div>
          </div>
          <div>
            <div className="font-serif text-[19px] font-medium text-ink tabular-nums">{counts.versions}</div>
            <div className="text-[10.5px] text-subtle">versions</div>
          </div>
          <div>
            <div className="font-serif text-[19px] font-medium text-ink tabular-nums">{counts.sharing}</div>
            <div className="text-[10.5px] text-subtle">shares</div>
          </div>
          <div>
            <div className="font-serif text-[19px] font-medium text-ink tabular-nums">{counts.people}</div>
            <div className="text-[10.5px] text-subtle">people</div>
          </div>
        </div>
      </RailCard>

      {/* Most active — ranked highest-first (AS-027). Hidden when there's no in-window activity. */}
      {contributors.length > 0 && (
        <RailCard label="Most active">
          {contributors.map((c) => (
            <ContributorRow key={c.name} name={c.name} count={c.count} max={max} />
          ))}
        </RailCard>
      )}

      {/* Busiest doc (AS-028) — its name is on the viewer's visible set, never a doc they can't open. */}
      {busiestDoc && (
        <RailCard label="Busiest doc">
          <div className="text-[13px] font-semibold leading-snug text-ink" data-testid="busiest-doc-name">
            {busiestDoc.name}
          </div>
          <div className="mt-1 font-mono text-[11.5px] text-subtle">
            {busiestDoc.events} {busiestDoc.events === 1 ? "event" : "events"}
          </div>
        </RailCard>
      )}
    </aside>
  );
}
