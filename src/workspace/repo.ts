// Drizzle-backed WorkspaceRepo (workspace-project S-001). THIN glue between the
// bootstrap service (setup.ts) and Postgres. No business logic lives here; the
// single-workspace rule, name validation, and slug derivation run in the service.
//
// The ONE thing this layer owns is the RACE-SAFE single-workspace guard (C-001):
// createWorkspaceWithAdmin re-counts inside the transaction and refuses if a
// workspace already exists, so two concurrent setup calls cannot both insert — the
// loser sees the winner's row and throws SetupRejected("already_set_up"). This is
// portable (a count-then-insert in a tx), NOT a Postgres-only partial-unique trick,
// so a future SQLite build stays open. The unique slug is a second backstop.
//
// Integration-verified against real Postgres in test/integration/workspace-setup.itest.ts.

import { and, eq, isNull, sql } from "drizzle-orm";
import { docs, projects, user, workspaces, workspaceMembers } from "../db/schema";
import type { DB } from "../db/client";
import {
  SetupRejected,
  type WorkspaceRepo,
  type CreatedWorkspace,
} from "./setup";
import { ensureDefaultProject, ProjectRejected, type ProjectRepo, type ProjectRow } from "./projects";
import { activeRolesFor } from "../sharing/doc-member-repo";

/** Construct a WorkspaceRepo backed by a Drizzle DB handle. */
export function createWorkspaceRepo(db: DB): WorkspaceRepo {
  return {
    async countWorkspaces(): Promise<number> {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(workspaces);
      return row?.n ?? 0;
    },

    async createWorkspaceWithAdmin(input): Promise<CreatedWorkspace> {
      return db.transaction(async (tx) => {
        // C-001 in-tx guard: re-check zero workspaces under the transaction so a
        // concurrent setup loser refuses instead of inserting a second workspace.
        const [{ n }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(workspaces);
        if ((n ?? 0) > 0) {
          throw new SetupRejected("instance already set up", "already_set_up");
        }

        const [ws] = await tx
          .insert(workspaces)
          .values({ name: input.name, slug: input.slug, settings: input.settings })
          .returning({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name });

        await tx.insert(workspaceMembers).values({
          workspaceId: ws.id,
          userId: input.adminUserId,
          role: "admin",
        });

        return {
          workspaceId: ws.id,
          slug: ws.slug,
          name: ws.name,
          adminUserId: input.adminUserId,
        };
      });
    },

    async currentWorkspaceId(): Promise<string | null> {
      const [row] = await db.select({ id: workspaces.id }).from(workspaces).limit(1);
      return row?.id ?? null;
    },

    async addMember(workspaceId, userId, role): Promise<void> {
      // Idempotent on (workspace_id, user_id) via the composite unique index: a
      // re-run (e.g. a retried signup hook) is a no-op, never a duplicate row.
      await db
        .insert(workspaceMembers)
        .values({ workspaceId, userId, role })
        .onConflictDoNothing({
          target: [workspaceMembers.workspaceId, workspaceMembers.userId],
        });
    },

    async userName(userId): Promise<string | null> {
      const [row] = await db
        .select({ name: user.name })
        .from(user)
        .where(eq(user.id, userId));
      return row?.name ?? null;
    },
  };
}

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
 * Workspace-context reads the projects route group needs (workspace-project S-003):
 * the single workspace id, the actor's admin flag, workspace membership, individual
 * invite (active doc_members), and the docs in a project. Thin Drizzle glue.
 */
export interface ProjectsRouteRepo {
  currentWorkspaceId(): Promise<string | null>;
  isAdmin(workspaceId: string, userId: string): Promise<boolean>;
  isWorkspaceMember(userId: string): Promise<boolean>;
  isInvited(docId: string, userId: string): Promise<boolean>;
  docsInProject(projectId: string): Promise<ProjectDocRow[]>;
}

export function createProjectsRouteRepo(db: DB): ProjectsRouteRepo {
  return {
    async currentWorkspaceId(): Promise<string | null> {
      const [row] = await db.select({ id: workspaces.id }).from(workspaces).limit(1);
      return row?.id ?? null;
    },
    async isAdmin(workspaceId, userId): Promise<boolean> {
      const [row] = await db
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, userId),
          ),
        );
      return row?.role === "admin";
    },
    async isWorkspaceMember(userId): Promise<boolean> {
      const [row] = await db
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, userId))
        .limit(1);
      return !!row;
    },
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
 * Concrete ProjectResolver for the publish path (workspace-project S-003,
 * AS-005 / C-009 / the MCP-missing-projectId fallback).
 *
 *  - requested projectId present → it must exist in the SINGLE workspace; a bogus or
 *    foreign id throws ProjectRejected("not_found") (the route → 404). NEVER silently
 *    falls back to default for a supplied-but-invalid id (anti-forgery / edge contract).
 *  - requested projectId omitted → the publisher's default project, creating it on the
 *    fly if somehow absent (ensureDefaultProject is idempotent), so a publish always
 *    lands in a real project even for an MCP call with no projectId.
 */
export function createPublishProjectResolver(db: DB) {
  const projectRepo = createProjectRepo(db);
  return async (args: { ownerId: string; requestedProjectId?: string | null }): Promise<string> => {
    const [ws] = await db.select({ id: workspaces.id }).from(workspaces).limit(1);
    if (!ws) {
      throw new ProjectRejected("instance is not set up", "not_found");
    }
    if (args.requestedProjectId != null) {
      const project = await projectRepo.findById(ws.id, args.requestedProjectId);
      if (!project) {
        // Supplied-but-invalid: reject, do NOT default (distinguishes from "omitted").
        throw new ProjectRejected("project not found in this workspace", "not_found");
      }
      return project.id;
    }
    const [u] = await db.select({ name: user.name }).from(user).where(eq(user.id, args.ownerId));
    const def = await ensureDefaultProject(
      { workspaceId: ws.id, ownerId: args.ownerId, userName: u?.name ?? "My" },
      { repo: projectRepo },
    );
    return def.id;
  };
}
