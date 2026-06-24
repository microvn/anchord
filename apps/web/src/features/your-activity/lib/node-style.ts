import type { ActivityType } from "@/features/activity/types";
import type { NotificationType } from "@/features/notifications/types";

// Shared `.me-node` tone classes for the personal "Your activity" page (For-you + Your-actions).
// The 34px node circle is TONED BY KIND (Anchord-Design `personal.css` .me-node.{accent,green,amber,
// muted}), not always teal — so a publish reads accent, a resolve green, an invite amber, a plain
// comment muted. Both tabs map their own type enum onto the same four tones so the two surfaces stay
// visually consistent (one source of truth for the tint).

export type NodeTone = "accent" | "green" | "amber" | "muted";

/** The four tone → tailwind class pairs (mirrors personal.css `.me-node.*`, tokens.css colors). */
export const NODE_TONE_CLASS: Record<NodeTone, string> = {
  accent: "bg-accent-soft text-accent-ink",
  green: "bg-success/15 text-success",
  amber: "bg-amber-bg text-amber",
  muted: "bg-elev text-subtle",
};

// Your-actions: the activity event type → { icon, tone }. Mirrors INBOX_KINDS in personal-data.jsx
// for the prototype's own kinds (publish/resolve/comment/share/invite) and maps the remaining
// activity types sensibly (reply/restore/member/member_removed/workspace_renamed/project/detached).
const ACTION_NODE: Record<ActivityType, { icon: string; tone: NodeTone }> = {
  publish: { icon: "arrowRight", tone: "accent" },
  resolve: { icon: "check", tone: "green" },
  comment: { icon: "inbox", tone: "muted" },
  share: { icon: "share", tone: "accent" },
  invite: { icon: "mail", tone: "amber" },
  reply: { icon: "inbox", tone: "muted" },
  restore: { icon: "refresh", tone: "amber" },
  member: { icon: "members", tone: "green" },
  member_removed: { icon: "members", tone: "amber" },
  workspace_renamed: { icon: "pencil", tone: "muted" },
  project: { icon: "folder", tone: "muted" },
  detached: { icon: "alert", tone: "amber" },
};

export function actionNodeFor(type: ActivityType): { icon: string; tone: NodeTone } {
  return ACTION_NODE[type] ?? { icon: "inbox", tone: "muted" };
}

// For-you: the notification type → node tone (the icon stays `iconFor` in notifications/lib/format).
// invite/workspace_invited → amber, resolved → green, detached → amber, comment-types → accent,
// the rest → muted. Same tone vocabulary as Your-actions so the tabs read consistently.
export function inboxNodeToneFor(type: NotificationType): NodeTone {
  switch (type) {
    case "invited":
    case "workspace_invited":
      return "amber";
    case "resolved":
    case "suggestion_decided":
      return "green";
    case "detached":
      return "amber";
    case "reply":
    case "new_feedback":
    case "thread_activity":
      return "accent";
    default:
      return "muted";
  }
}

// For-you: the `.me-node` GLYPH per notification type — mirrors INBOX_KINDS in personal-data.jsx
// (mention/reply/feedback → inbox tray; resolved → check; invite → mail), NOT the bell's `iconFor`
// (which uses a pencil for comment-types). Keeps the inbox node 1:1 with the prototype.
export function inboxIconFor(type: NotificationType): string {
  switch (type) {
    case "reply":
    case "new_feedback":
    case "thread_activity":
      return "inbox";
    case "resolved":
    case "suggestion_decided":
      return "check";
    case "invited":
    case "workspace_invited":
      return "mail";
    case "detached":
      return "alert";
    default:
      return "inbox";
  }
}
