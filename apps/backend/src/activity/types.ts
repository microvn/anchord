// The workspace-activity event types (workspace-activity C-005). Each originating action logs
// exactly one. A SEPARATE taxonomy from notify/types.ts NotificationType (notifications are
// per-recipient; activity is the complete workspace log). Hand-synced with the `activity_type`
// pgEnum in db/schema.ts.
//
// S-001 EMITS only comment / reply / resolve (from annotations.ts); publish / restore / detached
// (S-005) and share / invite / member / member_removed / workspace_renamed / project (S-006) are
// later stories — but all are defined now (the enum + the union).
//
// doc-delete-trash S-001: `doc_deleted` / `doc_restored` extend the set workspace-activity C-005
// locked at 12 (now 14). FORWARD-ONLY (Postgres cannot drop an enum value) — hand-synced in
// lockstep with the pgEnum.
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
  | "detached"
  | "doc_deleted"
  | "doc_restored";
