// HTTP route mount for the render-publish cluster (story S-001).
//
// This is INTEGRATION GLUE: it wires the already-built, already-unit-tested
// publish service (src/publish/service.ts) onto an Elysia route, composing the
// api-core HTTP layer (envelope + auth gate + Zod validation) per the
// render-publish `## API` contract. No new publish behaviour lives here — the
// route parses the body, calls publishDoc, and maps the service's PublishRejected
// onto the right DomainError (400 / 413) so the envelope can shape the response.
//
// Contract (render-publish ## API):
//   POST /api/docs — auth: session (member). Request: { content, kind?, title? }
//   (multipart file upload is deferred to a later build — see note below).
//   Success: 201 { docId, slug, url }.
//   Errors:  400 VALIDATION_ERROR (empty AS-014; type mismatch AS-005),
//            413 PAYLOAD_TOO_LARGE (over-cap AS-004).

import { Elysia } from "elysia";
import { z } from "zod";
import { apiEnvelope } from "../http/envelope";
import { requireSession, type SessionResolver } from "../http/auth-gate";
import { withValidation } from "../http/validate";
import { ValidationError, PayloadTooLargeError } from "../http/errors";
import { publishDoc, PublishRejected, type DocRepo } from "../publish/service";
import { createDocRepo } from "../publish/repo";
import type { DB } from "../db/client";

/**
 * Body schema for the JSON publish variant (the `{ content, kind?, title? }` half
 * of the contract). `content` is the raw artifact text; `kind`/`title` are the
 * author's declarations. Unknown keys are stripped by Zod (a forged field never
 * reaches the service — api-core AS-013). Emptiness/type guards stay in the
 * service (sniff/size); this schema only enforces SHAPE, so AS-014 (empty) still
 * surfaces as the service's PublishRejected → 400, not a schema error.
 *
 * Multipart file upload (the `multipart file` half of the contract) is DEFERRED:
 * v0 accepts the JSON body; the file-upload variant lands later ([→MANUAL]).
 */
export const publishBodySchema = z.object({
  content: z.string(),
  kind: z.enum(["html", "markdown", "image"]).optional(),
  title: z.string().optional(),
});

export type PublishBody = z.infer<typeof publishBodySchema>;

/**
 * Map a PublishRejected from the service onto the right HTTP DomainError.
 *
 * The service throws ONE PublishRejected type for three reasons; only the size
 * cap (validateSize) produces a "limit" message → 413 PAYLOAD_TOO_LARGE (AS-004).
 * Empty (AS-014) and type-mismatch (AS-005) are validation failures → 400
 * VALIDATION_ERROR. We distinguish on the message because PublishRejected carries
 * no reason code; the over-cap message is the only one mentioning the "limit".
 */
function mapPublishRejected(err: PublishRejected): ValidationError | PayloadTooLargeError {
  if (/over the .* limit/.test(err.message)) {
    return new PayloadTooLargeError(err.message);
  }
  return new ValidationError(err.message);
}

export interface DocsRoutesDeps {
  /** Drizzle handle — used to build the concrete DocRepo per request. */
  db?: DB;
  /** Pre-built repo (injectable for tests that want no DB). Wins over `db`. */
  repo?: DocRepo;
  /** Resolves the better-auth session → actor; gates the route (401 if none). */
  resolveSession: SessionResolver;
}

/**
 * Elysia plugin factory for the render-publish `/api/docs` routes.
 *
 * Mounting order matters and IS the api-core pattern the next route clusters must
 * follow: apiEnvelope FIRST (so every success/error below is wrapped), then the
 * scoped plugins (requireSession, withValidation) as `.use(...)`, then the route.
 * A thrown DomainError (UnauthenticatedError from the gate, ValidationError from
 * validation, or our mapped PublishRejected) is caught by the envelope's onError.
 */
export function docsRoutes(deps: DocsRoutesDeps) {
  const repo: DocRepo =
    deps.repo ??
    (() => {
      if (!deps.db) {
        throw new Error("docsRoutes requires either `repo` or `db`");
      }
      return createDocRepo(deps.db);
    })();

  return apiEnvelope(new Elysia())
    .use(requireSession({ resolveSession: deps.resolveSession }))
    .use(withValidation(publishBodySchema))
    .post("/api/docs", async ({ validBody, set }) => {
      const { content, kind, title } = validBody as PublishBody;
      try {
        const result = await publishDoc(
          {
            bytes: new TextEncoder().encode(content),
            declaredKind: kind,
            editedTitle: title,
          },
          { repo },
        );
        set.status = 201; // created → 201; the envelope echoes statusCode 201
        return { docId: result.docId, slug: result.slug, url: result.url };
      } catch (err) {
        if (err instanceof PublishRejected) {
          throw mapPublishRejected(err);
        }
        throw err; // unexpected → envelope generalizes to 500 (no leak)
      }
    });
}
