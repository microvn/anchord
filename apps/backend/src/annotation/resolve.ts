// Resolve / reopen an annotation (annotation-core S-004). Pure authz + idempotent
// status toggle + an injectable ResolutionRepo port, mirroring annotation.ts
// (AnnotationRepo) and reply.ts (CommentRepo). The mark dim/undim on the highlight is
// FRONTEND/integration [→MANUAL]; this module owns the SERVER-side authorization
// (reusing can(role,"resolve") — the shared capability contract) and the status toggle.
//
// C-005: resolve is a toggle; anyone with comment permission OR HIGHER can resolve or
//        reopen — NOT limited to the annotation's creator (AS-010). The capability
//        matrix already grants "resolve" to commenter/editor/owner and withholds it
//        from viewer (sharing/roles.ts), so authz here is a single can() check.

import { can, type Role } from "../sharing/roles";
import type { SuggestionStatus } from "./suggestion";

/** An annotation's resolution status, mirroring the `annotations.status` enum. */
export type AnnotationStatus = "unresolved" | "resolved";

/**
 * Persistence port — the real implementation is thin Drizzle glue
 * (integration-verified-later). Keeping it a port makes the authz + toggle logic
 * unit-testable without a DB, the project's established pattern (AnnotationRepo /
 * CommentRepo). Setting the status to its current value is a harmless idempotent write,
 * so no separate read is needed.
 */
export interface ResolutionRepo {
  setAnnotationStatus(annotationId: string, status: AnnotationStatus): Promise<void>;
  /**
   * S-006 / AS-026 / C-016: clear a DECIDED suggestion's decision by resetting its
   * `suggestion_status` back to `pending`. Reached ONLY on the owner-gated decided-suggestion
   * reopen path — an ordinary resolve/reopen never calls this.
   */
  resetSuggestionStatusToPending(annotationId: string): Promise<void>;
}

export interface SetResolutionInput {
  annotationId: string;
  /** true → resolve (status=resolved); false → reopen (status=unresolved). */
  resolved: boolean;
  /**
   * The role resolved SERVER-side from the session. This — and ONLY this — authorizes
   * the toggle (mirrors S-001 create / S-003 reply). Crucially there is NO creator/author
   * field: the actor's relationship to the annotation's creator is irrelevant; only the
   * role matters (AS-010), so the "only the creator can resolve" mistake is structurally
   * impossible here.
   */
  sessionRole: Role;
  /**
   * S-006 / AS-026 / C-016: the suggestion lifecycle of this annotation WHEN it is a
   * suggestion-type annotation; `undefined` for an ordinary annotation. A DECIDED suggestion
   * (accepted|rejected) that is REOPENED ALSO resets `suggestion_status` → pending (the
   * owner-only decision-reset path). The status no longer DECIDES proposal-vs-remark
   * authority — that is `isProposal` (a pending proposal carries status `"pending"`, not
   * `undefined`, so status would mis-classify it). Status only drives the reset-on-reopen.
   */
  suggestionStatus?: SuggestionStatus;
  /**
   * annotation-actions S-002 / C-001 / C-003: TRUE when this annotation is a PROPOSAL — it
   * has a suggestion payload (Redline/Suggest), in ANY state (pending | accepted | rejected
   * | stale). Derived from suggestion PRESENCE, never from the status value: a pending
   * proposal has a suggestion (status `"pending"`), a remark has none. A proposal's
   * close/resolve/reopen is OWNER-only in EVERY state (C-003) — a non-owner (even a
   * commenter/editor) is refused; they may still reply (the reply route is separate). A
   * Remark (`isProposal` false/omitted) keeps the ordinary `can(role,"resolve")` path
   * (C-002, commenter+). When omitted, falls back to "a suggestionStatus was supplied" so
   * existing decided-reopen callers stay correct.
   */
  isProposal?: boolean;
  /**
   * annotation-actions S-005 / C-007: true when this annotation has been soft-deleted
   * (`deleted_at` set). A soft-delete is TERMINAL — resolve/reopen on a deleted annotation
   * is refused so a concurrent delete + resolve can never leave it both deleted AND mutated.
   * Refused as `not_found` (existence-hiding: a deleted annotation reads as gone), checked
   * BEFORE any authz/toggle so the repo is never written.
   */
  deleted?: boolean;
}

