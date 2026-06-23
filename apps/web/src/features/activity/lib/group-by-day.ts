import { format, isToday, isYesterday } from "date-fns";
import type { ActivityEventRow } from "@/features/activity/types";

// Client-side day-grouping for the activity feed (workspace-activity C-007 / AS-002).
//
// The server returns a FLAT recent-first list; the FE groups it into day buckets in the VIEWER's
// timezone — "Today" / "Yesterday" / a dated label (e.g. "Jun 21"). A day may straddle a page
// boundary, so grouping merges consecutive same-day rows under ONE header. Input order is preserved
// (the server already sorts newest-first), so the buckets come out most-recent-day-first and the
// rows inside each bucket stay newest-first.

export interface ActivityDayGroup {
  /** The display label — "Today" / "Yesterday" / "MMM d" (viewer TZ). */
  label: string;
  /** A stable key for React (the calendar date, viewer TZ). */
  key: string;
  rows: ActivityEventRow[];
}

/** The viewer-TZ label for an instant: Today / Yesterday / "MMM d" (e.g. "Jun 21"). */
export function dayLabel(date: Date): string {
  if (isToday(date)) return "Today";
  if (isYesterday(date)) return "Yesterday";
  return format(date, "MMM d");
}

/**
 * Group a recent-first flat list into day buckets, preserving order. Same-day rows that span a page
 * boundary collapse under one header because we key on the calendar date (yyyy-MM-dd in viewer TZ)
 * and append to the current bucket while the date matches.
 */
export function groupByDay(rows: ActivityEventRow[]): ActivityDayGroup[] {
  const groups: ActivityDayGroup[] = [];
  let current: ActivityDayGroup | undefined;
  for (const row of rows) {
    const date = new Date(row.createdAt);
    const key = Number.isNaN(date.getTime()) ? "unknown" : format(date, "yyyy-MM-dd");
    if (!current || current.key !== key) {
      current = { key, label: Number.isNaN(date.getTime()) ? "Earlier" : dayLabel(date), rows: [] };
      groups.push(current);
    }
    current.rows.push(row);
  }
  return groups;
}
