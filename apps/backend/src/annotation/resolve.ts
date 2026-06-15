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
   * suggestion-type annotation; `undefined` for an ordinary annotation. Reopening
   * (`resolved=false`) a DECIDED suggestion (accepted|rejected) is OWNER-only and ALSO
   * resets `suggestion_status` → pending — distinct from an ordinary reopen, which any
   * commenter may toggle (C-005). A still-pending suggestion reopens via the ordinary path.
   */
  suggestionStatus?: SuggestionStatus;
}

export type SetResolutionResult =
  | { ok: true; status: AnnotationStatus; suggestionStatus?: SuggestionStatus }
  | { ok: false; reason: "forbidden" };

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
  const { annotationId, resolved, sessionRole, suggestionStatus } = input;

  // AS-026 / C-016: reopening a DECIDED suggestion (accepted|rejected) is a DIFFERENT
  // transition from the ordinary resolve toggle — OWNER-only, and it clears the decision
  // (suggestion_status → pending). This guards against a non-owner resurfacing a decided
  // proposal or leaving `status`/`suggestion_status` desynced. A non-owner — even a commenter
  // who could toggle an ordinary thread — is refused here. Only REOPEN is gated this way;
  // resolving the thread (resolved=true) stays the ordinary commenter+ path below.
  const isDecidedSuggestion = suggestionStatus === "accepted" || suggestionStatus === "rejected";
  if (isDecidedSuggestion && !resolved) {
    if (sessionRole !== "owner") {
      return { ok: false, reason: "forbidden" };
    }
    await repo.setAnnotationStatus(annotationId, "unresolved");
    await repo.resetSuggestionStatusToPending(annotationId);
    return { ok: true, status: "unresolved", suggestionStatus: "pending" };
  }

  // C-005: server-side re-authorization. A viewer (or any role lacking "resolve")
  // cannot change the status, no matter what an untrusted client claimed.
  if (!can(sessionRole, "resolve")) {
    return { ok: false, reason: "forbidden" };
  }

  // AS-009: the boolean is the toggle — resolve sets resolved, reopen sets unresolved.
  const status: AnnotationStatus = resolved ? "resolved" : "unresolved";
  await repo.setAnnotationStatus(annotationId, status);
  return { ok: true, status };
}
