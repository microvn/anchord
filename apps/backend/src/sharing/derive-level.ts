// deriveLevel (doc-access-two-axis S-001 / C-008): the legacy single general-access
// LEVEL is no longer stored anywhere — `docs.general_access` is dropped. Instead it is
// DERIVED on read from the two independent share_links axes (workspace_role + link_role):
//
//   { null,  null } → "restricted"            (only owner + individually-invited reach it)
//   { set,   null } → "anyone_in_workspace"   (shared with the workspace, no public link)
//   { *,     set  } → "anyone_with_link"       (a public link exists; link role grants access)
//
// The link axis dominates the legacy 3-value summary: ANY link_role (regardless of the
// workspace axis) reads as "anyone_with_link", because the legacy enum cannot express
// "workspace AND link" — that lossiness is exactly why reads also carry the raw axes
// (S-006 / C-008). This helper exists so the downstream readers that still speak the
// legacy level keep compiling/behaving while their per-story rework lands.
//
// PURE — no DB. The role VALUES themselves (viewer/commenter/editor) are irrelevant to
// the level; only whether each axis is set/null matters.

/** The legacy three-value general-access level. Previously `docs.general_access`'s enum;
 *  now a derived, never-stored summary (the enum is dropped from the schema). */
export type GeneralAccessLevel = "restricted" | "anyone_in_workspace" | "anyone_with_link";

/** A share role on either axis, or null (the axis is off). */
export type AxisRole = "viewer" | "commenter" | "editor" | null;

/**
 * Derive the legacy general-access level from the two axes (C-008). The link axis wins:
 * any non-null `linkRole` ⇒ "anyone_with_link"; otherwise a non-null `workspaceRole` ⇒
 * "anyone_in_workspace"; both null ⇒ "restricted".
 */
export function deriveLevel(workspaceRole: AxisRole, linkRole: AxisRole): GeneralAccessLevel {
  if (linkRole != null) return "anyone_with_link";
  if (workspaceRole != null) return "anyone_in_workspace";
  return "restricted";
}
