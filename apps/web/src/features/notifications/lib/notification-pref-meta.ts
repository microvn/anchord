// FE presentation metadata for notification-preference rows (notification-preferences S-003).
//
// This is GROUPING + COPY ONLY — it is NOT the source of the row set. The row set comes from the
// LIVE taxonomy the API returns (AS-012). A type the API returns that this map doesn't recognize
// still renders, in the default group, with a humanized fallback label — a live type is NEVER
// dropped because the FE grouping map missed it.

export type PrefGroupId = "comments" | "workspace" | "other";

export interface PrefGroupMeta {
  id: PrefGroupId;
  title: string;
  /** Sort order of the group within the section. */
  order: number;
}

export const PREF_GROUPS: Record<PrefGroupId, PrefGroupMeta> = {
  comments: { id: "comments", title: "Comments & feedback", order: 0 },
  workspace: { id: "workspace", title: "Workspace", order: 1 },
  other: { id: "other", title: "Other", order: 2 },
};

interface TypeMeta {
  group: PrefGroupId;
  label: string;
  description: string;
}

// Known types → group + human copy. `reply` is intentionally ABSENT: it is the legacy alias the
// backend keeps green but the user-facing UI renders thread_activity instead, so reply is filtered
// out of the rendered set (see isHiddenType).
const TYPE_META: Record<string, TypeMeta> = {
  new_feedback: {
    group: "comments",
    label: "New feedback",
    description: "Someone leaves a comment or highlight on a doc you own.",
  },
  thread_activity: {
    group: "comments",
    label: "Thread activity",
    description: "A new reply lands on a thread you're part of.",
  },
  suggestion_decided: {
    group: "comments",
    label: "Suggestion decided",
    description: "A suggestion you made is accepted or dismissed.",
  },
  resolved: {
    group: "comments",
    label: "Thread resolved",
    description: "A thread you're in is marked resolved.",
  },
  detached: {
    group: "comments",
    label: "Annotation detached",
    description: "A republish detaches your annotation from the text it anchored to.",
  },
  invited: {
    group: "comments",
    label: "Shared with you",
    description: "A document is shared with you directly.",
  },
  workspace_invited: {
    group: "workspace",
    label: "Workspace invite",
    description: "You're invited to join a workspace.",
  },
  workspace_member_joined: {
    group: "workspace",
    label: "Member joined",
    description: "Someone accepts an invite and joins a workspace you're in.",
  },
  workspace_member_removed: {
    group: "workspace",
    label: "Removed from workspace",
    description: "You lose access because you were removed from a workspace.",
  },
  workspace_renamed: {
    group: "workspace",
    label: "Workspace renamed",
    description: "A workspace you're in is renamed.",
  },
};

/** Types that exist in the backend matrix but must NOT render as a user-facing row (legacy alias). */
const HIDDEN_TYPES = new Set<string>(["reply"]);

export function isHiddenType(type: string): boolean {
  return HIDDEN_TYPES.has(type);
}

/** Humanize an unknown live type into a readable label (Title Case from snake_case). */
function humanize(type: string): string {
  const s = type.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Presentation meta for a type. A type the map doesn't recognize falls back to the "other" group
 * with a humanized label — so a live taxonomy type the FE map missed still renders (AS-012).
 */
export function metaForType(type: string): TypeMeta {
  return TYPE_META[type] ?? { group: "other", label: humanize(type), description: "" };
}
