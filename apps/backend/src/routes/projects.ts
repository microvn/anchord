// HTTP route mount for the projects cluster (workspace-project S-003).
//
// This is INTEGRATION GLUE over the already-unit-tested project service
// (src/workspace/projects.ts) + the browse access filter (canBrowseDoc). The same
// api-core composition as docsRoutes/setupRoutes: apiEnvelope → requireSession →
// withValidation. Identity (actor.userId) is SERVER-resolved (anti-forgery): the
// owner of a created project, the manage-gate actor, and the browse viewer all come
// from the session, never the body.
//
// Contract:
//   POST   /api/projects                      → 201 { id, name }            (C-002: any member)
//   GET    /api/projects?includeArchived=     → 200 { projects: [...] }     (active by default, C-005)
//   PATCH  /api/projects/:id  { name }        → 200 { id, name }            (owner-or-admin)
//   POST   /api/projects/:id/archive          → 200 { id, archivedAt }      (owner-or-admin; not default)
//   POST   /api/projects/:id/unarchive        → 200 { id }                  (owner-or-admin)
//   DELETE /api/projects/:id                  → 200 { id }                  (owner-or-admin; empty; not default)
//   GET    /api/projects/:id/docs             → 200 { docs: [...] }         (access-filtered, C-003/AS-006)
//
// Errors: 400 VALIDATION_ERROR (bad name), 404 NOT_FOUND (no project / no workspace),
//         403 FORBIDDEN (non-owner manage), 409 CONFLICT (non-empty / default-protected).

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
import { ValidationError, NotFoundError, ForbiddenError, ConflictError } from "../http/errors";
import {
  createProject,
  renameProject,
  archiveProject,
  unarchiveProject,
  deleteProject,
  listProjects,
  filterBrowsableDocs,
  ProjectRejected,
  MAX_PROJECT_NAME_LENGTH,
  type ProjectRepo,
} from "../workspace/projects";
import { createProjectRepo, createProjectsRouteRepo, type ProjectsRouteRepo } from "../workspace/repo";
import { paginationQuery, buildPagination, type PaginationParams } from "../http/pagination";
import type { DB } from "../db/client";

// S-007: the shared page parser for the browse + projects-list reads (default size 20,
// limit clamped to 100). `page` < 1 is rejected as 400 VALIDATION_ERROR (pagination.ts).
const browsePage = paginationQuery({ defaultLimit: 20, maxLimit: 100 });

export const createProjectBodySchema = z.object({
  name: z.string().min(1, "project name is required").max(MAX_PROJECT_NAME_LENGTH),
});
export const renameProjectBodySchema = createProjectBodySchema;

export interface ProjectsRoutesDeps {
  db?: DB;
  /** Pre-built service repo (tests). Wins over `db`. */
  repo?: ProjectRepo;
  /** Pre-built workspace-context repo (tests). Wins over `db`. */
  ctx?: ProjectsRouteRepo;
  resolveSession: SessionResolver;
  /** workspaces S-006: resolves the caller's role in :workspaceId for the path-scoped gate. */
  resolveWorkspaceRole: WorkspaceRoleResolver;
}

/** Map a ProjectRejected onto the right HTTP DomainError. */
function mapProjectRejected(
  err: ProjectRejected,
): ValidationError | NotFoundError | ForbiddenError | ConflictError {
  switch (err.code) {
    case "invalid_name":
      return new ValidationError(err.message);
    case "not_found":
      return new NotFoundError(err.message);
    case "forbidden":
      return new ForbiddenError(err.message);
    case "not_empty":
    case "default_protected":
      return new ConflictError(err.message);
  }
}

