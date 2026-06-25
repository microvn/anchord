// Role / capability model (sharing S-005): the pure, DB-free contract that says
// what each role CAN do, and which role a person ends up with when access reaches
// them from more than one source (link general-access + an individual invite +
// being the owner). This module is the single source of truth that annotation-core
// (read/comment authz) and workspace-project consume — enforcement (route denies,
// hiding the comment box) lives there; the capability/precedence DECISION lives here.
//
// AS-012: viewer cannot comment → can("viewer", "comment") === false. The route that
//         denies create-comment and the UI that hides the comment box are
//         annotation-core/integration; the falsy capability is the contract here.
// AS-013 / C-002: highest role wins across multiple sources →
//         effectiveRole(["commenter", "editor"]) === "editor" (invite=editor beats
//         link=commenter).
// AS-014 / AS-023 / AS-024 / C-007: manage-sharing is the Google-Docs model and is
//         CONTEXTUAL, not a flat per-role capability. The owner ALWAYS manages sharing;
//         an editor manages sharing ONLY WHEN the doc's `editors_can_share` is on (the
//         default); viewer/commenter NEVER. Because it depends on the per-doc toggle,
//         the static `can(role, "manage_sharing")` table can NOT decide it — it stays
//         conservatively false for editor (owner-only static default) and routes MUST
//         use `canManageSharing({ role, editorsCanShare })` for the real gate.
// AS-022 / C-015: `editors_can_share` defaults on; only the OWNER may toggle it (an
//         editor cannot flip it even when it is on) → canToggleEditorsCanShare("owner")
//         === true, false for every other role.
//
// Reuses share_role's values (viewer|commenter|editor) and adds `owner` — owner is a
// model-level role, never a link/invite role stored in the share_role enum.

import { shareRole } from "../db/schema";

/**
 * Full role set, ordered least→most capable: viewer < commenter < editor < owner.
 * `owner` extends the DB `share_role` enum (viewer|commenter|editor) — owner is never
 * a link or invite role, it is conferred by doc ownership.
 */
export const ROLES = [...shareRole.enumValues, "owner"] as const;
export type Role = (typeof ROLES)[number];

/** Actions a role may be permitted to perform on a doc. */
export type Action = "view" | "comment" | "edit" | "resolve" | "manage_sharing";

/**
 * Rank for precedence: the array index in the least→most-capable ordering.
 * viewer=0 < commenter=1 < editor=2 < owner=3. Higher rank = strictly more capable.
 */
export function roleRank(role: Role): number {
  return ROLES.indexOf(role);
}

/** The more-capable of two roles (ties return either — they are equal). */
export function maxRole(a: Role, b: Role): Role {
  return roleRank(a) >= roleRank(b) ? a : b;
}

/** The less-capable of two roles (the ceiling clamp — ties return either). */
export function minRole(a: Role, b: Role): Role {
  return roleRank(a) <= roleRank(b) ? a : b;
}

/**
 * The guest cap (doc-access-two-axis S-003 / C-004). A no-account guest is never allowed
 * to EDIT: their role is clamped to AT MOST commenter — `min(role, commenter)`. This is a
 * CEILING, not a floor: a viewer link stays viewer (AS-011), a commenter/editor link
 * collapses to commenter (AS-009). Applied at the single anonymous-admission seam
 * (resolve-access anon branch) so every read AND write surface inherits one capped role
 * and no route re-implements the cap.
 */
export const GUEST_ROLE_CEILING: Role = "commenter";
export function capAnonRole(role: Role): Role {
  return minRole(role, GUEST_ROLE_CEILING);
}

/**
 * The effective role when access reaches a person from multiple sources (C-002,
 * AS-013): the HIGHEST role wins. Sources may include the general-access link role,
 * an individual invite role, and `owner`.
 *
 * Throws on an empty source list: "no sources" means the caller never established the
 * person has any access at all, which is a bug at the call site — silently returning
 * `viewer` would manufacture access that was never granted.
 */
export function effectiveRole(sources: Role[]): Role {
  if (sources.length === 0) {
    throw new Error("effectiveRole: at least one source role is required");
  }
  return sources.reduce(maxRole);
}

/**
 * Capability matrix — which actions each role is granted. Cumulative by design:
 *   viewer    → view
 *   commenter → view, comment, resolve
 *   editor    → view, comment, resolve, edit
 *   owner     → all of the above + manage_sharing
 *
 * NOTE on `manage_sharing`: this static table holds the CONSERVATIVE owner-only
 * default (only `owner` has it). It is NOT the real authorization for managing
 * sharing — that is contextual (C-007): an editor may manage sharing when the doc's
 * `editors_can_share` toggle is on. The static table cannot see the per-doc toggle, so
 * routes MUST gate on `canManageSharing({ role, editorsCanShare })`, not on
 * `can(role, "manage_sharing")`. The `owner` cell here is still meaningful (owner
 * always manages, no toggle needed); the absence of the editor cell is the safe default
 * a caller falls back to if it ignores the toggle.
 *
 * Each cell is load-bearing: flipping one entry flips exactly one capability test
 * (falsifiability). Stored as Sets so `can` is an O(1) membership check.
 */
const CAPABILITIES: Record<Role, ReadonlySet<Action>> = {
  viewer: new Set(["view"]),
  commenter: new Set(["view", "comment", "resolve"]),
  editor: new Set(["view", "comment", "resolve", "edit"]),
  owner: new Set(["view", "comment", "resolve", "edit", "manage_sharing"]),
};

/**
 * Whether `role` is permitted to perform `action`.
 *
 * Key contracts the consumers rely on:
 *   - AS-012: can("viewer", "comment") === false.
 *   - manage_sharing is the conservative owner-only static default:
 *     can("owner", "manage_sharing") === true, can("editor", "manage_sharing")
 *     === false. This is NOT the real manage-sharing gate (which is contextual,
 *     C-007) — use `canManageSharing` for that. See the CAPABILITIES note.
 */
export function can(role: Role, action: Action): boolean {
  return CAPABILITIES[role].has(action);
}

/**
 * The AUTHORITATIVE manage-sharing gate (C-007, Google-Docs model). Whether `role`
 * may manage sharing (change general-access, invite people, set link controls) on a
 * doc whose `editors_can_share` toggle is `editorsCanShare`:
 *   - owner            → always (AS-014/AS-023/AS-024 all leave the owner able).
 *   - editor           → only when `editorsCanShare` is on (AS-014 on; AS-023 off).
 *   - commenter/viewer → never, regardless of the toggle (AS-024).
 *
 * This is the function routes gate on — `can(role, "manage_sharing")` is only the
 * static fallback and deliberately ignores the per-doc toggle.
 */
export function canManageSharing(ctx: { role: Role; editorsCanShare: boolean }): boolean {
  switch (ctx.role) {
    case "owner":
      return true;
    case "editor":
      return ctx.editorsCanShare;
    case "commenter":
    case "viewer":
      return false;
  }
}

/**
 * Whether `role` may toggle `editors_can_share` itself (C-015 / AS-022): ONLY the
 * owner. An editor — even when `editors_can_share` is on and they may otherwise manage
 * sharing — can NOT change the toggle. Distinct from `canManageSharing`: managing
 * sharing (inviting, changing access) is one thing; changing who is ALLOWED to manage
 * sharing is owner-reserved.
 */
export function canToggleEditorsCanShare(role: Role): boolean {
  return role === "owner";
}
