// The stats-rail aggregator (workspace-activity S-007 / C-006).
//
// PURE aggregation over an ALREADY-VISIBLE row set. The route loads the workspace log, filters it
// through the ONE shared visibility gate (createActivityVisibility — the FOURTH and last surface,
// C-003/F-7), and hands the visible rows here. This module NEVER decides visibility: a member's rail
// excludes inaccessible docs because the gate already removed them BEFORE aggregation — so the
// counts AND the busiest-doc name can never reference a doc the member can't open (AS-028).
//
// All three aggregates cover a TRAILING 7-DAY WINDOW (C-006/AS-026): events older than 7 days are
// dropped first, then everything (counts, contributors, busiest doc) is computed over the remainder.
// Window math uses date-fns (project rule: no hand-rolled Date arithmetic).

import { subDays } from "date-fns";
import { countByCategory, type ActivityCategoryCounts } from "./category";
import type { ActivityRow } from "./repo";

/** One "most active" contributor: their display name + their in-window event count. */
export interface ContributorStat {
  name: string;
  count: number;
}

/** The busiest doc in the window: its id, display name (from the row target), and event count. */
export interface BusiestDoc {
  docId: string;
  name: string;
  events: number;
}

/** The stats-rail payload: per-category counts, ranked contributors, and the single busiest doc. */
export interface ActivityStats {
  /** Per-category counts over the in-window visible set (same taxonomy as the feed segment). */
  counts: ActivityCategoryCounts;
  /** "Most active" — contributors ranked highest-first by in-window event count. */
  contributors: ContributorStat[];
  /** The doc with the most in-window events, or null when no doc-scoped event is in the window. */
  busiestDoc: BusiestDoc | null;
}

/** How many contributors the rail lists (the prototype shows the top handful). */
const TOP_CONTRIBUTORS = 5;

/**
 * Aggregate the (already-visible) rows into the rail stats over the trailing 7-day window ending at
 * `now`. `now` is injected so the window is deterministic in tests; the route passes the real time.
 */
export function computeStats(rows: ActivityRow[], now: Date = new Date()): ActivityStats {
  // C-006/AS-026: keep only events in the last 7 days. subDays(now, 7) is the inclusive lower bound.
  const windowStart = subDays(now, 7);
  const inWindow = rows.filter((r) => r.createdAt >= windowStart);

  // Per-category counts over the in-window set (reuse the feed's taxonomy so the rail and the feed
  // segment can never disagree on what a category is).
  const counts = countByCategory(inWindow);

  // Contributors: tally by actorName, then rank highest-first. Ties keep first-seen order (stable).
  const byActor = new Map<string, number>();
  for (const r of inWindow) byActor.set(r.actorName, (byActor.get(r.actorName) ?? 0) + 1);
  const contributors = [...byActor.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_CONTRIBUTORS);

  // Busiest doc: tally doc-scoped rows by docId (workspace-level rows, docId null, never qualify),
  // keep the highest. The display name comes from the row's stored `target` (plain text) so it is
  // already on the visible set — never a separate lookup that could leak an inaccessible doc.
  const byDoc = new Map<string, { name: string; events: number }>();
  for (const r of inWindow) {
    if (r.docId == null) continue;
    const cur = byDoc.get(r.docId);
    if (cur) cur.events += 1;
    else byDoc.set(r.docId, { name: r.target ?? "", events: 1 });
  }
  let busiestDoc: BusiestDoc | null = null;
  for (const [docId, { name, events }] of byDoc) {
    if (!busiestDoc || events > busiestDoc.events) busiestDoc = { docId, name, events };
  }

  return { counts, contributors, busiestDoc };
}
