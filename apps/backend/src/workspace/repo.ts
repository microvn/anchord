// Drizzle-backed project + browse glue (workspace-project S-003, workspaces S-006). The
// single-workspace bootstrap repo (createWorkspaceRepo) and the old member-management repo
// (createWorkspaceMembersRepo) are GONE — multi-workspace tenancy lives in tenancy-repo.ts.
// What stays here: the ProjectRepo (per-workspace projects), the publish project resolver
// (now workspace-scoped), and the browse-context repo (isInvited + docsInProject).

import { and, eq, isNull, sql } from "drizzle-orm";
import { annotations, docs, docVersions, projects, user } from "../db/schema";
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
      // onConflictDoNothing covers the ONE unique index on projects — the partial
      // `projects_default_uq` (C-011). A non-default insert never conflicts; a concurrent
      // first-create of a default project does, and the loser gets an empty `returning()`.
      const [row] = await db
        .insert(projects)
        .values({
          workspaceId: input.workspaceId,
          name: input.name,
          ownerId: input.ownerId,
          isDefault: input.isDefault,
        })
        .onConflictDoNothing()
        .returning();
      if (row) return rowToProject(row);
      // Lost the default-project race (AS-027): the winner already inserted the one default
      // for this (workspace, owner). Read it back so both callers converge on the same project.
      const [winner] = await db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.workspaceId, input.workspaceId),
            eq(projects.ownerId, input.ownerId!),
            eq(projects.isDefault, true),
          ),
        )
        .limit(1);
      if (winner) return rowToProject(winner);
      throw new Error("project insert conflicted but no default project found to read back");
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

/** A doc row as the browse route needs it (id + the visibility fields + browse columns). */
export interface ProjectDocRow {
  id: string;
  slug: string;
  title: string;
  kind: "html" | "markdown" | "image";
  ownerId: string | null;
  generalAccess: "restricted" | "anyone_in_workspace" | "anyone_with_link";
  // Browse columns (workspace-project dashboard rows, Anchord-Design columnar layout).
  // Derived in one query via correlated subqueries — no N+1. Honest values: latestVersion is
  // the doc's highest published version number (0 if none yet); annotationCount counts the
  // doc's ACTIVE annotations (deleted_at IS NULL — soft-deleted tombstones excluded, per
  // workspace-project-ui S-007 / C-006); ownerName is the first-publisher's display name.
  latestVersion: number;
  annotationCount: number;
  ownerName: string | null;
  // S-003/AS-022: the doc's own created + last-updated times, so a browse consumer can sort
  // by Created or Updated without a second fetch (workspace-project-browse:S-003). Serialized
  // to ISO strings on the wire.
  createdAt: Date;
  updatedAt: Date;
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
      // Correlated subqueries keep this a single round-trip (no per-doc fan-out): the latest
      // published version, the count of ACTIVE annotations on the doc, and the first-
      // publisher's display name. COALESCE keeps version/count numeric (0) when absent.
      // workspace-project-ui S-007 / C-006: count the doc's ACTIVE annotations — deleted_at
      // IS NULL (soft-deleted excluded) AND dismissed_at IS NULL (dismissed detached excluded,
      // annotation-core S-008/C-013) — so this matches the viewer rail's active read exactly
      // (annotation/repo.ts listByDoc), NOT the comment total across its threads.
      const latestVersion = sql<number>`coalesce((
        select max(${docVersions.version}) from ${docVersions}
        where ${docVersions.docId} = ${docs.id}
      ), 0)`;
      const annotationCount = sql<number>`coalesce((
        select count(*) from ${annotations}
        where ${annotations.docId} = ${docs.id}
          and ${annotations.deletedAt} is null
          and ${annotations.dismissedAt} is null
      ), 0)`;
      const rows = await db
        .select({
          id: docs.id,
          slug: docs.slug,
          title: docs.title,
          kind: docs.kind,
          ownerId: docs.ownerId,
          generalAccess: docs.generalAccess,
          latestVersion,
          annotationCount,
          ownerName: user.name,
          createdAt: docs.createdAt,
          updatedAt: docs.updatedAt,
        })
        .from(docs)
        .leftJoin(user, eq(user.id, docs.ownerId))
        .where(eq(docs.projectId, projectId));
      // Drizzle returns the count/max as strings from postgres.js — coerce to number.
      return rows.map((r) => ({
        ...r,
        latestVersion: Number(r.latestVersion),
        annotationCount: Number(r.annotationCount),
      }));
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
