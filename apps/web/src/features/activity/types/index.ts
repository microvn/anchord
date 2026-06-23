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
