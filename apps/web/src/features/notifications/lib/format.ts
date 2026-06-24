import type { NotificationItem, NotificationType } from "@/features/notifications/types";

// Pure presentation helpers for the bell — relative time, the row's summary line, and the in-app
// deep-link route. DOM-free so they're directly unit-testable.

/** A compact relative time ("just now", "5m", "3h", "2d", or a date for older rows). */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const sec = Math.max(0, Math.floor((now - then) / 1000));
  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(then).toLocaleDateString();
}

// Per-type one-line summary. Mirrors the backend's email subjects/summaries (notify.ts) so the
// in-app text reads consistently with the email. Unknown future types fall back to a neutral line.
const SUMMARY: Record<NotificationType, string> = {
  reply: "New reply on a thread you're in",
  thread_activity: "New activity on a thread you're in",
  new_feedback: "New feedback on your document",
  suggestion_decided: "A suggestion you made was decided",
  resolved: "A thread you're in was resolved",
  detached: "A comment lost its anchor after an edit",
  invited: "You were invited to a document",
  // workspace-notifications membership events (your-activity-inbox H1 type sync). The cross-workspace
  // For-you inbox renders these; the bell ignores them. Headlines read consistently with the email.
  workspace_invited: "You were invited to a workspace",
  workspace_member_joined: "A new member joined a workspace",
  workspace_member_removed: "You were removed from a workspace",
  workspace_renamed: "A workspace was renamed",
};

export function summaryFor(type: NotificationType): string {
  return SUMMARY[type] ?? "New notification";
}

/**
 * The leading type glyph for a row — conveys KIND by shape (per DESIGN.md: a single line-glyph,
 * never a colored disc; the row's teal/ink weight carries the unread signal). Maps to an icon name
 * in `@/components/icon`. Unknown/future types fall back to the neutral `bell`.
 */
export function iconFor(type: NotificationType): string {
  switch (type) {
    case "reply":
    case "thread_activity":
    case "new_feedback":
      return "pencil";
    case "suggestion_decided":
    case "resolved":
      return "check";
    case "detached":
      return "alert";
    case "invited":
      return "mail";
    default:
      return "bell";
  }
}

/** The comment-type rows whose summary can be enriched with an actor + doc title (AS-027). */
const COMMENT_TYPES: ReadonlySet<NotificationType> = new Set<NotificationType>([
  "reply",
  "new_feedback",
  "thread_activity",
]);

// Per-type enriched template for a comment-type row that carries an actor (AS-026/AS-027). `{actor}`
// and `{title}` are filled from the row; `{title}` collapses to "a document" when the doc title is
// absent (the actor still names who acted). Non-comment types never reach here.
const ACTOR_TEMPLATE: Partial<Record<NotificationType, (actor: string, title: string) => string>> = {
  reply: (a, t) => `${a} replied in ${t}`,
  thread_activity: (a, t) => `${a} commented in ${t}`,
  new_feedback: (a, t) => `${a} left feedback on ${t}`,
};

// The connective verb between an actor and the doc title for a comment-type row ("{actor} {verb}
// {title}"). Kept in lockstep with ACTOR_TEMPLATE so the structured + flat renderings read alike.
const ACTOR_VERB: Partial<Record<NotificationType, string>> = {
  reply: "replied in",
  thread_activity: "commented in",
  new_feedback: "left feedback on",
};

/** The styled pieces of a row's headline (rendered as separate spans, not one flat string). */
export interface HeadlineParts {
  /** The triggering actor's display name — present only on an enriched comment-type row. */
  actor?: string;
  /** The connective/generic verb phrase (e.g. "commented in", or the generic per-type summary). */
  verb: string;
  /** The doc title — present when the row names a doc. */
  title?: string;
  /** How `verb` and `title` join inline: " " after an actor verb, " · " after a generic verb. */
  titleSeparator: " " | " · ";
}

/**
 * The structured headline for a row (AS-026/AS-027/AS-029), as styled spans:
 * - comment-type WITH actor → `{actor}` + verb ("commented in") + `{title}` (collapses to
 *   "a document" when absent), joined by a space.
 * - non-comment WITH a doc title → the generic per-type `verb` + `{title}`, joined by " · ".
 * - no actor + no title (invited, or a comment-type row whose comment/doc is gone) → just `verb`.
 * Pure + null-safe (C-014); the snippet is rendered separately.
 */
export function headlineParts(
  item: Pick<NotificationItem, "type" | "actorName" | "docTitle">,
): HeadlineParts {
  if (COMMENT_TYPES.has(item.type) && item.actorName) {
    return {
      actor: item.actorName,
      verb: ACTOR_VERB[item.type] ?? "commented in",
      title: item.docTitle || "a document",
      titleSeparator: " ",
    };
  }
  const verb = summaryFor(item.type);
  if (item.docTitle) return { verb, title: item.docTitle, titleSeparator: " · " };
  return { verb, titleSeparator: " · " };
}

/**
 * The row's headline summary. When a comment-type row carries an actor (AS-027), it reads
 * "{actor} replied in {docTitle}" (the title collapses to "a document" when absent, AS-026/AS-029);
 * otherwise — a non-comment row, or a comment-type row whose comment/doc is gone — it degrades to the
 * generic per-type string (AS-029). Pure + null-safe (C-014); the snippet is rendered separately.
 */
export function summaryForItem(
  item: Pick<NotificationItem, "type" | "actorName" | "docTitle">,
): string {
  const tmpl = COMMENT_TYPES.has(item.type) ? ACTOR_TEMPLATE[item.type] : undefined;
  if (tmpl && item.actorName) {
    return tmpl(item.actorName, item.docTitle || "a document");
  }
  // A doc-scoped non-comment row can still name its doc ("… in {title}") without an actor.
  const base = summaryFor(item.type);
  if (item.docTitle) return `${base} · ${item.docTitle}`;
  return base;
}

/**
 * The in-app deep-link route for a notification, or null when it can't be built. The viewer reads
 * the `#annotation-:id` fragment on mount and scrolls/highlights that thread — same target as the
 * email deep-link `{APP_URL}/d/{slug}#annotation-{id}`, here a RELATIVE route for client navigation.
 * Null when the row carries no slug (e.g. an `invited` row, or the annotation's doc is gone).
 */
export function deepLinkFor(item: Pick<NotificationItem, "slug" | "refId">): string | null {
  if (!item.slug) return null;
  return `/d/${encodeURIComponent(item.slug)}#annotation-${encodeURIComponent(item.refId)}`;
}
