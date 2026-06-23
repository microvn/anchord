// Activity feed category filtering + per-category counts (workspace-activity S-003 / C-003).
//
// The FE filter segment is All / Comments / Versions / Sharing / People, each with a count. This
// module is the PURE category taxonomy: it maps an event `type` to its segment, filters a list of
// rows to one segment, and buckets a list into the five counts.
//
// CRITICAL (C-003 / F-7): this module does NOT decide visibility. The route filters the workspace
// log through the ONE shared visibility gate (createActivityVisibility) FIRST, then hands the
// already-visible set here. So both the category counts AND the filtered page derive from the SAME
// visible set the feed shows — a count can never reveal an event the viewer can't see (AS-012).
//
// Category mapping (from spec #event-categories / prototype Anchord-Design/activity.jsx `cat()`):
//   Comments → comment, reply, resolve
//   Versions → publish, restore
//   Sharing  → share
//   People   → invite, member, member_removed, workspace_renamed
//   project, detached → "other": counted in All only, in NO named segment (the prototype's `cat()`
//     returns 'other' for anything outside the four buckets; the five segments named in the
//     AS/UI are All/Comments/Versions/Sharing/People, so project/detached land under All only).

import type { ActivityType } from "./types";

/** The five filter segments the FE exposes. "all" is the no-filter default. */
export type ActivityCategory = "all" | "comments" | "versions" | "sharing" | "people";

/** The named sub-segments (everything except "all") — what a row can belong to. */
export type ActivitySegment = Exclude<ActivityCategory, "all">;

/**
 * The single source of truth for type → segment. A type absent from this map is "other" (project /
 * detached): it belongs to NO named segment and is counted only under All.
 */
const SEGMENT_OF: Partial<Record<ActivityType, ActivitySegment>> = {
  comment: "comments",
  reply: "comments",
  resolve: "comments",
  publish: "versions",
  restore: "versions",
  share: "sharing",
  invite: "people",
  member: "people",
  member_removed: "people",
  workspace_renamed: "people",
  // project, detached → undefined → "other" (All only).
};

/** Per-category counts the filter segment renders next to each label. */
export interface ActivityCategoryCounts {
  all: number;
  comments: number;
  versions: number;
  sharing: number;
  people: number;
}

/** The segment a single type belongs to, or null for "other" (project / detached). */
export function segmentOf(type: ActivityType): ActivitySegment | null {
  return SEGMENT_OF[type] ?? null;
}

/** Whether `category` is a valid filter value (used to validate the query param). */
export function isActivityCategory(value: unknown): value is ActivityCategory {
  return value === "all" || value === "comments" || value === "versions" || value === "sharing" || value === "people";
}

/**
 * Keep only the rows in `category`, preserving order. "all" passes everything through; a named
 * segment keeps only rows whose type maps to it (AS-011 — Versions returns only publish/restore).
 */
export function filterByCategory<R extends { type: ActivityType }>(rows: R[], category: ActivityCategory): R[] {
  if (category === "all") return rows;
  return rows.filter((r) => segmentOf(r.type) === category);
}

/**
 * Bucket the (already-visible) rows into the five counts. `all` is the total; each named segment is
 * the count of rows mapping to it. project/detached add to `all` only (AS-012 — counts are over the
 * visible set, so they can never exceed what the feed shows).
 */
export function countByCategory<R extends { type: ActivityType }>(rows: R[]): ActivityCategoryCounts {
  const counts: ActivityCategoryCounts = { all: rows.length, comments: 0, versions: 0, sharing: 0, people: 0 };
  for (const row of rows) {
    const seg = segmentOf(row.type);
    if (seg) counts[seg] += 1;
  }
  return counts;
}
