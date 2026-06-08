// Shared notify types (workspace-project S-006). Kept tiny + dependency-free so both
// the pure service (notify.ts) and the Drizzle repo (repo.ts) reference one definition.

/**
 * The in-app notification kinds — mirrors the `notification_type` pgEnum (db/schema.ts).
 * Only 'reply' exists in v0 (AS-011); the union is extensible (mention/resolve/…) without
 * touching the service signature.
 */
export type NotificationType = "reply";
