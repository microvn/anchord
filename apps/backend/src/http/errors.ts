import { DomainError } from "./envelope";

/**
 * S-002: the error-code→HTTP-status table, as the SINGLE source of truth.
 *
 * The envelope (S-001) already maps a thrown `DomainError` → its own `.status`
 * and an unknown throw → 500/INTERNAL with a generic message (no leak). This
 * module formalizes the full code→status table here, and derives every named
 * error class from it — so a class can never carry a status that disagrees with
 * the table (C-003: no drift).
 *
 * INTERNAL(500) is the fallback the envelope applies to any non-DomainError
 * throw; it lives in the table for completeness but has no thrown class — you do
 * not `throw new InternalError()`, you just let an unexpected error bubble and
 * the envelope generalizes it (C-004: never leak the original).
 */
export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  // doc-delete-trash S-004 / C-009: a doc that EXISTED but was soft-deleted, surfaced ONLY
  // to a viewer who had prior access (existence-hiding holds for everyone else — they get
  // NOT_FOUND). 410 GONE is the honest HTTP semantic for a once-present, now-removed resource.
  DOC_DELETED: 410,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/**
 * Build a concrete DomainError subclass for one `code`, deriving its `status`
 * from {@link ERROR_STATUS}. The status is NOT passed in — it is looked up — so
 * the table stays the only place a code's status is defined.
 */
function defineError(code: Exclude<ErrorCode, "INTERNAL">, defaultMessage: string) {
  const status = ERROR_STATUS[code];
  return class extends DomainError {
    constructor(message: string = defaultMessage, opts?: { details?: unknown; field?: string }) {
      super({ code, status, message, details: opts?.details, field: opts?.field });
      this.name = code;
    }
  };
}

/** 400 — input failed validation; carries field-level `details`/`field` (AS-004). */
export class ValidationError extends defineError("VALIDATION_ERROR", "Validation failed") {}
/** 401 — no/invalid session; the caller is not authenticated. */
export class UnauthenticatedError extends defineError("UNAUTHENTICATED", "Authentication required") {}
/** 403 — authenticated but lacks the capability for the action. */
export class ForbiddenError extends defineError("FORBIDDEN", "Forbidden") {}
/** 404 — resource does not exist (or is hidden as if it does not). */
export class NotFoundError extends defineError("NOT_FOUND", "Not found") {}
/**
 * 410 — a doc that EXISTED but was soft-deleted into Trash (doc-delete-trash S-004 / C-009).
 * Thrown ONLY for a viewer who would have had access before the delete; everyone else gets
 * the standard {@link NotFoundError} (existence-hiding — no enumeration oracle, AS-015).
 */
export class DocDeletedError extends defineError("DOC_DELETED", "This doc was deleted") {}
/** 409 — violates a uniqueness/state rule, e.g. a duplicate slug (AS-005). */
export class ConflictError extends defineError("CONFLICT", "Conflict") {}
/** 413 — the request body exceeds the allowed size. */
export class PayloadTooLargeError extends defineError("PAYLOAD_TOO_LARGE", "Payload too large") {}
/** 429 — the caller has exceeded a rate limit. */
export class RateLimitedError extends defineError("RATE_LIMITED", "Rate limited") {}
