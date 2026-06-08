// S-002 / C-002: the ONE place a failed backend call becomes a consistent, typed error.
//
// Eden's treaty resolves every call to `{ data, error, status }`. On a non-2xx response
// `error` is `{ status, value }` where `value` is the parsed JSON body — for anchord that
// is the api-core envelope `{ success: false, error: { code, message } }`. On a transport
// failure (backend unreachable) treaty yields a non-numeric status (e.g. "FETCH_ERROR") or
// throws. `toApiError` normalizes ALL of these into one `ApiError` so every screen renders
// the same retryable surface and the session layer has a single flag to key off.

const GENERIC_MESSAGE = "Something went wrong. Please try again.";

// The shape treaty hands us in its `error` slot — kept loose because the transport-error
// case carries a string status and no envelope body.
export type EdenError = {
  status?: number | string;
  value?: unknown;
} | null;

/** The single error type every screen sees. `isUnauthenticated` drives the sign-in bounce. */
export class ApiError extends Error {
  readonly code: string | null;
  readonly status: number | null;
  readonly isUnauthenticated: boolean;

  constructor(opts: {
    message: string;
    code: string | null;
    status: number | null;
    isUnauthenticated: boolean;
  }) {
    super(opts.message);
    this.name = "ApiError";
    this.code = opts.code;
    this.status = opts.status;
    this.isUnauthenticated = opts.isUnauthenticated;
  }
}

function envelopeError(value: unknown): { code: string | null; message: string | null } {
  // Defensive: the body may be the api-core envelope, a bare object, or junk.
  if (value && typeof value === "object" && "error" in value) {
    const inner = (value as { error?: unknown }).error;
    if (inner && typeof inner === "object") {
      const code = "code" in inner ? (inner as { code?: unknown }).code : undefined;
      const message =
        "message" in inner ? (inner as { message?: unknown }).message : undefined;
      return {
        code: typeof code === "string" ? code : null,
        message: typeof message === "string" ? message : null,
      };
    }
  }
  return { code: null, message: null };
}

/**
 * Normalize anything treaty (or a thrown fetch) produces into one `ApiError`.
 * - 401 OR an `UNAUTHENTICATED` envelope code → `isUnauthenticated: true` (AS-008).
 * - any other error → a consistent ApiError carrying the envelope message when present,
 *   else a generic fallback so a screen never shows a blank/empty error (AS-007, edge).
 */
export function toApiError(error: EdenError | unknown): ApiError {
  // A real thrown Error (e.g. treaty re-threw a transport failure).
  if (error instanceof ApiError) return error;
  if (error instanceof Error && !("value" in error)) {
    return new ApiError({
      message: error.message || GENERIC_MESSAGE,
      code: null,
      status: null,
      isUnauthenticated: false,
    });
  }

  const e = (error ?? {}) as EdenError;
  const status = typeof e?.status === "number" ? e.status : null;
  const { code, message } = envelopeError(e?.value);
  const isUnauthenticated = status === 401 || code === "UNAUTHENTICATED";

  return new ApiError({
    message: message && message.trim() ? message : GENERIC_MESSAGE,
    code,
    status,
    isUnauthenticated,
  });
}

export { GENERIC_MESSAGE };
