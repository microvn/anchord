// Drizzle-backed DocDeleteRepo (doc-delete-trash S-001). THIN glue between the soft-delete
// service (doc-delete.ts) and Postgres. No business logic lives here — the composed gate,
// the emit-on-change decision, and the existence-hiding rule are in the service; this only
// reads/writes rows.
//
//  - findDocBySlug   → the target doc (id/slug) by slug. Returns the row REGARDLESS of its
//                      tombstone state: idempotency (C-006) is enforced by the conditional
//                      UPDATE in softDelete (WHERE deleted_at IS NULL), not by hiding the row
//                      here — so a second delete still RESOLVES the doc, then changes 0 rows.
//  - workspaceOfDoc  → the doc's OWN workspace (project_id → projects.workspace_id), captured
//                      at delete time (C-005). Null when the doc has no project / no workspace.
//  - softDelete      → the CONDITIONAL tombstone: set deleted_at + deleted_workspace_id WHERE
//                      id = :id AND deleted_at IS NULL. Returns rows changed (0 when already
//                      tombstoned — C-006). Writes ONLY the two tombstone columns; versions/
//                      annotations/comments are untouched (C-001 — soft-delete preserves all).
//
// Integration-verified against real Postgres in a later story's *.itest.ts.

import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { docs, projects, shareLinks } from "../db/schema";
import type { DB } from "../db/client";
import type { DocDeleteRepo, DeletableDoc, RestorableDoc, TrashEntry } from "./doc-delete";
import { ensureDefaultProject } from "./projects";
import { createProjectRepo } from "./repo";
import { rotateCapabilityTokenForLinkAxis } from "../sharing/share-token";

