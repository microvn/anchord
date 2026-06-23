import type { ActivityEventDetail } from "@/features/activity/types";

// "Open doc" deep-link builder for the activity detail page (workspace-activity S-004).
//
// The doc viewer is slug-addressed at `/d/:slug` and focuses an annotation via the URL fragment
// `#annotation-<annotationId>` (the SAME fragment the email deep-link + the in-app focus path use —
// notifications-email S-007 / viewer deep-link-fragment). This pure helper turns a detail event into
// that href, so the three "Open doc" behaviours are unit-testable without a browser:
//
//   AS-016  the comment event's annotation still resolves → `/d/<slug>#annotation-<id>` (the viewer
//           scrolls to it on mount).
//   AS-017  the annotation has DETACHED (the event carries no annotationId, or it was set-null on
//           re-anchor failure) → `/d/<slug>` with NO fragment → the viewer opens at the top, never
//           failing on a stale fragment.
//   AS-018  the doc was deleted → no current slug (docSlug null) → null href → the caller renders
//           "Open doc" as a disabled/degraded control rather than a broken link.

/**
 * Build the "Open doc" href for an activity event, or null when there is no live doc to open
 * (workspace-level event, or a deleted doc — AS-018). When an annotation ref survives, the href
 * carries the `#annotation-<id>` fragment so the viewer scrolls to it (AS-016); otherwise it points
 * at the doc top (AS-017).
 */
export function openDocHref(event: Pick<ActivityEventDetail, "docSlug" | "annotationId">): string | null {
  if (!event.docSlug) return null; // AS-018: deleted doc / workspace-level — degrade, no link
  const base = `/d/${event.docSlug}`;
  // AS-016 vs AS-017: a surviving annotation ref deep-links to it; a detached one (null) opens the top.
  return event.annotationId ? `${base}#annotation-${event.annotationId}` : base;
}
