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
import { validateBody } from "../http/validate";
import { ValidationError, PayloadTooLargeError, ForbiddenError } from "../http/errors";
import { NotFoundError } from "../http/errors";
import { publishDoc, PublishRejected, type DocRepo, type ProjectResolver } from "../publish/service";
import { createDocRepo } from "../publish/repo";
import { createPublishProjectResolver } from "../workspace/repo";
import { ProjectRejected } from "../workspace/projects";
import {
  deleteDoc,
  listTrash,
  restoreDoc,
  permanentlyDeleteDoc,
  DocDeleteRejected,
  type DocDeleteRepo,
} from "../workspace/doc-delete";
import { createDocDeleteRepo } from "../workspace/doc-delete-repo";
import { type ActivityEmitDeps } from "../activity/emit";
import { createActivityRepo, type ActivityRepo } from "../activity/repo";
import type { Role } from "../sharing/roles";
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
  // ── doc-delete-trash S-001: the DELETE /api/w/:workspaceId/docs/:slug seams ──
  /** Pre-built soft-delete repo (tests). Wins over `db`. */
  deleteRepo?: DocDeleteRepo;
  /**
   * The actor's effective per-doc role on the target (resolveAccess seam) — one arm of the
   * composed delete gate (C-003). Provide to ENABLE the DELETE route; omit and the route is
   * not mounted (keeps existing publish-only route tests unchanged).
   */
  resolveDocRole?: (docId: string, userId: string) => Promise<Role | null>;
  /**
   * Whether the actor is an admin of the DOC'S workspace — the other arm of the composed gate
   * (C-003). Scoped to (workspaceId, userId), bound per-request to ws.workspaceId below.
   */
  isWorkspaceAdmin?: (workspaceId: string, userId: string) => boolean | Promise<boolean>;
  /**
   * doc-delete-trash S-001 / AS-005 (C-006): emit a `doc_deleted` activity row after a
   * successful tombstone (emit-on-change only). Doc-scoped — the row's workspaceId is anchored
   * to the doc's OWN workspace. Best-effort post-commit; OMIT to leave activity logging off.
   */
  deleteActivity?: {
    repo?: ActivityRepo;
    resolveActorName: (userId: string) => Promise<string | null>;
  };
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

  // doc-access-two-axis S-002 (C-007): a new doc's access is no longer inherited from a
  // workspace setting — the publish repo creates its share_links row with the FIXED
  // new-doc defaults (workspace_role = commenter, link_role = null), so there is nothing
  // access-related to resolve or plumb through this route.

  // doc-delete-trash S-001: the soft-delete repo (injected for tests, the concrete Drizzle
  // repo when a db is present). The DELETE route mounts only when resolveDocRole is provided.
  const deleteRepo: DocDeleteRepo | undefined =
    deps.deleteRepo ?? (deps.db ? createDocDeleteRepo(deps.db) : undefined);
  // The `doc_deleted` emit deps — built only when the deleteActivity block is provided. The repo
  // is pre-built (tests) or built from `db`; resolveActorName resolves the actor name per-emit.
  const deleteActivityDeps: ActivityEmitDeps | null =
    deps.deleteActivity != null
      ? {
          repo:
            deps.deleteActivity.repo ??
            (() => {
              if (!deps.db) throw new Error("docsRoutes deleteActivity requires `deleteActivity.repo` or `db`");
              return createActivityRepo(deps.db);
            })(),
          resolveActorName: deps.deleteActivity.resolveActorName,
        }
      : null;

  const app = apiEnvelope(new Elysia())
    .use(requireSession({ resolveSession: deps.resolveSession }))
    .use(requireWorkspaceMember({ resolveWorkspaceRole: deps.resolveWorkspaceRole }))
    // Body validation is INLINE per-handler (validateBody), NOT the scoped withValidation
    // plugin: the DELETE route below shares this instance and carries no body, so a scoped
    // body-validation resolve would wrongly 400 the bodyless DELETE. Inline keeps the publish
    // POST's guarantees (empty/type → 400, unknown-field strip) while the DELETE stays bodyless.
    .post("/api/w/:workspaceId/docs", async ({ body, actor, ws, set }) => {
      const { content, kind, title, projectId } = validateBody(publishBodySchema, body);
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
          { repo, resolveProjectId },
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

  // doc-delete-trash S-001: DELETE /api/w/:workspaceId/docs/:slug — soft-delete a doc into Trash.
  // Mounts ONLY when the per-doc role resolver is wired (the composed gate's per-doc arm). Gate =
  // (resolveAccess role ∈ {owner, editor}) OR (workspace admin) — C-003. The admin arm is bound
  // per-request to ws.workspaceId (C-002 scoping). Errors: 401 (no session, from the gate), 403
  // FORBIDDEN ("insufficient permission" — commenter/viewer + non-admin, AS-004), 404 NOT_FOUND
  // (missing/inaccessible doc — existence-hiding). A double-delete is idempotent (C-006/AS-022).
  if (deleteRepo && deps.resolveDocRole) {
    const resolveDocRole = deps.resolveDocRole;
    app.delete("/api/w/:workspaceId/docs/:slug", async ({ params, actor, ws }) => {
      try {
        const res = await deleteDoc(
          { slug: params.slug, actorId: actor.userId },
          {
            repo: deleteRepo,
            resolveDocRole,
            isWorkspaceAdmin: deps.isWorkspaceAdmin
              ? (uid: string) => deps.isWorkspaceAdmin!(ws.workspaceId, uid)
              : undefined,
            activity: deleteActivityDeps ?? undefined,
          },
        );
        return { docId: res.docId, slug: res.slug, deleted: true };
      } catch (err) {
        if (err instanceof DocDeleteRejected) {
          throw err.code === "forbidden"
            ? new ForbiddenError(err.message)
            : new NotFoundError(err.message);
        }
        throw err;
      }
    });

    // doc-delete-trash S-003: GET /api/w/:workspaceId/trash — the workspace Trash list.
    // SCOPED to the path workspace (deleted_at IS NOT NULL AND deleted_workspace_id = :workspaceId,
    // C-007) — a deleted row escapes the browse filter, so this workspace match is the only thing
    // keeping another workspace's tombstones out (AS-026). Membership is proven by the shared
    // requireWorkspaceMember gate above (401 no session). Empty list → the AS-013 empty state.
    app.get("/api/w/:workspaceId/trash", async ({ ws }) => {
      const entries = await listTrash({ workspaceId: ws.workspaceId }, { repo: deleteRepo });
      return {
        docs: entries.map((e) => ({
          id: e.id,
          slug: e.slug,
          title: e.title,
          deletedAt: e.deletedAt.toISOString(),
          // S-007: surface the owner so the Trash UI can offer "Delete forever" to owner-or-admin
          // only (AS-035). The server gate is still authoritative.
          ownerId: e.ownerId,
        })),
      };
    });

    // doc-delete-trash S-003: POST /api/w/:workspaceId/trash/:id/restore — restore from Trash.
    // Resolved BY ID (the Trash row carries the id; the slug is unchanged but the id is the stable
    // handle) and scoped to :workspaceId (C-007). Gate = the SAME composed gate as delete (C-003):
    // (per-doc role ∈ {owner,editor}) OR (workspace admin). Errors: 401 (gate), 403 FORBIDDEN
    // (commenter/viewer + non-admin, AS-020), 404 NOT_FOUND (missing / other-workspace / active —
    // existence-hiding + AS-025). Idempotent (C-006): restoring an active doc is a no-op (AS-027).
    // Restore returns the doc PRIVATE (both axes off + token rotated, C-008 / AS-023).
    // Mounted under /trash/:id (NOT /docs/:id): the doc routes use `/docs/:slug`, and memoirist
    // forbids a second param name (`:id`) at the same `/docs/:param` position — it crashes the whole
    // app at boot. Trash operations key on the doc id, so they live under the sibling `/trash/` path.
    app.post("/api/w/:workspaceId/trash/:id/restore", async ({ params, actor, ws }) => {
      try {
        const res = await restoreDoc(
          { workspaceId: ws.workspaceId, docId: params.id, actorId: actor.userId },
          {
            repo: deleteRepo,
            resolveDocRole,
            isWorkspaceAdmin: deps.isWorkspaceAdmin
              ? (uid: string) => deps.isWorkspaceAdmin!(ws.workspaceId, uid)
              : undefined,
            resolveActorName: deps.deleteActivity?.resolveActorName,
            activity: deleteActivityDeps ?? undefined,
          },
        );
        return { docId: res.docId, slug: res.slug, projectId: res.projectId, restored: true };
      } catch (err) {
        if (err instanceof DocDeleteRejected) {
          throw err.code === "forbidden"
            ? new ForbiddenError(err.message)
            : new NotFoundError(err.message);
        }
        throw err;
      }
    });

    // doc-delete-trash S-007: POST /api/w/:workspaceId/trash/:id/permanent — permanently
    // (hard) delete a doc FROM TRASH, cascading its versions/annotations/comments/share_links.
    // Resolved BY ID and scoped to :workspaceId (C-007); the doc MUST already be in Trash
    // (findDeletedById requires deleted_at IS NOT NULL), so an active doc is unreachable here.
    // Under /trash/:id (same reason as restore: `/docs/:slug` owns that path position; a second
    // param name there crashes the app at boot). POST since it sits next to the restore POST.
    // Gate (C-003, NARROWED for S-007): OWNER-OR-ADMIN only — strictly narrower than the
    // soft-delete/restore gate, which also admits a per-doc editor. A per-doc editor (non-owner),
    // commenter, or viewer is refused (AS-035). Errors: 401 (gate), 403 FORBIDDEN (not owner +
    // non-admin, AS-035), 404 NOT_FOUND (missing / other-workspace / active — existence-hiding).
    app.post("/api/w/:workspaceId/trash/:id/permanent", async ({ params, actor, ws }) => {
      try {
        const res = await permanentlyDeleteDoc(
          { workspaceId: ws.workspaceId, docId: params.id, actorId: actor.userId },
          {
            repo: deleteRepo,
            resolveDocRole,
            isWorkspaceAdmin: deps.isWorkspaceAdmin
              ? (uid: string) => deps.isWorkspaceAdmin!(ws.workspaceId, uid)
              : undefined,
          },
        );
        return { docId: res.docId, slug: res.slug, purged: true };
      } catch (err) {
        if (err instanceof DocDeleteRejected) {
          throw err.code === "forbidden"
            ? new ForbiddenError(err.message)
            : new NotFoundError(err.message);
        }
        throw err;
      }
    });
  }

  return app;
}
