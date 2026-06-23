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
import {
  requireSession,
  requireWorkspaceMember,
  type SessionResolver,
  type WorkspaceRoleResolver,
} from "../http/auth-gate";
import { withValidation } from "../http/validate";
import { ValidationError, PayloadTooLargeError } from "../http/errors";
import { NotFoundError } from "../http/errors";
import { publishDoc, PublishRejected, type DocRepo, type ProjectResolver } from "../publish/service";
import { createDocRepo } from "../publish/repo";
import { createPublishProjectResolver } from "../workspace/repo";
import { ProjectRejected } from "../workspace/projects";
import { readWorkspaceDefaultAccess, type GeneralAccessLevel } from "../workspace/settings";
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
  // workspace-project S-003 (AS-005): the project to publish into. Omitted → the
  // publisher's default project (C-009 / MCP fallback). A supplied id is validated to
  // belong to the workspace by the resolver (foreign/bogus → 404), never defaulted.
  // Ids are opaque snowflake strings (src/db/id.ts), not uuids — validate as non-empty string.
  projectId: z.string().min(1).optional(),
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
  /** workspaces S-006: resolves the caller's role in :workspaceId for the path-scoped gate. */
  resolveWorkspaceRole: WorkspaceRoleResolver;
  /**
   * workspace-project S-003: resolves the doc's project (explicit → validated, omitted
   * → default). Pre-built for tests; defaults to the Drizzle resolver when `db` is set.
   * When neither is available the doc is published with a null project_id (seed path).
   */
  resolveProjectId?: ProjectResolver;
  /**
   * shared-workspace model (render-publish:C-011): resolves the workspace's default doc access a
   * new doc inherits. Pre-built for tests; defaults to the Drizzle reader when `db` is
   * set (reads workspaces.settings.defaultAccess, default anyone_in_workspace).
   */
  resolveDefaultAccess?: (workspaceId: string) => Promise<GeneralAccessLevel>;
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

  // workspace-project S-003: the project resolver — injected for tests, the concrete
  // Drizzle resolver when a db is present, else undefined (seed path → null project).
  const resolveProjectId: ProjectResolver | undefined =
    deps.resolveProjectId ?? (deps.db ? createPublishProjectResolver(deps.db) : undefined);

  // shared-workspace model (render-publish:C-011): a new doc inherits the workspace's default access
  // (anyone_in_workspace by default). Injected for tests, the Drizzle reader when a db is
  // present, else undefined (no workspace → column default).
  const resolveDefaultAccess: ((workspaceId: string) => Promise<GeneralAccessLevel>) | undefined =
    deps.resolveDefaultAccess ??
    (deps.db ? (workspaceId) => readWorkspaceDefaultAccess(deps.db!, workspaceId) : undefined);

  return apiEnvelope(new Elysia())
    .use(requireSession({ resolveSession: deps.resolveSession }))
    .use(requireWorkspaceMember({ resolveWorkspaceRole: deps.resolveWorkspaceRole }))
    .use(withValidation(publishBodySchema))
    .post("/api/w/:workspaceId/docs", async ({ validBody, actor, ws, set }) => {
      const { content, kind, title, projectId } = validBody as PublishBody;
      try {
        const result = await publishDoc(
          {
            bytes: new TextEncoder().encode(content),
            declaredKind: kind,
            editedTitle: title,
            // auth-routes S-001 (C-001/C-007): the publisher = the SERVER-resolved
            // session user (requireSession injected ctx.actor; 401 already fired
            // for AS-002/C-002 if there was no session). NEVER from the body.
            ownerId: actor.userId,
            // workspaces S-006: the publish workspace from the path (gate proved member).
            workspaceId: ws.workspaceId,
            // workspace-project S-003 (AS-005 / C-009): the chosen project (validated)
            // or — when omitted — the publisher's default project.
            projectId,
          },
          { repo, resolveProjectId, resolveDefaultAccess },
        );
        set.status = 201; // created → 201; the envelope echoes statusCode 201
        return { docId: result.docId, slug: result.slug, url: result.url };
      } catch (err) {
        if (err instanceof PublishRejected) {
          throw mapPublishRejected(err);
        }
        // A supplied-but-invalid projectId → 404 NOT_FOUND (never silent-default).
        if (err instanceof ProjectRejected && err.code === "not_found") {
          throw new NotFoundError(err.message);
        }
        throw err; // unexpected → envelope generalizes to 500 (no leak)
      }
    });
}
