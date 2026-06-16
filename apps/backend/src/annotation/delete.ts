// Delete (soft) an annotation — own, or owner moderation (annotation-actions S-004).
// Pure authz + an injectable DeleteRepo port, mirroring resolve.ts (ResolutionRepo) and
// annotation.ts (AnnotationRepo). The route owns session-required + existence-hiding 404 +
// parent-doc binding (it resolves the parent doc and the author_id BEFORE calling here);
// this module owns the SERVER-side own/owner authorization and the soft-delete write.
//
// C-006: delete-OWN = the author — an ACCOUNT-HOLDER whose `author_id` equals the acting
//        user id (a guest's null id never matches). delete-ANY (moderation) = the doc OWNER
//        (sessionRole === "owner"), on anyone's. NOT a static can(role,…) grant — delete is
//        CONTEXTUAL (own via author_id vs owner), like manage_sharing.
//
// The READ-exclusion + terminal guards (refuse decide/resolve on a deleted row) + restore are
// a SEPARATE story (S-005); this module only sets the tombstone.

import type { Role } from "../sharing/roles";

/**
 * Persistence port — the real implementation is thin Drizzle glue (set `deleted_at`).
 * Mirrors ResolutionRepo: keeping it a port makes the authz unit-testable without a DB.
 */
export interface DeleteRepo {
  /** S-004 / C-006: stamp the soft-delete tombstone (set `deleted_at` to now). */
  setDeletedAt(annotationId: string): Promise<void>;
}

export interface DeleteAnnotationInput {
  annotationId: string;
  /**
   * The acting user's id, resolved SERVER-side from the session. NULL is impossible on the
   * route (delete is session-required — an anon is refused BEFORE this runs), but the null
   * guard below is kept so the pure function is correct even if a null leaks in: a null
   * actor can never own an annotation (own requires actorUserId != null).
   */
  actorUserId: string | null;
  /** The role resolved SERVER-side from the session — owner unlocks moderation delete. */
  sessionRole: Role;
  /**
   * The annotation's durable creator (`author_id`), resolved from the parent-doc lookup.
   * NULL for a guest-created annotation — which therefore has NO owner who can delete-own it
   * (only owner-moderation can remove it). A null author can never equal a (possibly null)
   * actor for delete-own, because own ALSO requires actorUserId != null.
   */
  authorId: string | null;
}

export type DeleteAnnotationResult = { ok: true } | { ok: false; reason: "forbidden" };

/**
 * Decide whether the acting user may delete the annotation, and soft-delete on allow (S-004).
 *
 * Authz (C-006):
 *   - delete-OWN: `actorUserId != null && actorUserId === authorId`. The `!= null` guard is
 *     load-bearing — a guest actor (null) creating a guest annotation (null author) must NOT
 *     match (null === null would otherwise wrongly grant delete-own).
 *   - delete-ANY (moderation): `sessionRole === "owner"`, on anyone's annotation.
 * A non-owner non-author (viewer, or a commenter who isn't the author) is refused: the repo
 * is never written, so the annotation is untouched.
 */
export async function deleteAnnotation(
  input: DeleteAnnotationInput,
  repo: DeleteRepo,
): Promise<DeleteAnnotationResult> {
  const { annotationId, actorUserId, sessionRole, authorId } = input;

  const isOwnerModeration = sessionRole === "owner";
  // The null guard makes a guest (null actor) on a guest annotation (null author) NOT own.
  const isOwnAuthor = actorUserId != null && actorUserId === authorId;

  if (!isOwnerModeration && !isOwnAuthor) {
    return { ok: false, reason: "forbidden" };
  }

  await repo.setDeletedAt(annotationId);
  return { ok: true };
}

// ── annotation-actions S-005: restore (clear the tombstone) (RestoreRepo) ──────
//
// C-007: restore is the durable undo backing the FE's optimistic-undo toast. It is the SAME
// authz family as delete (C-006): restore-OWN by the author (an account-holder whose
// `author_id` matches the actor) OR restore-ANY by the doc OWNER (moderation). A
// viewer / guest / non-owner-non-author cannot restore another's.
//
// NOTE on existence-hiding: the route resolves the parent doc via a lookup that does NOT
// filter out soft-deleted rows (only the ACTIVE-read surfaces filter — list/search/re-anchor).
// So the restore path can FIND a tombstoned row and clear it. The 404 the route emits is
// ACCESS-based (can you see the parent doc), never deleted-based — a row you can't see is
// indistinguishable from a missing id, but a deleted row you CAN see is restorable.

/**
 * Persistence port — thin Drizzle glue (clear `deleted_at`). Mirrors DeleteRepo so the
 * authz stays unit-testable without a DB.
 */
export interface RestoreRepo {
  /** S-005 / C-007: clear the soft-delete tombstone (set `deleted_at` back to null). */
  clearDeletedAt(annotationId: string): Promise<void>;
}

export interface RestoreAnnotationInput {
  annotationId: string;
  /** The acting user's id, resolved SERVER-side from the session (null is impossible past the
   *  route's session gate, but the null guard below keeps the pure function correct). */
  actorUserId: string | null;
  /** The role resolved SERVER-side — owner unlocks moderation restore. */
  sessionRole: Role;
  /** The annotation's durable creator (`author_id`); null for a guest-created annotation. */
  authorId: string | null;
}

export type RestoreAnnotationResult = { ok: true } | { ok: false; reason: "forbidden" };

/**
 * Decide whether the acting user may restore the annotation, and clear the tombstone on allow
 * (S-005 / C-007). SAME authz as delete (C-006):
 *   - restore-OWN: `actorUserId != null && actorUserId === authorId` (the `!= null` guard makes
 *     a guest (null actor) on a guest annotation (null author) NOT match).
 *   - restore-ANY (moderation): `sessionRole === "owner"`, on anyone's annotation.
 * A non-owner non-author is refused; the repo is never written.
 *
 * Idempotent: clearing the tombstone of an ALREADY-active (non-deleted) annotation is a
 * harmless no-op write — restore is the durable undo, so a double-restore (or a restore of a
 * never-deleted row by an authorized actor) succeeds without error rather than failing.
 */
export async function restoreAnnotation(
  input: RestoreAnnotationInput,
  repo: RestoreRepo,
): Promise<RestoreAnnotationResult> {
  const { annotationId, actorUserId, sessionRole, authorId } = input;

  const isOwnerModeration = sessionRole === "owner";
  const isOwnAuthor = actorUserId != null && actorUserId === authorId;

  if (!isOwnerModeration && !isOwnAuthor) {
    return { ok: false, reason: "forbidden" };
  }

  await repo.clearDeletedAt(annotationId);
  return { ok: true };
}
