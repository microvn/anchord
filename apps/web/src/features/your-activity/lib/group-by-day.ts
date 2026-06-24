import { isToday, isYesterday, format } from "date-fns";
import type { NotificationItem } from "@/features/notifications/types";

// your-activity-inbox S-001 (AS-002 / C-006): client-side day grouping over the flat paged list,
// computed in the VIEWER's timezone. date-fns owns the date math (project rule — no hand-rolled Date
// arithmetic). The label is "Today" / "Yesterday" / an absolute date for older days. Items arrive
// newest-first from the read; this preserves that order, so the groups come out newest-day-first and
// each group's rows stay newest-first. Same-day headers merge across page boundaries because grouping
// runs over the whole accumulated list at once (C-006).

export interface InboxDayGroup {
  /** A stable key for the day (the yyyy-MM-dd in local time). */
  key: string;
  /** The human label: "Today", "Yesterday", or e.g. "Mar 3, 2026". */
  label: string;
  items: NotificationItem[];
}

/** A generic day group over any row carrying a `createdAt` ISO string. */
export interface DayGroup<T> {
  key: string;
  label: string;
  items: T[];
}

/** The viewer-local day label for one timestamp. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Earlier";
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  // For an "earlier" day, drop the year when it's the current year for a tighter label.
  const sameYear = d.getFullYear() === now.getFullYear();
  return format(d, sameYear ? "MMM d" : "MMM d, yyyy");
}

/** The viewer-local yyyy-MM-dd key (stable per calendar day, timezone-aware). */
function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "invalid";
  return format(d, "yyyy-MM-dd");
}

/**
 * Group a newest-first flat list into day buckets, preserving order (newest day first, newest row
 * first within a day). Consecutive same-day items merge under one header even across page fetches.
 */
export function groupByDay(items: NotificationItem[], now: Date = new Date()): InboxDayGroup[] {
  return groupRowsByDay(items, now);
}

/**
 * The generic day-grouper used by both the For-you inbox and the cross-workspace "Your actions" feed
 * (your-activity-actions S-001 / C-007). Identical newest-day-first / newest-row-first semantics; the
 * only requirement on a row is a `createdAt` ISO string.
 */
export function groupRowsByDay<T extends { createdAt: string }>(
  items: T[],
  now: Date = new Date(),
): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  const index = new Map<string, DayGroup<T>>();
  for (const it of items) {
    const key = dayKey(it.createdAt);
    let group = index.get(key);
    if (!group) {
      group = { key, label: dayLabel(it.createdAt, now), items: [] };
      index.set(key, group);
      groups.push(group);
    }
    group.items.push(it);
  }
  return groups;
}