export function projectsRoutes(deps: ProjectsRoutesDeps) {
  const repo: ProjectRepo =
    deps.repo ??
    (() => {
      if (!deps.db) throw new Error("projectsRoutes requires either `repo`/`ctx` or `db`");
      return createProjectRepo(deps.db);
    })();
  const ctx: ProjectsRouteRepo =
    deps.ctx ??
    (() => {
      if (!deps.db) throw new Error("projectsRoutes requires either `repo`/`ctx` or `db`");
      return createProjectsRouteRepo(deps.db);
    })();

  // ONE enveloped + session-gated + workspace-scoped instance for the whole group. The
  // workspace gate (requireWorkspaceMember) injects ctx.ws = { workspaceId, role } from
  // the :workspaceId path — a non-member is 404 (existence-hiding) BEFORE any handler.
  // Body validation is INLINE (validateBody) per handler (the withValidation plugin is
  // name-deduped, so two on one instance collapse). All paths live under /api/w/:workspaceId.
  const app = apiEnvelope(new Elysia())
    .use(requireSession({ resolveSession: deps.resolveSession }))
    .use(requireWorkspaceMember({ resolveWorkspaceRole: deps.resolveWorkspaceRole }))
    // POST — any member creates a project (C-002).
    .post("/api/w/:workspaceId/projects", async ({ body, actor, ws, set }) => {
      const { name } = validateBody(createProjectBodySchema, body);
      try {
        const p = await createProject(
          { workspaceId: ws.workspaceId, name, ownerId: actor.userId },
          { repo },
        );
        set.status = 201;
        return { id: p.id, name: p.name };
      } catch (err) {
        if (err instanceof ProjectRejected) throw mapProjectRejected(err);
        throw err;
      }
    })
    // PATCH — rename (owner-or-admin).
    .patch("/api/w/:workspaceId/projects/:id", async ({ params, body, actor, ws }) => {
      const { name } = validateBody(renameProjectBodySchema, body);
      try {
        const p = await renameProject(
          {
            workspaceId: ws.workspaceId,
            projectId: params.id,
            actorId: actor.userId,
            isAdmin: ws.role === "admin",
            name,
          },
          { repo },
        );
        return { id: p.id, name: p.name };
      } catch (err) {
        if (err instanceof ProjectRejected) throw mapProjectRejected(err);
        throw err;
      }
    })
    // GET — browse list (active by default; includeArchived=true shows all).
    .get("/api/w/:workspaceId/projects", async ({ query, ws }) => {
      const includeArchived = (query as Record<string, string>).includeArchived === "true";
      const page = browsePage.parse(query) as PaginationParams;
      const list = await listProjects({ workspaceId: ws.workspaceId, includeArchived }, { repo });
      // S-007/C-010: paginate AFTER the (archive) filter — total is the filtered count, and
      // the `projects` key is RETAINED; `pagination` is additive.
      const total = list.length;
      const start = (page.page - 1) * page.limit;
      const slice = list.slice(start, start + page.limit);
      return {
        projects: slice.map((p) => ({
          id: p.id,
          name: p.name,
          isDefault: p.isDefault,
          archived: p.archivedAt != null,
        })),
        pagination: buildPagination({ page: page.page, limit: page.limit, total }),
      };
    })
    // POST archive — hide from browse (owner-or-admin; default protected).
    .post("/api/w/:workspaceId/projects/:id/archive", async ({ params, actor, ws }) => {
      try {
        const p = await archiveProject(
          { workspaceId: ws.workspaceId, projectId: params.id, actorId: actor.userId, isAdmin: ws.role === "admin" },
          { repo },
        );
        return { id: p.id, archived: true, archivedAt: p.archivedAt };
      } catch (err) {
        if (err instanceof ProjectRejected) throw mapProjectRejected(err);
        throw err;
      }
    })
    // POST unarchive — show again (owner-or-admin).
    .post("/api/w/:workspaceId/projects/:id/unarchive", async ({ params, actor, ws }) => {
      try {
        const p = await unarchiveProject(
          { workspaceId: ws.workspaceId, projectId: params.id, actorId: actor.userId, isAdmin: ws.role === "admin" },
          { repo },
        );
        return { id: p.id, archived: false };
      } catch (err) {
        if (err instanceof ProjectRejected) throw mapProjectRejected(err);
        throw err;
      }
    })
    // DELETE — delete (owner-or-admin; blocked if non-empty or default).
    .delete("/api/w/:workspaceId/projects/:id", async ({ params, actor, ws }) => {
      try {
        await deleteProject(
          { workspaceId: ws.workspaceId, projectId: params.id, actorId: actor.userId, isAdmin: ws.role === "admin" },
          { repo },
        );
        return { id: params.id, deleted: true };
      } catch (err) {
        if (err instanceof ProjectRejected) throw mapProjectRejected(err);
        throw err;
      }
    })
    // GET docs — browse docs in a project, ACCESS-FILTERED (C-003/AS-006). An out-of-access
    // doc is ABSENT (existence-hiding). The project must exist in the workspace (else 404).
    // anyone_in_workspace resolves against THIS workspace (the caller is already a member,
    // proven by the gate) — AS-019/AS-020.
    .get("/api/w/:workspaceId/projects/:id/docs", async ({ params, actor, ws, query }) => {
      const project = await repo.findById(ws.workspaceId, params.id);
      if (!project) throw new NotFoundError("project not found");
      const page = browsePage.parse(query) as PaginationParams;
      const projectDocs = await ctx.docsInProject(project.id);
      const visible = await filterBrowsableDocs(actor.userId, projectDocs, {
        isInvited: (docId, userId) => ctx.isInvited(docId, userId),
        // The caller is a member of ws.workspaceId (gate proved it) and these docs are
        // in that workspace, so anyone_in_workspace resolves true for them here.
        isWorkspaceMember: () => Promise.resolve(true),
      });
      // S-007/C-010/AS-020: paginate AFTER the access filter (C-003). `total` is the count of
      // ACCESSIBLE docs (never the raw projectDocs.length), so no out-of-access doc is ever
      // counted or paged into view. The `docs` key is RETAINED; `pagination` is additive.
      const total = visible.length;
      const start = (page.page - 1) * page.limit;
      const pageDocs = visible.slice(start, start + page.limit);
      const byId = new Map(projectDocs.map((d) => [d.id, d]));
      return {
        docs: pageDocs.map((v) => {
          const d = byId.get(v.id)!;
          // status maps from general_access: a doc shared beyond "restricted" is LIVE
          // (reachable by its audience); a restricted doc is still a private DRAFT. This is
          // the honest published-state signal available without a separate publish flag.
          const status = d.generalAccess === "restricted" ? "draft" : "live";
          return {
            id: d.id,
            slug: d.slug,
            title: d.title,
            kind: d.kind,
            version: d.latestVersion,
            annotationCount: d.annotationCount,
            authorName: d.ownerName,
            status,
            // S-003/AS-021: the raw general-access level (restricted | anyone_in_workspace |
            // anyone_with_link) so the FE AccessIndicator (workspace-project-ui:S-006) can show
            // the 3-way badge — `status` collapses link vs workspace, this does not.
            generalAccess: d.generalAccess,
          };
        }),
        pagination: buildPagination({ page: page.page, limit: page.limit, total }),
      };
    });

  return app;
}
