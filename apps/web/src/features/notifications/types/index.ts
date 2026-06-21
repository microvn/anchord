// Shared wire types for the in-app notification bell (notifications-email S-006).

/** The in-app notification kinds — mirrors the backend `notification_type` (db/schema.ts). */
export type NotificationType =
  | "reply"
  | "new_feedback"
  | "thread_activity"
  | "suggestion_decided"
  | "resolved"
  | "detached"
  | "invited";

/**
 * One notification row as the bell renders it. The deep-link target is `/d/:slug#annotation-:refId`
 * — `refId` is the annotation (thread) id, `slug` its doc's slug (null when refId isn't an annotation,
 * e.g. an `invited` row; the client then skips the deep-link and only marks read).
 */
export interface NotificationItem {
  id: string;
  type: NotificationType;
  refId: string;
  read: boolean;
  createdAt: string;
  slug: string | null;
  /**
   * Panel enrichment (notifications-email S-006, all NULL-safe — C-014):
   * - docTitle: the row's doc title (AS-026); null for a non-doc row (e.g. `invited`).
   * - actorName: the triggering commenter's display name — member name or guest name (AS-027);
   *   null for a non-comment row or a row whose comment was removed (AS-029).
   * - snippet: a short excerpt of the triggering comment body (AS-028), IN-APP ONLY; null when no
   *   resolvable comment. It is untrusted user text — render as inert React children, never as HTML.
   */
  docTitle?: string | null;
  actorName?: string | null;
  snippet?: string | null;
}

/** The paginated list payload (`{ items, pagination }`) the backend returns. */
export interface NotificationPage {
  items: NotificationItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrevious: boolean;
  };
}
