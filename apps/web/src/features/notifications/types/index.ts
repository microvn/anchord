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
