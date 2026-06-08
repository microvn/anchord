import { test, expect } from "bun:test";
import { Elysia } from "elysia";
import { apiEnvelope } from "./envelope";
import { enforceReadAccess, loadReadableOr404, READ_NOT_FOUND_MESSAGE } from "./access-result";

/**
 * S-004: a READ the caller has no access to see must be byte-identical to a READ of
 * a doc that does not exist. We mount TWO throwaway read-routes through the real
 * envelope (S-001) so the assertions run end-to-end on the wire:
 *
 *   GET /api/denied  → backed by (doc exists = true, allowed = false) — a real,
 *                      restricted "Secret Spec" doc the caller cannot see.
 *   GET /api/missing → backed by (doc = null) — no such doc.
 *
 * Both must come back 404 / NOT_FOUND with the same body shape; only the volatile
 * envelope fields (requestId, timestamp, path) may differ. AS-011: the restricted
 * doc's title + owner appear NOWHERE in the denial body.
 */

// A real, restricted doc the caller is NOT authorized for. Its fields must never
// surface in the denial — they are the leak we are guarding against (AS-011).
const SECRET_DOC = {
  id: "doc_secret_1",
  title: "Secret Spec",
  content: "<h1>Confidential roadmap</h1>",
  ownerId: "user_owner_42",
};

function buildApp() {
  return new Elysia().group("/api", (api) =>
    apiEnvelope(api)
      // exists=true but access denied → must funnel through the choke point as 404.
      .get("/denied", () => enforceReadAccess({ doc: SECRET_DOC, allowed: false }))
      // doc does not exist → 404.
      .get("/missing", () => enforceReadAccess<typeof SECRET_DOC>({ doc: null, allowed: true }))
      // exists=true AND allowed → returns the doc (control: the choke point lets real reads through).
      .get("/ok", () => enforceReadAccess({ doc: SECRET_DOC, allowed: true })),
  );
}

function call(app: ReturnType<typeof buildApp>, path: string) {
  return app.handle(new Request(`http://localhost${path}`));
}

/** Strip the fields the envelope legitimately varies per request, so equality compares
 *  ONLY the parts that must be identical between "denied" and "missing". */
function stableShape(body: any) {
  const { requestId, timestamp, path, ...rest } = body;
  return rest;
}

// ── AS-010 ───────────────────────────────────────────────────────────────────
test("AS-010: a no-access doc returns the same 404 as a missing doc — identical status, code, body shape", async () => {
  const app = buildApp();

  const deniedRes = await call(app, "/api/denied");
  const missingRes = await call(app, "/api/missing");

  // Same HTTP status.
  expect(deniedRes.status).toBe(404);
  expect(missingRes.status).toBe(404);

  const deniedBody = await deniedRes.json();
  const missingBody = await missingRes.json();

  // Same error.code = NOT_FOUND — nothing distinguishes forbidden from absent.
  expect(deniedBody.error.code).toBe("NOT_FOUND");
  expect(missingBody.error.code).toBe("NOT_FOUND");

  // Byte-identical once the volatile per-request fields are excluded:
  // same success flag, same statusCode, same error object (code + message).
  expect(stableShape(deniedBody)).toEqual(stableShape(missingBody));
  expect(deniedBody.error).toEqual(missingBody.error);
  expect(deniedBody.error.message).toBe(READ_NOT_FOUND_MESSAGE);
});

