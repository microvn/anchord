import { test, expect } from "bun:test";
import { Elysia } from "elysia";
import { apiEnvelope, DomainError, getOrCreateRequestId } from "./envelope";

/**
 * Build a throwaway Elysia app that mirrors the real topology (C-009):
 *  - an /api/* group that applies `apiEnvelope()` (anchord's own routes)
 *  - an /api/auth/* style passthrough that does NOT (better-auth owns its shape)
 * Tests drive it in-process via app.handle(new Request(...)) — no port, no DB.
 */
function buildApp() {
  return new Elysia()
    .group("/api", (api) =>
      apiEnvelope(api)
        .get("/ok", () => ({ hello: "world" }))
        .get("/scalar", () => 42)
        .get("/boom", () => {
          throw new DomainError({ code: "NOT_FOUND", status: 404, message: "missing" });
        })
        .get("/explode", () => {
          throw new Error("kaboom");
        }),
    )
    // better-auth passthrough — EXEMPT from the envelope, returns raw body.
    .all("/api/auth/*", () => new Response(JSON.stringify({ session: "raw" }), {
      headers: { "content-type": "application/json" },
    }));
}

function call(app: ReturnType<typeof buildApp>, path: string, init?: RequestInit) {
  return app.handle(new Request(`http://localhost${path}`, init));
}

// ── AS-001 ───────────────────────────────────────────────────────────────────
test("AS-001 / C-001: a successful handler result is wrapped in the success envelope (handler returns raw, never hand-wraps)", async () => {
  const app = buildApp();
  const res = await call(app, "/api/ok");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
  expect(body.data).toEqual({ hello: "world" }); // raw value the handler returned
  expect(body.statusCode).toBe(200);
  expect(body.path).toBe("/api/ok");
  expect(typeof body.timestamp).toBe("string");
  expect(new Date(body.timestamp).toString()).not.toBe("Invalid Date");
  expect(typeof body.requestId).toBe("string");
  // The envelope itself proves the handler did not hand-wrap: data holds the
  // literal return value, not a pre-built {success,...} shape.
  expect((body.data as any).success).toBeUndefined();
});

test("AS-001: a scalar (non-object) handler return is wrapped intact as data", async () => {
  const app = buildApp();
  const res = await call(app, "/api/scalar");
  const body = await res.json();
  expect(body.success).toBe(true);
  expect(body.data).toBe(42);
});

// ── AS-002 ───────────────────────────────────────────────────────────────────
test("AS-002 / C-001: a thrown DomainError is wrapped in the error envelope with its status; no raw framework error shape leaks", async () => {
  const app = buildApp();
  const res = await call(app, "/api/boom");
  expect(res.status).toBe(404); // status taken from the DomainError
  const body = await res.json();
  expect(body.success).toBe(false);
  expect(body.error).toEqual({ code: "NOT_FOUND", message: "missing" });
  expect(body.statusCode).toBe(404);
  expect(body.path).toBe("/api/boom");
  expect(typeof body.timestamp).toBe("string");
  expect(typeof body.requestId).toBe("string");
  // No Elysia/native error shape leaking through.
  expect(body).not.toHaveProperty("name");
  expect(body).not.toHaveProperty("stack");
});

test("AS-002: an unknown (non-domain) throw is wrapped as a 500 error envelope without leaking the message/stack", async () => {
  const app = buildApp();
  const res = await call(app, "/api/explode");
  expect(res.status).toBe(500);
  const body = await res.json();
  expect(body.success).toBe(false);
  expect(body.statusCode).toBe(500);
  expect(body.error.code).toBe("INTERNAL");
  // Internal failure text is not exposed verbatim.
  expect(body.error.message).not.toBe("kaboom");
  expect(body).not.toHaveProperty("stack");
});

// ── AS-003 / C-002 ─────────────────────────────────────────────────────────────
test("AS-003 / C-002: requestId is echoed from x-request-id when the client supplies one (success path)", async () => {
  const app = buildApp();
  const res = await call(app, "/api/ok", { headers: { "x-request-id": "req_abc" } });
  const body = await res.json();
  expect(body.requestId).toBe("req_abc");
  // ideally echoed as a response header too
  expect(res.headers.get("x-request-id")).toBe("req_abc");
});

test("AS-003 / C-002: a fresh requestId (req_ prefix) is generated and returned when no x-request-id is supplied", async () => {
  const app = buildApp();
  const res = await call(app, "/api/ok");
  const body = await res.json();
  expect(body.requestId).toMatch(/^req_/);
  expect(body.requestId.length).toBeGreaterThan("req_".length);
});

test("AS-003 / C-002: every response carries a requestId on the error path too (echoed when supplied)", async () => {
  const app = buildApp();
  const res = await call(app, "/api/boom", { headers: { "x-request-id": "req_err" } });
  const body = await res.json();
  expect(body.success).toBe(false);
  expect(body.requestId).toBe("req_err");
});

test("AS-003 / C-002: getOrCreateRequestId echoes a supplied id and generates a req_ id otherwise", () => {
  expect(getOrCreateRequestId(new Headers({ "x-request-id": "req_xyz" }))).toBe("req_xyz");
  const gen = getOrCreateRequestId(new Headers());
  expect(gen).toMatch(/^req_/);
  expect(gen).not.toBe("req_");
});

// ── C-009 ─────────────────────────────────────────────────────────────────────
test("C-009: the envelope wraps anchord's own /api/* route but a /api/auth/* passthrough returns its raw body untouched (better-auth + /mcp are EXEMPT)", async () => {
  const app = buildApp();

  // own /api/* route → wrapped
  const own = await call(app, "/api/ok");
  const ownBody = await own.json();
  expect(ownBody).toHaveProperty("success", true);
  expect(ownBody).toHaveProperty("data");

  // /api/auth/* passthrough → NOT wrapped, raw better-auth shape preserved
  const auth = await call(app, "/api/auth/session");
  const authBody = await auth.json();
  expect(authBody).toEqual({ session: "raw" });
  expect(authBody).not.toHaveProperty("success");
  expect(authBody).not.toHaveProperty("data");
});
