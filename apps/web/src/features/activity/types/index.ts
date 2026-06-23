// Shared types for the workspace activity feed (workspace-activity S-001).
//
// `ActivityEventRow` is the row shape the backend feed serves AND the shape the presentational
// feed components take as props (rows-as-props — the export contract / ## Linked Fields, so the
// personal "Your actions" feed, 2b, reuses the same components + a different fetch wrapper).

/** The twelve event types (C-005) — the FE renders an icon/tone per type. */
export type ActivityType =
  | "comment"
  | "reply"
  | "resolve"
  | "publish"
  | "restore"
  | "share"
  | "invite"
  | "member"
  | "member_removed"
  | "workspace_renamed"
  | "project"
  | "detached";

/** The five feed filter segments (S-003). "all" is the no-filter default. */
export type ActivityCategory = "all" | "comments" | "versions" | "sharing" | "people";

/** Per-category counts over the viewer's visible set — rendered next to each segment label (S-003). */
export interface ActivityCategoryCounts {
  all: number;
  comments: number;
  versions: number;
  sharing: number;
  people: number;
}

/** One feed row as served + rendered. actorName/summary/target are PLAIN TEXT (escaped, never HTML). */
export interface ActivityEventRow {
  id: string;
  type: ActivityType;
  actorUserId: string | null;
  actorName: string;
  docId: string | null;
  projectId: string | null;
  versionId: string | null;
  commentId: string | null;
  annotationId: string | null;
  summary: string | null;
  target: string | null;
  meta: unknown;
  /** ISO timestamp string from the API envelope (parsed client-side for day-grouping). */
  createdAt: string;
}

/**
 * The detail-page event shape (workspace-activity S-004): a feed row enriched at READ time with the
 * CURRENT doc link target for "Open doc" — the viewer is slug-addressed (`/d/:slug`), so the detail
 * read resolves the doc's slug + project name. A deleted doc resolves to null and "Open doc"
 * degrades (AS-018). `docSlug`/`projectName` are absent on workspace-level events (no doc target).
 */
export interface ActivityEventDetail extends ActivityEventRow {
  /** the doc's current viewer slug, or null when the doc is deleted / the event is workspace-level. */
  docSlug?: string | null;
  /** the doc's current project name, for the metadata list / document card. */
  projectName?: string | null;
}

/** One "most active" contributor in the stats rail (S-007): display name + in-window event count. */
export interface ActivityContributor {
  name: string;
  count: number;
}

/** The busiest doc in the stats rail (S-007): doc id, display name, and in-window event count. */
export interface ActivityBusiestDoc {
  docId: string;
  name: string;
  events: number;
}

/**
 * The stats-rail payload (S-007): per-category counts, ranked contributors, and the busiest doc —
 * all over a trailing 7-day window (C-006), computed over the viewer's visible set (C-003) so a
 * member's rail never includes a doc they can't access (AS-028).
 */
export interface ActivityStats {
  counts: ActivityCategoryCounts;
  contributors: ActivityContributor[];
  busiestDoc: ActivityBusiestDoc | null;
}

/** The type-specific `meta` JSON a publish event carries (S-004 PublishDiffMini reads from/to/adds/dels). */
export interface ActivityPublishMeta {
  from?: string;
  to?: string;
  adds?: number;
  dels?: number;
}