// ── AS-011 ───────────────────────────────────────────────────────────────────
test("AS-011: the no-access denial leaks no content — no title, content, or owner of the real doc appears", async () => {
  const app = buildApp();

  const res = await call(app, "/api/denied");
  expect(res.status).toBe(404);

  // Grep the SERIALIZED body — none of the real doc's fields may appear anywhere.
  const raw = await res.text();
  expect(raw).not.toContain(SECRET_DOC.title); // "Secret Spec"
  expect(raw).not.toContain(SECRET_DOC.ownerId); // "user_owner_42"
  expect(raw).not.toContain(SECRET_DOC.id); // "doc_secret_1"
  expect(raw).not.toContain(SECRET_DOC.content);
  expect(raw).not.toContain("Confidential");

  // And the structured body carries no field of the real doc.
  const body = JSON.parse(raw);
  expect(body.data).toBeUndefined();
  expect(body).not.toHaveProperty("title");
  expect(body).not.toHaveProperty("ownerId");
  expect(body.error).not.toHaveProperty("title");
  expect(body.error).not.toHaveProperty("ownerId");
  expect(body.error).not.toHaveProperty("details");
});

// ── C-006 ────────────────────────────────────────────────────────────────────
test("C-006: a denied read is byte-identical to a missing one and overrides the generic 403 — never a 403 for a read", async () => {
  const app = buildApp();

  const deniedRes = await call(app, "/api/denied");
  const missingRes = await call(app, "/api/missing");

  // The denial is a 404, NOT a 403 — C-006 overrides the generic 403 path for READS.
  expect(deniedRes.status).toBe(404);
  expect(deniedRes.status).not.toBe(403);
  expect(missingRes.status).toBe(404);

  // Headers carry no existence signal either (e.g. no differing content-type / length-driven tell).
  expect(deniedRes.headers.get("content-type")).toBe(missingRes.headers.get("content-type"));

  const deniedBody = await deniedRes.json();
  const missingBody = await missingRes.json();
  expect(deniedBody.error).toEqual(missingBody.error);
  expect(stableShape(deniedBody)).toEqual(stableShape(missingBody));
});

// ── C-006 (choke point lets real reads through) ──────────────────────────────
test("C-006: an existing+allowed read passes through the choke point and returns the doc (not a 404)", async () => {
  const app = buildApp();

  const res = await call(app, "/api/ok");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
  expect(body.data).toEqual(SECRET_DOC);
});

// ── C-006 (unit: both branches throw the SAME error, deny-before-read) ────────
test("C-006: enforceReadAccess throws an identical NOT_FOUND for missing and denied, and never exposes the doc", () => {
  const missingThrow = (() => {
    try {
      enforceReadAccess({ doc: null, allowed: true });
    } catch (e) {
      return e as any;
    }
  })();
  const deniedThrow = (() => {
    try {
      enforceReadAccess({ doc: SECRET_DOC, allowed: false });
    } catch (e) {
      return e as any;
    }
  })();

  // Both threw; both carry the identical code/status/message — the only thing the
  // route ever sees, so neither can leak which case it was.
  expect(missingThrow.code).toBe("NOT_FOUND");
  expect(deniedThrow.code).toBe("NOT_FOUND");
  expect(deniedThrow.status).toBe(404);
  expect(deniedThrow.code).toBe(missingThrow.code);
  expect(deniedThrow.status).toBe(missingThrow.status);
  expect(deniedThrow.message).toBe(missingThrow.message);
  expect(deniedThrow.message).toBe(READ_NOT_FOUND_MESSAGE);

  // The thrown error carries nothing of the real doc.
  const serialized = JSON.stringify({ code: deniedThrow.code, message: deniedThrow.message, details: deniedThrow.details });
  expect(serialized).not.toContain("Secret Spec");
  expect(serialized).not.toContain("user_owner_42");

  // Edge — denied wins even when doc is present (deny-before-read ordering).
  expect(() => enforceReadAccess({ doc: SECRET_DOC, allowed: false })).toThrow();
  // Edge — undefined doc treated same as null.
  expect(() => enforceReadAccess({ doc: undefined, allowed: true })).toThrow();
  // loadReadableOr404 alias is the same choke point.
  expect(() => loadReadableOr404({ doc: null, allowed: true })).toThrow();
  expect(loadReadableOr404({ doc: SECRET_DOC, allowed: true })).toEqual(SECRET_DOC);
});
