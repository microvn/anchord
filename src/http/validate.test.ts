import { test, expect } from "bun:test";
import { Elysia } from "elysia";
import { z } from "zod";
import { apiEnvelope } from "./envelope";
import { withValidation, validateBody } from "./validate";
import { ValidationError } from "./errors";

/**
 * S-005: requests are validated/shaped at the boundary BEFORE the service runs.
 *
 * We mount throwaway /api/* routes (with `apiEnvelope` + `withValidation`) whose
 * schema is `{ title: string }`. A module-level spy records whether the handler
 * ran and what value it received, so we can prove end-to-end that:
 *   - invalid input never reaches the handler (AS-012), surfacing as a 400
 *     VALIDATION_ERROR envelope with field-level `details`;
 *   - unknown fields are stripped before the handler sees them (AS-013).
 *
 * Assertions run through the real envelope onError/onAfterHandle paths so the
 * code→wire mapping is proven, not just the helper shape.
 */

const schema = z.object({ title: z.string() });

type Spy = { invoked: boolean; received: unknown };

function buildApp(spy: Spy) {
  return new Elysia().group("/api", (api) =>
    apiEnvelope(api).group("/things", (g) =>
      g.use(withValidation(schema)).post("/", ({ validBody }) => {
        // The "service" boundary: record that it ran and with what.
        spy.invoked = true;
        spy.received = validBody;
        return { created: true };
      }),
    ),
  );
}

function post(app: ReturnType<typeof buildApp>, body: unknown) {
  return app.handle(
    new Request("http://localhost/api/things", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

// ── AS-012: invalid input is rejected before the service runs ───────────────

test("AS-012: a wrong-typed field → 400 VALIDATION_ERROR with details naming the field; service never invoked", async () => {
  const spy: Spy = { invoked: false, received: undefined };
  const res = await post(buildApp(spy), { title: 123 });

  expect(res.status).toBe(400);
  const json = (await res.json()) as any;
  expect(json.success).toBe(false);
  expect(json.error.code).toBe("VALIDATION_ERROR");
  expect(json.error.field).toBe("title");
  expect(Array.isArray(json.error.details)).toBe(true);
  expect(json.error.details.join(" ")).toContain("title");
  // The underlying service must never have run.
  expect(spy.invoked).toBe(false);
});

test("AS-012: a missing required field → 400 VALIDATION_ERROR; service never invoked", async () => {
  const spy: Spy = { invoked: false, received: undefined };
  const res = await post(buildApp(spy), {});

  expect(res.status).toBe(400);
  const json = (await res.json()) as any;
  expect(json.error.code).toBe("VALIDATION_ERROR");
  expect(json.error.field).toBe("title");
  expect(json.error.details.join(" ")).toContain("title");
  expect(spy.invoked).toBe(false);
});

test("AS-012: null body (empty/invalid input) → 400 VALIDATION_ERROR; service never invoked", async () => {
  // Edge: null/undefined input. A non-object body still rejects at the boundary.
  const spy: Spy = { invoked: false, received: undefined };
  const res = await post(buildApp(spy), null);

  expect(res.status).toBe(400);
  const json = (await res.json()) as any;
  expect(json.error.code).toBe("VALIDATION_ERROR");
  expect(spy.invoked).toBe(false);
});

test("AS-012: validateBody throws ValidationError with details+field, not return, on bad input", () => {
  // Unit-level: the pure helper carries the field path and per-issue messages.
  let thrown: unknown;
  try {
    validateBody(schema, { title: 123 });
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(ValidationError);
  const err = thrown as ValidationError;
  expect(err.code).toBe("VALIDATION_ERROR");
  expect(err.status).toBe(400);
  expect(err.field).toBe("title");
  expect((err.details as string[])[0]).toContain("title");
});

// ── AS-013: unknown fields are stripped, not forwarded ──────────────────────

test("AS-013: extra fields are removed; the service receives only schema-defined fields", async () => {
  const spy: Spy = { invoked: false, received: undefined };
  const res = await post(buildApp(spy), { title: "ok", isAdmin: true, extra: 1 });

  expect(res.status).toBe(200);
  expect(spy.invoked).toBe(true);
  // The handler got EXACTLY { title: "ok" } — no isAdmin, no extra.
  expect(spy.received).toEqual({ title: "ok" });
  expect((spy.received as Record<string, unknown>).isAdmin).toBeUndefined();
  expect((spy.received as Record<string, unknown>).extra).toBeUndefined();
});

test("C-007: validateBody strips unknown keys and returns only schema fields (AS-013)", () => {
  // Unit-level: strip semantics come straight from the plain z.object.
  const out = validateBody(schema, { title: "ok", isAdmin: true, extra: 1 });
  expect(out).toEqual({ title: "ok" });
});