/** Construct a DocDeleteRepo backed by a Drizzle DB handle. */
export function createDocDeleteRepo(db: DB): DocDeleteRepo {
  return {
    async findDocBySlug(slug: string): Promise<DeletableDoc | null> {
      const [row] = await db
        .select({ id: docs.id, slug: docs.slug })
        .from(docs)
        .where(eq(docs.slug, slug))
        .limit(1);
      return row ?? null;
    },

    async workspaceOfDoc(docId: string): Promise<string | null> {
      // The doc's OWN workspace via its project (C-005). Inner-join projects so a project-less
      // doc (project_id null) resolves to null — there is no workspace to anchor the Trash row.
      const [row] = await db
        .select({ workspaceId: projects.workspaceId })
        .from(docs)
        .innerJoin(projects, eq(projects.id, docs.projectId))
        .where(eq(docs.id, docId))
        .limit(1);
      return row?.workspaceId ?? null;
    },

    async softDelete(docId, deletedAt, deletedWorkspaceId): Promise<number> {
      // C-006: conditional tombstone — only an ACTIVE doc (deleted_at IS NULL) is changed. The
      // returned row count is the idempotency / emit-on-change signal (0 = already tombstoned).
      // Postgres returns the affected-row count on `result.count` for postgres-js.
      const result = await db
        .update(docs)
        .set({ deletedAt, deletedWorkspaceId })
        .where(and(eq(docs.id, docId), isNull(docs.deletedAt)));
      // Drizzle's postgres-js update result carries the affected count (it is array-like with a
      // `.count`); normalise to a number defensively.
      return (result as unknown as { count?: number }).count ?? 0;
    },

    // ── doc-delete-trash S-003: Trash list + restore ────────────────────────────────────

    async listTrash(workspaceId): Promise<TrashEntry[]> {
      // C-007: only THIS workspace's tombstones — `deleted_at IS NOT NULL AND
      // deleted_workspace_id = :workspaceId`. Active docs are excluded by the NOT NULL predicate;
      // other workspaces' tombstones by the workspace match (AS-026). Most-recent first.
      const rows = await db
        .select({
          id: docs.id,
          slug: docs.slug,
          title: docs.title,
          deletedAt: docs.deletedAt,
          ownerId: docs.ownerId,
        })
        .from(docs)
        .where(and(isNotNull(docs.deletedAt), eq(docs.deletedWorkspaceId, workspaceId)))
        .orderBy(desc(docs.deletedAt));
      // deletedAt is non-null here (the WHERE guarantees it); narrow defensively.
      return rows
        .filter((r): r is typeof r & { deletedAt: Date } => r.deletedAt != null)
        .map((r) => ({
          id: r.id,
          slug: r.slug,
          title: r.title,
          deletedAt: r.deletedAt,
          ownerId: r.ownerId ?? null,
        }));
    },

    async findDeletedById(workspaceId, docId): Promise<RestorableDoc | null> {
      // C-007: a DELETED doc in THIS workspace's Trash only. A doc in another workspace's Trash, or
      // an active doc, returns null → the route 404s (AS-025). project_id / owner_id may be null.
      const [row] = await db
        .select({
          id: docs.id,
          slug: docs.slug,
          projectId: docs.projectId,
          ownerId: docs.ownerId,
          deletedWorkspaceId: docs.deletedWorkspaceId,
        })
        .from(docs)
        .where(
          and(
            eq(docs.id, docId),
            isNotNull(docs.deletedAt),
            eq(docs.deletedWorkspaceId, workspaceId),
          ),
        )
        .limit(1);
      if (!row || row.deletedWorkspaceId == null) return null;
      return {
        id: row.id,
        slug: row.slug,
        projectId: row.projectId ?? null,
        ownerId: row.ownerId ?? null,
        deletedWorkspaceId: row.deletedWorkspaceId,
      };
    },

    async restore(docId, targetProjectId): Promise<number> {
      // C-006: conditional un-tombstone — only a DELETED doc (deleted_at IS NOT NULL) changes a
      // row. Clears both tombstone columns and reparents to the resolved target project (C-004).
      // The returned count is the idempotency / emit-on-change signal (0 = already active, AS-027).
      const result = await db
        .update(docs)
        .set({ deletedAt: null, deletedWorkspaceId: null, projectId: targetProjectId })
        .where(and(eq(docs.id, docId), isNotNull(docs.deletedAt)));
      return (result as unknown as { count?: number }).count ?? 0;
    },

    async resetShareAxesPrivate(docId): Promise<void> {
      // C-008: restore comes back PRIVATE. Both axes off (workspace_role / link_role null) AND the
      // capability token rotated, so the previously-shared /s/<token> URL is permanently dead until
      // the doc is re-shared. Upsert so a doc without a share_links row still ends up private.
      const token = rotateCapabilityTokenForLinkAxis(null); // link axis is being turned off → null
      await db
        .insert(shareLinks)
        .values({ docId, workspaceRole: null, linkRole: null, capabilityToken: token })
        .onConflictDoUpdate({
          target: shareLinks.docId,
          set: { workspaceRole: null, linkRole: null, capabilityToken: token },
        });
    },

    async ensureDefaultProject(input): Promise<string> {
      // C-004 fallback: the RESTORING actor's default project in the doc's deleted_workspace_id,
      // created if absent (idempotent). Reuses the project service so naming + uniqueness match.
      const project = await ensureDefaultProject(
        { workspaceId: input.workspaceId, ownerId: input.ownerId, userName: input.userName },
        { repo: createProjectRepo(db) },
      );
      return project.id;
    },

    async projectExists(workspaceId, projectId): Promise<boolean> {
      const [row] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
        .limit(1);
      return row != null;
    },

    // ── doc-delete-trash S-007: permanent (hard) delete from Trash ──────────────────────
    async purgeDeleted(workspaceId, docId): Promise<number> {
      // C-007: only a DELETED doc in THIS workspace's Trash is reachable — the WHERE matches
      // `deleted_at IS NOT NULL AND deleted_workspace_id = :workspaceId`. An active doc
      // (deleted_at IS NULL) or another workspace's tombstone matches nothing → 0 rows changed,
      // so an active doc can never be hard-deleted through this path.
      //
      // CASCADE: the doc's versions / annotations / comments / share_links (and doc_members,
      // anchor_resolution) are all `on delete cascade` from docs.id in the schema, so deleting the
      // single doc row removes every child — nothing is left orphaned (C-001's preservation is
      // deliberately reversed here: this is the permanent-removal escape hatch). The activity rows
      // RETAIN their doc_id (no FK on docs) by design (workspace-activity C-001), so the audit trail
      // survives. The whole delete runs in ONE transaction so a partial purge can't happen.
      const result = await db.transaction(async (tx) => {
        return tx
          .delete(docs)
          .where(
            and(
              eq(docs.id, docId),
              isNotNull(docs.deletedAt),
              eq(docs.deletedWorkspaceId, workspaceId),
            ),
          );
      });
      return (result as unknown as { count?: number }).count ?? 0;
    },
  };
}
