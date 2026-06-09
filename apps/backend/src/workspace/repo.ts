// Drizzle-backed project + browse glue (workspace-project S-003, workspaces S-006). The
// single-workspace bootstrap repo (createWorkspaceRepo) and the old member-management repo
// (createWorkspaceMembersRepo) are GONE — multi-workspace tenancy lives in tenancy-repo.ts.
// What stays here: the ProjectRepo (per-workspace projects), the publish project resolver
// (now workspace-scoped), and the browse-context repo (isInvited + docsInProject).

import { and, eq, isNull, sql } from "drizzle-orm";
import { docs, projects, user } from "../db/schema";
import type { DB } from "../db/client";
import { ensureDefaultProject, ProjectRejected, type ProjectRepo, type ProjectRow } from "./projects";
import { activeRolesFor } from "../sharing/doc-member-repo";

/** Map a raw Drizzle projects row to the service's ProjectRow shape. */
function rowToProject(row: typeof projects.$inferSelect): ProjectRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    ownerId: row.ownerId,
    isDefault: row.isDefault,
    archivedAt: row.archivedAt,
  };
}

/**
 * Drizzle-backed ProjectRepo (workspace-project S-003). THIN glue; all rules
 * (name validation, owner/admin gate, block-non-empty-delete, default-protected,
 * default-project idempotency) live in the projects.ts service.
 */
export function createProjectRepo(db: DB): ProjectRepo {
  return {
    async insert(input): Promise<ProjectRow> {
      const [row] = await db
        .insert(projects)
        .values({
          workspaceId: input.workspaceId,
          name: input.name,
          ownerId: input.ownerId,
          isDefault: input.isDefault,
        })
        .returning();
      return rowToProject(row!);
    },

    async findById(workspaceId, projectId): Promise<ProjectRow | null> {
      const [row] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)));
      return row ? rowToProject(row) : null;
    },

    async findDefaultFor(workspaceId, ownerId): Promise<ProjectRow | null> {
      const [row] = await db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.workspaceId, workspaceId),
            eq(projects.ownerId, ownerId),
            eq(projects.isDefault, true),
          ),
        )
        .limit(1);
      return row ? rowToProject(row) : null;
    },

    async listActive(workspaceId): Promise<ProjectRow[]> {
      const rows = await db
        .select()
        .from(projects)
        .where(and(eq(projects.workspaceId, workspaceId), isNull(projects.archivedAt)));
      return rows.map(rowToProject);
    },

    async listAll(workspaceId): Promise<ProjectRow[]> {
      const rows = await db
        .select()
        .from(projects)
        .where(eq(projects.workspaceId, workspaceId));
      return rows.map(rowToProject);
    },

    async setName(projectId, name): Promise<void> {
      await db.update(projects).set({ name }).where(eq(projects.id, projectId));
    },

    async setArchivedAt(projectId, archivedAt): Promise<void> {
      await db.update(projects).set({ archivedAt }).where(eq(projects.id, projectId));
    },

    async countDocs(projectId): Promise<number> {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(docs)
        .where(eq(docs.projectId, projectId));
      return row?.n ?? 0;
    },

    async delete(projectId): Promise<void> {
      await db.delete(projects).where(eq(projects.id, projectId));
    },
  };
}

/** A doc row as the browse route needs it (id + the visibility fields). */
export interface ProjectDocRow {
  id: string;
  slug: string;
  title: string;
  kind: "html" | "markdown" | "image";
  ownerId: string | null;
  generalAccess: "restricted" | "anyone_in_workspace" | "anyone_with_link";
}

/**
 * Workspace-context reads the projects route group still needs after the multi-workspace
 * conversion (workspaces S-006): the per-doc individual invite (active doc_members) and
 * the docs in a project. The workspace id + the caller's admin flag now come from the
 * path-scoped requireWorkspaceMember gate (ctx.ws), so currentWorkspaceId() (LIMIT-1) and
 * the one-arg isWorkspaceMember (a cross-tenant leak) are GONE.
 */
export interface ProjectsRouteRepo {
  isInvited(docId: string, userId: string): Promise<boolean>;
  docsInProject(projectId: string): Promise<ProjectDocRow[]>;
}

export function createProjectsRouteRepo(db: DB): ProjectsRouteRepo {
  return {
    async isInvited(docId, userId): Promise<boolean> {
      const roles = await activeRolesFor(db, docId, userId);
      return roles.length > 0;
    },
    async docsInProject(projectId): Promise<ProjectDocRow[]> {
      const rows = await db
        .select({
          id: docs.id,
          slug: docs.slug,
          title: docs.title,
          kind: docs.kind,
          ownerId: docs.ownerId,
          generalAccess: docs.generalAccess,
        })
        .from(docs)
        .where(eq(docs.projectId, projectId));
      return rows;
    },
  };
}

/**
 * Concrete ProjectResolver for the publish path (workspace-project S-003, AS-005 / C-009 /
 * the MCP-missing-projectId fallback), now WORKSPACE-SCOPED (workspaces S-006). The
 * publish route lives under /api/w/:workspaceId/docs, so the workspace comes from the
 * PATH (the requireWorkspaceMember gate proved membership), never a LIMIT-1 lookup.
 *
 *  - requested projectId present → it must exist IN THAT WORKSPACE; a bogus or foreign id
 *    throws ProjectRejected("not_found") (the route → 404). NEVER silently defaults.
 *  - requested projectId omitted → the publisher's default project in that workspace,
 *    creating it on the fly if absent (ensureDefaultProject is idempotent).
 */
export function createPublishProjectResolver(db: DB) {
  const projectRepo = createProjectRepo(db);
  return async (args: {
    workspaceId: string;
    ownerId: string;
    requestedProjectId?: string | null;
  }): Promise<string> => {
    if (args.requestedProjectId != null) {
      const project = await projectRepo.findById(args.workspaceId, args.requestedProjectId);
      if (!project) {
        // Supplied-but-invalid: reject, do NOT default (distinguishes from "omitted").
        throw new ProjectRejected("project not found in this workspace", "not_found");
      }
      return project.id;
    }
    const [u] = await db.select({ name: user.name }).from(user).where(eq(user.id, args.ownerId));
    const def = await ensureDefaultProject(
      { workspaceId: args.workspaceId, ownerId: args.ownerId, userName: u?.name ?? "My" },
      { repo: projectRepo },
    );
    return def.id;
  };
}