export type SetResolutionResult =
  | { ok: true; status: AnnotationStatus; suggestionStatus?: SuggestionStatus }
  | { ok: false; reason: "forbidden" }
  // S-005 / C-007: the annotation is soft-deleted — terminal, reads as gone (route → 404).
  | { ok: false; reason: "not_found" };

/**
 * Resolve or reopen an annotation (S-004).
 *
 * Authz (C-005): gated SOLELY by `can(sessionRole, "resolve")` — viewer is forbidden;
 * commenter/editor/owner are allowed. Not limited to the creator (AS-010). A forbidden
 * actor leaves the status untouched: the repo is never written.
 *
 * Toggle (AS-009): `resolved` maps directly to the target status, so resolve → reopen →
 * resolve flips cleanly each call. The write is idempotent — resolving an already-resolved
 * annotation just re-sets the same status and returns it.
 *
 * Returns the new status on success.
 */
export async function setResolution(
  input: SetResolutionInput,
  repo: ResolutionRepo,
): Promise<SetResolutionResult> {
  const { annotationId, resolved, sessionRole, suggestionStatus, deleted } = input;

  // S-005 / C-007 (AS-015): a soft-deleted annotation is TERMINAL — refuse resolve/reopen
  // BEFORE any authz or toggle so a concurrent delete + resolve can't desync. Reads as gone
  // (not_found), consistent with existence-hiding; the repo is never written.
  if (deleted) {
    return { ok: false, reason: "not_found" };
  }

  // annotation-actions S-002 / C-001 / C-003: proposal-vs-remark is decided by suggestion
  // PRESENCE, not by the status value — a PENDING proposal has a suggestion (status
  // `"pending"`), so keying off the status would let it fall through to the commenter
  // `resolve` capability (the F-3 hole). Explicit `isProposal` is authoritative; when a
  // caller omits it we fall back to "a suggestionStatus was supplied", so the existing
  // decided-reopen unit callers stay correct.
  const isProposal = input.isProposal ?? suggestionStatus !== undefined;

  // S-002 / C-003: a PROPOSAL's close/resolve/reopen is OWNER-only in EVERY state (pending,
  // accepted, rejected, stale). A non-owner — even a commenter/editor with the `resolve`
  // capability — cannot close someone's proposal; only the owner decides (Accept/Reject is the
  // proposal's close). Reply stays orthogonal (a different route). This gate REPLACES the old
  // decided-only special-case: the pending proposal no longer falls through to `can(...)`.
  if (isProposal) {
    if (sessionRole !== "owner") {
      return { ok: false, reason: "forbidden" };
    }
    // AS-026 / C-016: an owner REOPENING a DECIDED proposal (accepted|rejected) ALSO clears the
    // decision (suggestion_status → pending), so `status` and `suggestion_status` never desync.
    const isDecided = suggestionStatus === "accepted" || suggestionStatus === "rejected";
    if (isDecided && !resolved) {
      await repo.setAnnotationStatus(annotationId, "unresolved");
      await repo.resetSuggestionStatusToPending(annotationId);
      return { ok: true, status: "unresolved", suggestionStatus: "pending" };
    }
    // Owner resolving/closing a proposal (or reopening a still-pending one): ordinary toggle,
    // no decision to reset (S-003/AS-006 — the owner closes their own proposal by Resolve).
    const status: AnnotationStatus = resolved ? "resolved" : "unresolved";
    await repo.setAnnotationStatus(annotationId, status);
    return { ok: true, status };
  }

  // C-002 / C-005: server-side re-authorization for a REMARK. A viewer (or any role lacking
  // "resolve") cannot change the status, no matter what an untrusted client claimed; a
  // commenter+ may resolve/reopen a remark (NOT author-gated).
  if (!can(sessionRole, "resolve")) {
    return { ok: false, reason: "forbidden" };
  }

  // AS-009: the boolean is the toggle — resolve sets resolved, reopen sets unresolved.
  const status: AnnotationStatus = resolved ? "resolved" : "unresolved";
  await repo.setAnnotationStatus(annotationId, status);
  return { ok: true, status };
}
