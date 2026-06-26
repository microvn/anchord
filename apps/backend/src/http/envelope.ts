import { Elysia } from "elysia";

/**
 * Unified response envelope for anchord's OWN /api/* routes (S-001).
 *
 * Every success or error from an enveloped route comes back in exactly one of
 * two shapes. Handlers return RAW data and throw RAW errors — they never
 * hand-wrap. The `apiEnvelope()` plugin does the wrapping (success via
 * onAfterHandle, errors via onError) so the shape is uniform and impossible to
 * forget.
 *
 * EXEMPT (C-009): /api/auth/* (better-auth owns its protocol) and /mcp (native
 * MCP transport). The envelope only applies where `apiEnvelope()` is mounted.
 */

export type SuccessEnvelope<T> = {
  success: true;
  data: T;
  timestamp: string;
  path: string;
  statusCode: number;
  requestId: string;
};

export type ErrorEnvelope = {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    field?: string;
    /**
     * project-visibility S-005 / C-009: an OPTIONAL, STABLE machine-readable discriminator
     * that distinguishes one occurrence of a generic `code` (e.g. CONFLICT) from another, so
     * the client branches on `reason`, never on the HTTP status or the human message text.
     * Only present when the thrown error sets it (e.g. `reason: "visibility_boundary"` on the
     * boundary-crossing move refusal); absent for every other conflict — backward-compatible.
     */
    reason?: string;
  };
  timestamp: string;
  path: string;
  statusCode: number;
  requestId: string;
};

/**
 * Base class for anchord domain errors. Carries an app-level `code`, the HTTP
 * `status` to respond with, a user-safe `message`, and optional `details`/`field`.
 * S-002 extends the code→status mapping; here we keep the shape plus enough to
 * throw a basic one (e.g. NOT_FOUND / 404).
 */
export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  readonly field?: string;
  /**
   * project-visibility S-005 / C-009: optional stable discriminator surfaced in the error
   * envelope so a client can tell one occurrence of a shared `code` apart from another.
   */
  readonly reason?: string;

  constructor(args: {
    code: string;
    status: number;
    message: string;
    details?: unknown;
    field?: string;
    reason?: string;
  }) {
    super(args.message);
    this.name = "DomainError";
    this.code = args.code;
    this.status = args.status;
    this.details = args.details;
    this.field = args.field;
    this.reason = args.reason;
  }
}

/**
 * Read `x-request-id` from the incoming headers, else generate a fresh one.
 * No `nanoid` dependency — `crypto.randomUUID()` is built into Bun (C-002).
 */
export function getOrCreateRequestId(headers: Headers): string {
  return headers.get("x-request-id") || `req_${crypto.randomUUID()}`;
}

/**
 * True when `v` is already a SuccessEnvelope shape — used by onAfterHandle to avoid
 * double-wrapping when multiple enveloped groups share one parent app (their scoped
 * hooks otherwise compound). Checks the discriminant fields, not just `success`.
 */
function isSuccessEnvelope(v: unknown): v is SuccessEnvelope<unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { success?: unknown }).success === true &&
    "data" in v &&
    "requestId" in v &&
    "statusCode" in v
  );
}

/**
 * Apply the unified envelope to an Elysia route group/app.
 *
 * Usage:
 *   new Elysia().group("/api", (api) => apiEnvelope(api).get("/x", () => raw))
 *
 * - onAfterHandle wraps a successful handler return in SuccessEnvelope (C-001).
 * - onError maps a thrown error to ErrorEnvelope: DomainError → its `status`,
 *   anything else → 500 INTERNAL with no message/stack leak (AS-002).
 * - Both paths read/generate a requestId and echo it as an `x-request-id`
 *   response header (C-002).
 *
 * S-002 (error→status map), S-003 (auth gate), S-005 (validation) plug into this
 * same plugin — keep it composable.
 */
export function apiEnvelope<T extends Elysia<any, any, any, any, any, any>>(app: T): T {
  return app
    .onAfterHandle({ as: "scoped" }, ({ request, path, set, response }) => {
      // A handler that already produced a raw Response (e.g. a stream or file)
      // is left untouched — only plain JSON-able returns get wrapped.
      if (response instanceof Response) return response;

      // Idempotency guard: when several enveloped route groups are `.use`d into one
      // app, each group's `{as:"scoped"}` onAfterHandle propagates to the shared
      // parent and would re-wrap a sibling group's already-enveloped return,
      // producing nested {success,data:{success,data:...}}. A value that is already a
      // SuccessEnvelope is passed through unchanged so the envelope is applied exactly
      // once regardless of how many enveloped groups share the parent.
      if (isSuccessEnvelope(response)) return response;

      const requestId = getOrCreateRequestId(request.headers);
      const statusCode = typeof set.status === "number" ? set.status : 200;
      set.headers["x-request-id"] = requestId;

      const envelope: SuccessEnvelope<unknown> = {
        success: true,
        data: response,
        timestamp: new Date().toISOString(),
        path,
        statusCode,
        requestId,
      };
      return envelope;
    })
    .onError({ as: "scoped" }, ({ request, path, set, error, code: elysiaCode }) => {
      const requestId = getOrCreateRequestId(request.headers);
      set.headers["x-request-id"] = requestId;

      let statusCode = 500;
      let code = "INTERNAL";
      let message = "Internal server error";
      let details: unknown;
      let field: string | undefined;
      let reason: string | undefined;

      if (error instanceof DomainError) {
        statusCode = error.status;
        code = error.code;
        message = error.message;
        details = error.details;
        field = error.field;
        reason = error.reason;
      } else if (elysiaCode === "NOT_FOUND") {
        // Elysia's BUILT-IN NotFoundError (an unmatched route) is NOT our DomainError, so it
        // would otherwise fall through to INTERNAL 500 — masking a route mismatch as a server
        // crash (this is exactly what hid the FE/BE comment-path mismatch). Map it to a clean 404.
        statusCode = 404;
        code = "NOT_FOUND";
        message = "Not found";
      } else if (elysiaCode === "VALIDATION" || elysiaCode === "PARSE") {
        // Elysia's own request validation/parse failures → 400 (our handlers use ValidationError,
        // a DomainError, for domain validation; this catches the framework-level ones).
        statusCode = 400;
        code = "VALIDATION_ERROR";
        message = "Invalid request";
      } else {
        // A genuinely UNEXPECTED error → 500. The client envelope below deliberately leaks no
        // message/stack (AS-002), but a silent 500 with no server-side trace is an ops blackhole —
        // ALWAYS log the real error + stack to stderr, keyed by requestId so it correlates with
        // the response the caller saw.
        console.error(`[api] 500 INTERNAL ${request.method} ${path} req=${requestId}\n`, error);
      }

      set.status = statusCode;

      const envelope: ErrorEnvelope = {
        success: false,
        error: {
          code,
          message,
          ...(details !== undefined ? { details } : {}),
          ...(field !== undefined ? { field } : {}),
          ...(reason !== undefined ? { reason } : {}),
        },
        timestamp: new Date().toISOString(),
        path,
        statusCode,
        requestId,
      };
      return envelope;
    }) as unknown as T;
}
