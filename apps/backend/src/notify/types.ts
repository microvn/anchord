// Shared notify types (workspace-project S-006). Kept tiny + dependency-free so both
// the pure service (notify.ts) and the Drizzle repo (repo.ts) reference one definition.

/**
 * The in-app notification kinds — mirrors the `notification_type` pgEnum (db/schema.ts).
 *
 * notifications-email (2026-06-20) broadens the v0 set. The legacy `reply` value stays valid
 * (additive migration) and folds into `thread_activity` going forward. The DB enum extension +
 * the per-event recipient dispatch land in S-001/S-002; S-007 ships the email-eligibility +
 * deep-link half of the shared path, so the type union is widened here for the eligibility helper.
 *
 * High-signal (email + in-app): new_feedback, thread_activity, suggestion_decided.
 * Low-signal (in-app only):      resolved, detached, invited.
 * `reply` is the legacy alias kept green until S-002 retires it into thread_activity.
 */
export type NotificationType =
  | "reply"
  | "new_feedback"
  | "thread_activity"
  | "suggestion_decided"
  | "resolved"
  | "detached"
  | "invited";
