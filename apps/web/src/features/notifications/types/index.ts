// Shared wire types for the in-app notification bell (notifications-email S-006).

/** The in-app notification kinds — mirrors the backend `notification_type` (db/schema.ts). */
export type NotificationType =
  | "reply"
  | "new_feedback"
  | "thread_activity"
  | "suggestion_decided"
  | "resolved"
  | "detached"
  | "invited"
  // workspace-notifications membership events (your-activity-inbox H1 type sync). The backend
  // (notify/types.ts) already produces these — adding them so a `workspace_invited` row renders
  // and typechecks. Additive: the bell ignores the ones it doesn't map.
  | "workspace_invited"
  | "workspace_member_joined"
  | "workspace_member_removed"
  | "workspace_renamed";

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
  /**
   * workspace-notifications: the display label SNAPSHOTTED at emit (e.g. the workspace name for a
   * `workspace_invited` row). For a `workspace_*` row `refId` is the workspace id and `refLabel` is
   * its name. Additive — the bell ignores it.
   */
  refLabel?: string | null;
  /**
   * your-activity-inbox S-001 (BE-enrich, AS-003): the workspace that OWNS this notification's
   * target, so the cross-workspace For-you inbox can render a per-item workspace chip. Derived
   * read-time on the backend (doc→project→workspace chain, or `workspace_*` refId/refLabel). Both
   * NULL when neither resolves. Additive — the bell ignores them.
   */
  workspaceId?: string | null;
  workspaceName?: string | null;
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
