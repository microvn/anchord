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
  setProjectVisibility,
  listProjects,
  filterBrowsableDocs,
  projectNameForViewer,
  canViewProject,
  deriveNewDocAccess,
  ProjectRejected,
  MAX_PROJECT_NAME_LENGTH,
  type ProjectRepo,
  type ProjectVisibility,
} from "../workspace/projects";
import { deriveLevel, type GeneralAccessLevel } from "../sharing/derive-level";
import {
  createProjectRepo,
  createProjectsRouteRepo,
  type ProjectsRouteRepo,
  type WorkspaceDocRow,
} from "../workspace/repo";
import { can, type Role } from "../sharing/roles";
import { paginationQuery, buildPagination, type PaginationParams } from "../http/pagination";
import { emitActivity, type ActivityEmitDeps } from "../activity/emit";
import { createActivityRepo, type ActivityRepo } from "../activity/repo";
import type { DB } from "../db/client";

// S-007: the shared page parser for the browse + projects-list reads (default size 20,
// limit clamped to 100). `page` < 1 is rejected as 400 VALIDATION_ERROR (pagination.ts).
const browsePage = paginationQuery({ defaultLimit: 20, maxLimit: 100 });

export const createProjectBodySchema = z.object({
  name: z.string().min(1, "project name is required").max(MAX_PROJECT_NAME_LENGTH),
  // project-visibility-fe S-005 / C-001 / AS-018/AS-019: the web create may carry an explicit
  // visibility choice (the New Project dialog's Public/Private control, default Public) — the web
  // counterpart of MCP create_project's param. Optional + absence-tolerant: a body without it keeps
  // the prior public default (createProject's `?? "public"`), so existing create flows are unchanged.
  visibility: z.enum(["private", "public"]).optional(),
});
// Rename takes ONLY a name (no visibility on rename — the toggle path owns visibility changes).
export const renameProjectBodySchema = z.object({
  name: z.string().min(1, "project name is required").max(MAX_PROJECT_NAME_LENGTH),
});
// project-visibility S-003 / C-008: the toggle body — visibility ∈ private | public.
// project-visibility-cascade S-001 / C-001: an OPTIONAL `cascade` flag. When true AND the
// transition is public→private, setProjectVisibility also bulk-nulls the project's docs'
// share_links (both axes). Default false / absent → the parent behaviour (project shell only).
export const visibilityBodySchema = z.object({
  visibility: z.enum(["private", "public"]),
  cascade: z.boolean().optional(),
});

export interface ProjectsRoutesDeps {
  db?: DB;
  /** Pre-built service repo (tests). Wins over `db`. */
  repo?: ProjectRepo;
  /** Pre-built workspace-context repo (tests). Wins over `db`. */
  ctx?: ProjectsRouteRepo;
  resolveSession: SessionResolver;
  /** workspaces S-006: resolves the caller's role in :workspaceId for the path-scoped gate. */
  resolveWorkspaceRole: WorkspaceRoleResolver;
  /**
   * doc-delete-trash S-001 / C-003: the authoritative per-doc role resolver (same one the delete
   * gate uses). The docs-list response carries a server-computed `canDelete` per doc so the ⋯-menu
   * Delete item exactly mirrors the gate — `(role ∈ {owner,editor})` OR workspace-admin — instead
   * of the FE re-deriving it from partial data. Optional: when omitted (older test wirings), the
   * list falls back to the workspace-admin arm only.
   */
  resolveDocRole?: (docId: string, userId: string) => Promise<Role | null>;
  /**
   * workspace-activity S-006 / AS-024 (C-002 / C-005): emit a `project` activity row after a
   * project is CREATED. A WORKSPACE-LEVEL event (no doc target) — the row's workspaceId is the
   * path workspace (passed directly, so `workspaceOfDoc` is unused here). Best-effort POST-COMMIT —
   * a logging failure NEVER blocks the create (emitActivity swallows + logs). Provide a pre-built
   * ActivityRepo (tests) — else one is built from `db` — plus `resolveActorName` (the session
   * carries only userId). OMIT the whole block to leave activity logging off (the create still
   * succeeds; no row) — keeps existing route tests that don't exercise activity unchanged.
   */
  activity?: {
    repo?: ActivityRepo;
    resolveActorName: (userId: string) => Promise<string | null>;
  };
}

