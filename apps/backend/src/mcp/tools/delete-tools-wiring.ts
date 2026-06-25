// doc-delete-trash S-005 — concrete service/Drizzle wiring for the MCP delete/restore tools.
//
// Maps the tools' injectable ports onto the EXISTING soft-delete/restore services
// (workspace/doc-delete.ts) + a workspace-scoped id-or-slug resolver. NO new tombstone/restore
// logic lives here — softDelete/restore call `deleteDoc`/`restoreDoc` directly:
//   • resolveInWorkspace → resolve a doc by id OR slug, scoped to the TOKEN's workspace (C-007).
//     A doc's workspace is its project's workspace while ACTIVE, and `deleted_workspace_id` once
//     TOMBSTONED (project_id can be nulled by project deletion) — so the resolver coalesces both,
//     covering delete (active) and restore (deleted) with one query. A doc in another workspace
//     resolves to null → not-found (AS-029).
//   • softDelete → `deleteDoc` with the per-doc role from resolveAccess and NO admin arm
//     (isWorkspaceAdmin omitted — owner-or-editor only over MCP, C-003 / S-005 § MCP gate).
//   • restore → `restoreDoc`, also no admin arm; the service is itself workspace-scoped
//     (findDeletedById) and applies the private-on-restore reset (AS-031).
//
// This module is THIN glue; the testable logic is in delete-tools.ts. Kept separate so the unit
// suite never needs a DB.

import { eq, or, sql } from "drizzle-orm";
import { docs, projects } from "../../db/schema";
import type { DB } from "../../db/client";
import { deleteDoc, restoreDoc, type DocDeleteRepo } from "../../workspace/doc-delete";
import { createDocDeleteRepo } from "../../workspace/doc-delete-repo";
import type { Viewer } from "../../sharing/access";
import type { AccessResult } from "../../sharing/resolve-access";
import type { Role } from "../../sharing/roles";
import type { ActivityEmitDeps } from "../../activity/emit";
import { createActivityRepo } from "../../activity/repo";
import { deleteTools, type DeleteToolsPorts, type ResolvedDeletableDoc } from "./delete-tools";
import type { ToolDef } from "../server";

export interface DeleteToolsWiringDeps {
  db: DB;
  /** The shared authoritative per-doc gate (doc-access-routing S-001) — the per-doc arm of the gate. */
  resolveAccess: (docId: string, viewer: Viewer) => Promise<AccessResult>;
  /**
   * The restoring/deleting actor's display name — names the restorer's default project on the
   * C-004 fallback AND enriches the doc_deleted / doc_restored activity rows. When provided, a
   * best-effort post-commit activity emit is wired (the repo is built from `db`); omitted → no emit.
   */
  resolveActorName?: (userId: string) => Promise<string | null>;
}

/**
 * Concrete delete/restore ports. The role gate is resolveAccess (per-doc only — no workspace-admin
 * arm over MCP, C-003); softDelete/restore delegate to the EXISTING services. resolveInWorkspace is
 * the C-007 binding: a doc is resolved (by id or slug) ONLY when it lives in the token's workspace.
 */
export function createMcpDeleteToolsPorts(deps: DeleteToolsWiringDeps): DeleteToolsPorts {
  const { db, resolveAccess } = deps;
  const repo: DocDeleteRepo = createDocDeleteRepo(db);
  const resolveDocRole = async (docId: string, userId: string): Promise<Role | null> => {
    const viewer: Viewer = { kind: "user", userId };
    const { role } = await resolveAccess(docId, viewer);
    return role;
  };
  // Best-effort post-commit activity emit (doc_deleted / doc_restored, C-006). Wired only when a
  // name resolver is provided; the repo is built from `db` (mirrors routes/docs.ts). The service
  // emits ONLY when its conditional update changed a row, so there's no double-emit on retry.
  const activity: ActivityEmitDeps | undefined = deps.resolveActorName
    ? { repo: createActivityRepo(db), resolveActorName: deps.resolveActorName }
    : undefined;

  return {
    async resolveInWorkspace(idOrSlug, workspaceId): Promise<ResolvedDeletableDoc | null> {
      // The doc's workspace is its project's workspace while active, and deleted_workspace_id once
      // tombstoned. Coalesce both, then bind to the token's workspace (C-007 / AS-029). Resolves a
      // doc REGARDLESS of tombstone state (delete needs active; restore needs deleted).
      const [row] = await db
        .select({
          id: docs.id,
          slug: docs.slug,
          // active: project's workspace; deleted: the captured deleted_workspace_id.
          workspaceId: sql<string | null>`coalesce(${projects.workspaceId}, ${docs.deletedWorkspaceId})`,
        })
        .from(docs)
        .leftJoin(projects, eq(projects.id, docs.projectId))
        .where(or(eq(docs.id, idOrSlug), eq(docs.slug, idOrSlug)))
        .limit(1);
      if (!row || row.workspaceId == null) return null;
      // Bind to the token's workspace — a doc in another workspace is unreachable (AS-029).
      if (row.workspaceId !== workspaceId) return null;
      return { id: row.id, slug: row.slug, workspaceId: row.workspaceId };
    },

    async softDelete(input) {
      // The EXISTING soft-delete service (workspace/doc-delete.ts). NO isWorkspaceAdmin — MCP is
      // owner-or-editor only (C-003). Idempotent + emit-on-change are the service's job (C-006).
      return deleteDoc(input, {
        repo,
        resolveDocRole,
        activity,
      });
    },

    async restore(input) {
      // The EXISTING restore service. Workspace-scoped (findDeletedById), restorer-default fallback,
      // private-on-restore reset (AS-031), idempotent. NO admin arm over MCP (C-003).
      return restoreDoc(input, {
        repo,
        resolveDocRole,
        resolveActorName: deps.resolveActorName,
        activity,
      });
    },
  };
}

/** Build the concrete delete/restore tool registry fragment for the MCP server. */
export function createDeleteToolsForDb(deps: DeleteToolsWiringDeps): Record<string, ToolDef> {
  return deleteTools(createMcpDeleteToolsPorts(deps));
}
