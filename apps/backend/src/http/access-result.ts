// S-004: Access denial is indistinguishable from non-existence.
//
// SECURITY invariant (sharing C-003 / annotation C-010, this spec C-006): a READ
// the caller has no access to see must be byte-identical to a READ of a doc that
// does not exist. Both → 404 NOT_FOUND, same code, same generic message, same body
// shape. Nothing — not a different status, not a different message, not a stray
// field of the real doc — may distinguish "exists but forbidden" from "missing".
// Otherwise the 404-vs-403 (or a leaked title/owner) is itself an existence oracle.
//
// This module is the SINGLE choke point read-routes funnel through. A route MUST
// NOT hand-roll a 403 for a READ: 403 (ForbiddenError, S-003) is for an ACTION on a
// VISIBLE resource the caller's role can't perform; a READ the caller can't see at
// all is a 404 here. Keep them separate — never throw ForbiddenError for a read miss.
//
// Usage in a read-route:
//   const doc = await repo.findDoc(slug);                 // null if missing
//   const access = await resolveAccess(doc.id, viewer);   // the single authoritative gate
//   const readable = enforceReadAccess({ doc, allowed: access.canView });
//   // ^ throws NotFoundError (404/NOT_FOUND) for BOTH missing AND denied;
//   //   returns the doc only when it exists AND access is allowed.

import { NotFoundError } from "./errors";

/**
 * The single generic message used for BOTH the missing and the denied case.
 * It is deliberately identical and content-free so the two responses are
 * byte-identical and nothing of the real doc leaks (AS-011). Do not branch this
 * message on whether the doc exists — that branch would itself be the leak.
 */
export const READ_NOT_FOUND_MESSAGE = "Not found";

export interface EnforceReadAccessArgs<T> {
  /** The doc lookup result: the doc object, or null/undefined if it does not exist. */
  doc: T | null | undefined;
  /** The access decision for this caller (e.g. `resolveAccess(...).canView`). */
  allowed: boolean;
}

/**
 * Enforce read access at the one choke point.
 *
 * - doc missing (null/undefined) OR access denied (`allowed === false`) → BOTH
 *   throw the SAME {@link NotFoundError} (404, NOT_FOUND) with the identical
 *   generic {@link READ_NOT_FOUND_MESSAGE}. The two throws are indistinguishable:
 *   same status, same code, same message — and carry NO field of the real doc, so
 *   a denied read leaks neither existence nor content (C-006, AS-010, AS-011).
 * - doc present AND allowed → return the (non-null) doc, narrowed to `T`.
 *
 * The denial branch is taken BEFORE the doc is read, so a forbidden doc's title /
 * content / owner never reaches the error — the caller cannot smuggle it into the
 * 404 even by accident.
 */
export function enforceReadAccess<T>(args: EnforceReadAccessArgs<T>): T {
  const { doc, allowed } = args;

  // Order matters for the invariant: deny BEFORE touching the doc. Both the
  // "missing" and the "denied" path produce the exact same error instance shape.
  if (doc === null || doc === undefined || !allowed) {
    throw new NotFoundError(READ_NOT_FOUND_MESSAGE);
  }

  return doc;
}

/**
 * Alias matching the S-004 design naming. Identical semantics to
 * {@link enforceReadAccess} — read-routes may call whichever name reads better at
 * the call site. Both funnel through the same choke point, so neither can drift.
 */
export function loadReadableOr404<T>(args: EnforceReadAccessArgs<T>): T {
  return enforceReadAccess(args);
}
