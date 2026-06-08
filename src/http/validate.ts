import { Elysia } from "elysia";
import type { z } from "zod";
import { ValidationError } from "./errors";

/**
 * S-005: schema validation at the request boundary for `/api/*` routes.
 *
 * Two guarantees, both enforced BEFORE the handler runs (C-007):
 *   1. Bad input is rejected uniformly: a missing/wrong-typed field → a thrown
 *      `ValidationError` (→400, code VALIDATION_ERROR) carrying field-level
 *      `details` + the first bad `field`. Because the gate runs in a `resolve`
 *      step (before the handler), an invalid request NEVER reaches the underlying
 *      service (AS-012).
 *   2. Unknown fields are stripped, not forwarded: the schema is a plain Zod
 *      object, which strips keys it does not declare. The handler reads the
 *      parsed value (`ctx.validBody`), so a client-sent `isAdmin: true` / `extra`
 *      never reaches the service (AS-013).
 *
 * Composes with `apiEnvelope` (S-001): the thrown `ValidationError` is wrapped by
 * the envelope's onError into the 400 error envelope. Keep this a thin Elysia
 * plugin so routes opt in per-group, like `requireSession` (S-003).
 */

/**
 * Parse `raw` against a Zod object schema with strip semantics (unknown keys
 * removed — Zod's default object behaviour). On failure, throw a
 * `ValidationError` whose `details` lists each issue as a readable
 * `path: message` string and whose `field` is the first bad path.
 *
 * Pure + injectable: the Elysia wrapper below delegates to this so the validation
 * logic is unit-testable without spinning a route.
 */
export function validateBody<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues;
    const details = issues.map((i) => {
      const path = i.path.length > 0 ? i.path.map(String).join(".") : "(root)";
      return `${path}: ${i.message}`;
    });
    // First bad path, dotted; root-level issues report no specific field.
    const firstPath = issues[0]?.path ?? [];
    const field = firstPath.length > 0 ? firstPath.map(String).join(".") : undefined;
    throw new ValidationError("Validation failed", { details, field });
  }
  return result.data;
}

/**
 * Elysia plugin: validate + shape the request body against `schema` BEFORE the
 * handler runs, exposing the parsed (and unknown-stripped) value as
 * `ctx.validBody`.
 *
 * Mounted after `apiEnvelope` so a thrown `ValidationError` is enveloped as 400.
 * Uses `resolve` (a pre-handler step) so an invalid body short-circuits and the
 * handler — and therefore the service it calls — is never reached (AS-012). On
 * success the handler reads ONLY `ctx.validBody`, which carries exactly the
 * schema-defined fields (AS-013).
 */
export function withValidation<S extends z.ZodType>(schema: S) {
  return new Elysia({ name: "validate" }).resolve(
    { as: "scoped" },
    ({ body }): { validBody: z.infer<S> } => {
      return { validBody: validateBody(schema, body) };
    },
  );
}
