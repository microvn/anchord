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
// AS-014 / C-007: only the owner manages sharing → can("editor", "manage_sharing")
//         === false, can("owner", "manage_sharing") === true.
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
 *   - AS-014 / C-007: can("owner", "manage_sharing") === true while
 *     can("editor", "manage_sharing") === false — in v0 ONLY the owner manages
 *     sharing (change general-access, invite people, link controls).
 */
export function can(role: Role, action: Action): boolean {
  return CAPABILITIES[role].has(action);
}
