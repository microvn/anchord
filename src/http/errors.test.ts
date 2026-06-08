import { test, expect } from "bun:test";
import { Elysia } from "elysia";
import { apiEnvelope, DomainError } from "./envelope";
import {
  ERROR_STATUS,
  ValidationError,
  UnauthenticatedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  PayloadTooLargeError,
  RateLimitedError,
} from "./errors";

/**
 * S-002: domain errors surface the correct HTTP status. We mount throwaway
 * /api/* routes (with `apiEnvelope`) whose handlers throw each error class, then
 * assert the wire status + error.code + (for validation) field-level details,
 * and that an unexpected throw becomes a generic 500 that leaks nothing.
 *
 * All assertions go through the real envelope onError path (S-001) so we prove
 * the class→status mapping end-to-end, not just the class shape.
 */
function buildApp() {
  return new Elysia().group("/api", (api) =>
    apiEnvelope(api)
      .get("/validation", () => {
        throw new ValidationError("invalid input", {
          details: [{ field: "slug", message: "required" }],
          field: "slug",
        });
      })
      .get("/unauth", () => {
        throw new UnauthenticatedError();
      })
      .get("/forbidden", () => {
        throw new ForbiddenError();
      })
      .get("/notfound", () => {
        throw new NotFoundError();
      })
      .get("/conflict", () => {
        throw new ConflictError("duplicate slug");
      })
      .get("/toolarge", () => {
        throw new PayloadTooLargeError();
      })
      .get("/ratelimited", () => {
        throw new RateLimitedError();
      })
      // Unmapped, non-DomainError throw carrying internal detail (AS-006/C-004).
      .get("/leak", () => {
        throw new Error("connection to postgres://user:pw@db:5432/anchord failed at /src/db/pool.ts:42");
      }),
  );
}

function call(app: ReturnType<typeof buildApp>, path: string) {
  return app.handle(new Request(`http://localhost${path}`));
}

// ── AS-004 ───────────────────────────────────────────────────────────────────
test("AS-004: a validation failure surfaces as 400, error.code=VALIDATION_ERROR, with field-level details", async () => {
  const app = buildApp();
  const res = await call(app, "/api/validation");
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.success).toBe(false);
  expect(body.statusCode).toBe(400);
  expect(body.error.code).toBe("VALIDATION_ERROR");
  expect(body.error.details).toEqual([{ field: "slug", message: "required" }]);
  expect(body.error.field).toBe("slug");
});

// ── AS-005 ───────────────────────────────────────────────────────────────────
test("AS-005: a conflict surfaces as 409 with error.code=CONFLICT", async () => {
  const app = buildApp();
  const res = await call(app, "/api/conflict");
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.success).toBe(false);
  expect(body.statusCode).toBe(409);
  expect(body.error.code).toBe("CONFLICT");
  expect(body.error.message).toBe("duplicate slug");
});

// ── AS-006 ───────────────────────────────────────────────────────────────────
test("AS-006: an unexpected (non-DomainError) error surfaces as 500 with a generic INTERNAL code/message", async () => {
  const app = buildApp();
  const res = await call(app, "/api/leak");
  expect(res.status).toBe(500);
  const body = await res.json();
  expect(body.success).toBe(false);
  expect(body.statusCode).toBe(500);
  expect(body.error.code).toBe("INTERNAL");
  // A generic, user-safe message — not the raw thrown text.
  expect(typeof body.error.message).toBe("string");
  expect(body.error.message).not.toContain("postgres");
});

// ── C-003 (the full code→status table is the single source of truth) ───────────
test("C-003: the ERROR_STATUS table maps every code to its fixed status (400/401/403/404/409/413/429/500)", () => {
  expect(ERROR_STATUS).toEqual({
    VALIDATION_ERROR: 400,
    UNAUTHENTICATED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    PAYLOAD_TOO_LARGE: 413,
    RATE_LIMITED: 429,
    INTERNAL: 500,
  });
});

test("C-003: each named domain error class derives its code+status from the table (no drift)", () => {
  const cases: Array<[DomainError, string, number]> = [
    [new ValidationError("x"), "VALIDATION_ERROR", 400],
    [new UnauthenticatedError(), "UNAUTHENTICATED", 401],
    [new ForbiddenError(), "FORBIDDEN", 403],
    [new NotFoundError(), "NOT_FOUND", 404],
    [new ConflictError(), "CONFLICT", 409],
    [new PayloadTooLargeError(), "PAYLOAD_TOO_LARGE", 413],
    [new RateLimitedError(), "RATE_LIMITED", 429],
  ];
  for (const [err, code, status] of cases) {
    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(status).toBe(ERROR_STATUS[err.code as keyof typeof ERROR_STATUS]);
  }
});

test("C-003: each class, when thrown from a route, produces a response carrying its mapped status+code through the envelope", async () => {
  const app = buildApp();
  const expectations: Array<[string, 400 | 401 | 403 | 404 | 409 | 413 | 429, string]> = [
    ["/api/validation", 400, "VALIDATION_ERROR"],
    ["/api/unauth", 401, "UNAUTHENTICATED"],
    ["/api/forbidden", 403, "FORBIDDEN"],
    ["/api/notfound", 404, "NOT_FOUND"],
    ["/api/conflict", 409, "CONFLICT"],
    ["/api/toolarge", 413, "PAYLOAD_TOO_LARGE"],
    ["/api/ratelimited", 429, "RATE_LIMITED"],
  ];
  for (const [path, status, code] of expectations) {
    const res = await call(app, path);
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.statusCode).toBe(status);
    expect(body.error.code).toBe(code);
  }
});

// ── C-004 (no-leak) ────────────────────────────────────────────────────────────
test("C-004: a 500/INTERNAL response body never leaks internals (raw message, postgres, SQL, file path, stack)", async () => {
  const app = buildApp();
  const res = await call(app, "/api/leak");
  expect(res.status).toBe(500);
  const raw = await res.text();
  // Grep the SERIALIZED body for any leaked substring — none may appear.
  expect(raw).not.toContain("postgres://");
  expect(raw).not.toContain("postgres");
  expect(raw).not.toContain("5432");
  expect(raw).not.toContain("pool.ts");
  expect(raw).not.toContain("/src/db/");
  expect(raw.toLowerCase()).not.toContain("stack");
  expect(raw).not.toContain("connection to");
  // And the structured body confirms the generic envelope shape only.
  const body = JSON.parse(raw);
  expect(body.error.code).toBe("INTERNAL");
  expect(body).not.toHaveProperty("stack");
  expect(body.error).not.toHaveProperty("stack");
});