/**
 * project-visibility S-004 / AS-030 / C-011: the derived general-access LEVEL a NEW doc created in
 * this project WOULD get — so the new-doc / move-copy picker DISPLAYS the server-derived outcome
 * (carve-out included) instead of re-mirroring the rule client-side. Reuses the SAME two helpers the
 * publish derivation uses: `deriveNewDocAccess` (the two share_links axes) → `deriveLevel` (the level).
 * default (private shell) → anyone_in_workspace (carve-out); non-default public → anyone_in_workspace;
 * non-default private → restricted.
 */
function newDocAccessLevel(p: {
  isDefault: boolean;
  visibility: ProjectVisibility;
}): GeneralAccessLevel {
  const { workspaceRole, linkRole } = deriveNewDocAccess(p);
  return deriveLevel(workspaceRole, linkRole);
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

  // workspace-activity S-006: built only when the `activity` block is provided. The repo is
  // pre-built (tests) or built from `db`; resolveActorName resolves the actor name per-emit.
  // Absent → the project-created emit is a no-op. workspaceOfDoc is unused (workspace-level event).
  const activityDeps: ActivityEmitDeps | null =
    deps.activity != null
      ? {
          repo:
            deps.activity.repo ??
            (() => {
              if (!deps.db) throw new Error("projectsRoutes activity requires `activity.repo` or `db`");
              return createActivityRepo(deps.db);
            })(),
          resolveActorName: deps.activity.resolveActorName,
        }
      : null;

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
      const { name, visibility } = validateBody(createProjectBodySchema, body);
      try {
        const p = await createProject(
          // project-visibility-fe S-005 / C-001: pass the chosen visibility straight through (the
          // service defaults to "public" when undefined) — so an intended-private project is private
          // the moment it exists, with no create-public-then-toggle window. ownerId stays the SERVER
          // session actor (anti-forgery), never a body field.
          { workspaceId: ws.workspaceId, name, ownerId: actor.userId, visibility },
          { repo },
        );
        // workspace-activity S-006 / AS-024 (C-005): a project create logs ONE `project` event
        // naming the project (workspace-level — no doc target; workspaceId from the path). Best-
        // effort post-commit — never blocks the create (emitActivity swallows + logs).
        if (activityDeps) {
          await emitActivity(
            {
              type: "project",
              actorUserId: actor.userId,
              workspaceId: ws.workspaceId,
              projectId: p.id,
              summary: "created project",
              target: p.name,
            },
            activityDeps,
          );
        }
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
    // PATCH visibility — toggle private↔public (project-visibility S-003 / C-008). Auth is the
    // C-008 rule (owner always; admin only on a project they can SEE — own + public), enforced in
    // setProjectVisibility, NOT the plain owner-or-admin manage gate. Touches only the project's
    // visibility — never share_links — so existing docs' access is unchanged (AS-014).
    .patch("/api/w/:workspaceId/projects/:id/visibility", async ({ params, body, actor, ws }) => {
      const { visibility, cascade } = validateBody(visibilityBodySchema, body);
      try {
        const p = await setProjectVisibility(
          {
            workspaceId: ws.workspaceId,
            projectId: params.id,
            actorId: actor.userId,
            isAdmin: ws.role === "admin",
            visibility,
            // project-visibility-cascade S-001 / C-001: thread the choice through. The service
            // applies it ONLY on a public→private transition; any other case ignores it.
            cascade,
          },
          { repo },
        );
        return { id: p.id, visibility: p.visibility };
      } catch (err) {
        if (err instanceof ProjectRejected) throw mapProjectRejected(err);
        throw err;
      }
    })
    // GET — browse list (active by default; includeArchived=true shows all).
    .get("/api/w/:workspaceId/projects", async ({ query, actor, ws }) => {
      const includeArchived = (query as Record<string, string>).includeArchived === "true";
      const page = browsePage.parse(query) as PaginationParams;
      // project-visibility S-002 / C-002 / C-003: the list is filtered to the projects the
      // CALLER may view (own + public) — a private project of another member is absent, with no
      // admin exception. listProjects applies the shared canViewProject predicate.
      const list = await listProjects(
        { workspaceId: ws.workspaceId, userId: actor.userId, includeArchived },
        { repo },
      );
      // S-007/C-010: paginate AFTER the (archive) filter — total is the filtered count, and
      // the `projects` key is RETAINED; `pagination` is additive.
      const total = list.length;
      const start = (page.page - 1) * page.limit;
      const slice = list.slice(start, start + page.limit);
      // S-003/AS-028: each project's ACCESSIBLE-doc count in ONE query (GROUP BY behind the
      // SAME access predicate as the browse, C-003) — never a per-project loop. The count
      // reflects ONLY docs the caller can access, so it never leaks an out-of-access doc. A
      // project absent from the map has zero accessible docs → docCount 0.
      const docCounts = await ctx.countDocsByProject(ws.workspaceId, actor.userId);
      const isWorkspaceAdmin = ws.role === "admin";
      return {
        projects: slice.map((p) => ({
          id: p.id,
          name: p.name,
          isDefault: p.isDefault,
          // project-visibility S-003 / C-011 / AS-015: the list row carries `visibility` alongside
          // `isDefault` so the web shows the Default badge + a private/public indicator.
          visibility: p.visibility,
          // project-visibility S-003 (AS-015 extension) / C-008 / C-011: a server-computed flag —
          // true iff the viewer may toggle THIS project's visibility — so the FE renders the toggle
          // affordance without re-deriving the gate. MIRRORS the setProjectVisibility gate EXACTLY:
          // owner always; a workspace admin only on a project they can SEE (own + public, via the
          // shared canViewProject) — so an admin never gets the affordance on another member's
          // private project (it isn't in this list anyway, S-002/C-003). Uses ownerId from the repo
          // row WITHOUT exposing raw ownerId in the payload.
          canToggleVisibility:
            p.ownerId === actor.userId || (isWorkspaceAdmin && canViewProject(actor.userId, p)),
          // project-visibility S-004 / AS-030 / C-011: the derived level a NEW doc here would get,
          // so the pre-publish access hint shows the server-derived outcome (carve-out included).
          newDocAccess: newDocAccessLevel(p),
          archived: p.archivedAt != null,
          docCount: docCounts.get(p.id) ?? 0,
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
          // doc-access-two-axis S-004 / AS-026 / C-008: status + access summary derive from the
          // TWO axes (deriveLevel, computed in SQL — no stored level). A doc shared beyond
          // "restricted" (either axis on) is LIVE; both axes off → still a private DRAFT. The
          // link-only doc never reaches this map at all — it was dropped by the C-006 filter
          // above, so the listed rows and the `total` count come from the SAME filtered set.
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
            // doc-access-two-axis S-006 / C-008: the raw two-axis state alongside the lossy
            // `generalAccess` summary, so a list row that opens the Share dialog can tell
            // workspace-shared from link-only — the distinction the summary drops (AS-027).
            workspaceRole: d.workspaceRole,
            linkRole: d.linkRole,
            // S-003/AS-022: created + last-updated times so the browse can sort by Created /
            // Updated (workspace-project-browse:S-003) without a second fetch.
            createdAt: d.createdAt,
            updatedAt: d.updatedAt,
          };
        }),
        pagination: buildPagination({ page: page.page, limit: page.limit, total }),
      };
    })
    // GET docs (workspace-wide) — the ACCESS-FILTERED union of docs across the workspace's
    // ACTIVE projects, in ONE read (S-008). Retires the FE N+1 fan-out (1 projects read + 1
    // per project). Returns the requested PAGE of the union (each doc annotated with its
    // projectId + projectName), the active-project list (id + name, for the move/copy picker
    // + project-count stat — NO per-project doc count, AS-024), and the workspace total — all
    // from the same read. Access filtering (C-003) runs BEFORE paging AND the total, so no
    // out-of-access doc appears in `docs` or `total` (AS-026). Default page size 20, cap 100.
    .get("/api/w/:workspaceId/docs", async ({ actor, ws, query }) => {
      const page = browsePage.parse(query) as PaginationParams;
      // ONE union pass (repo joins docs → active projects + browse columns; no per-project loop).
      const union = await ctx.workspaceDocs(ws.workspaceId);
      // Same access filter the per-project browse uses (C-006) — applied to the WHOLE union
      // before any paging or counting. `filterBrowsableDocs` reads only id/ownerId/workspaceShared
      // (the raw workspace axis), so the WorkspaceDocRow rows pass straight through and keep their
      // project annotation.
      const visible = (await filterBrowsableDocs(actor.userId, union, {
        isInvited: (docId, userId) => ctx.isInvited(docId, userId),
        // The caller is a member of ws.workspaceId (gate proved it) and every union doc lives in
        // an active project of that workspace, so anyone_in_workspace resolves true here.
        isWorkspaceMember: () => Promise.resolve(true),
      })) as WorkspaceDocRow[];

      // Active-project list — every ACTIVE project the CALLER may VIEW (AS-024 + project-
      // visibility S-002 / C-002 / AS-008): this feeds the move/copy target picker, so it MUST
      // apply the same canViewProject predicate — a private project of another member never
      // leaks into the picker (no name leak). listProjects filters by userId.
      const activeProjects = await listProjects(
        { workspaceId: ws.workspaceId, userId: actor.userId, includeArchived: false },
        { repo },
      );

      // Paginate AFTER the access filter (C-003): total = accessible union size; page slice
      // off the updated-desc-ordered union.
      const total = visible.length;
      const start = (page.page - 1) * page.limit;
      const pageDocs = visible.slice(start, start + page.limit);

      // doc-delete-trash S-001 / C-003: per-doc `canDelete` for THIS page only (bounded N, the
      // route already pages server-side). Mirrors the delete gate EXACTLY — (per-doc role carries
      // EDIT, i.e. owner/editor) OR the caller is a workspace admin — using the same authoritative
      // resolveDocRole, so the FE never re-derives the two-axis gate. No resolver wired → admin-only.
      const isWsAdmin = ws.role === "admin";
      const resolveDocRole = deps.resolveDocRole;
      const canDeleteById = new Map<string, boolean>();
      if (resolveDocRole) {
        await Promise.all(
          pageDocs.map(async (d) => {
            const role = await resolveDocRole(d.id, actor.userId);
            canDeleteById.set(d.id, (role !== null && can(role, "edit")) || isWsAdmin);
          }),
        );
      } else {
        for (const d of pageDocs) canDeleteById.set(d.id, isWsAdmin);
      }

      return {
        docs: pageDocs.map((d) => ({
          id: d.id,
          slug: d.slug,
          title: d.title,
          kind: d.kind,
          version: d.latestVersion,
          annotationCount: d.annotationCount,
          authorName: d.ownerName,
          status: d.generalAccess === "restricted" ? "draft" : "live",
          generalAccess: d.generalAccess,
          // doc-access-two-axis S-006 / C-008: raw axes alongside the lossy summary (AS-027).
          workspaceRole: d.workspaceRole,
          linkRole: d.linkRole,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
          // S-008/AS-023: each doc carries the project it belongs to (name joined in the union
          // query) so the consumer needs no second projects fetch to label a card.
          projectId: d.projectId,
          // project-visibility S-006 / C-004 / AS-026: SUPPRESS the project NAME on the card for a
          // non-owner of a PRIVATE project — the doc still lists (per-doc access, C-005), but the
          // private project's name must not leak. `projectNameForViewer` reuses the ONE shared
          // `canViewProject` predicate (own + public); the owner (and any member of a public project)
          // keeps the real name, a non-owner of a private project gets null.
          projectName: projectNameForViewer(actor.userId, {
            name: d.projectName,
            ownerId: d.projectOwnerId,
            visibility: d.projectVisibility,
          }),
          // doc-delete-trash S-001 / C-003: drives the ⋯-menu Delete item (owner/editor/admin).
          canDelete: canDeleteById.get(d.id) ?? false,
        })),
        // S-008/AS-024: the active-project list (id + name) from the same read — for the
        // move/copy target picker + the project-count stat. NO per-project doc count (unused).
        // isDefault/archived ride along so the picker can badge the default; the count does not.
        projects: activeProjects.map((p) => ({
          id: p.id,
          name: p.name,
          isDefault: p.isDefault,
          // project-visibility S-003 / C-011: the move/copy target picker option carries
          // `visibility` too (the same badge the projects-list shows) — additive, zero-risk.
          visibility: p.visibility,
          // project-visibility S-004 / AS-030 / C-011: the picker (which reads /docs) shows the
          // access a new doc in this target WOULD get without re-deriving the carve-out client-side.
          newDocAccess: newDocAccessLevel(p),
          archived: p.archivedAt != null,
        })),
        pagination: buildPagination({ page: page.page, limit: page.limit, total }),
      };
    });

  return app;
}
