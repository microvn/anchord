// your-activity-actions S-001: the cross-workspace OWN-ACTIONS read for `GET /api/me/activity`.
//
// Distinct from the workspace-scoped feed (repo.ts listAllActivity): this reads the `activity` table
// filtered to `actorUserId = <session caller>` (C-001 — the actor is ALWAYS the session user, never a
// client-supplied id; a null-actor row never matches because the filter is an equality on the
// caller's id), across EVERY workspace the caller is CURRENTLY a member of (C-006 — an active
// workspace_members join), newest-first. A workspace the caller has LEFT drops out (the inner join
// finds no membership row).
//
// Read-time enrichment (C1 / Data Model): the row stores only IDs + denormalized text, NOT the
// workspace name or doc title. This read joins `workspaceId → workspaces.name` so each row carries
// its `workspaceName` label (AS-002), the same idea your-activity-inbox's read-repo uses. The doc
// title + project name are enriched separately by the route's `enrichRows` (shared with the
// workspace feed). Recent-first by (createdAt, id) — served by the (actorUserId, createdAt) index.

import { and, count, desc, eq } from "drizzle-orm";
import { activity, docs, workspaceMembers, workspaces } from "../db/schema";
import type { DB } from "../db/client";
import type { ActivityRow } from "./repo";

/** A read row plus the read-time workspace-name enrichment (AS-002). */
export interface ActorActivityRow extends ActivityRow {
  workspaceId: string;
  workspaceName: string | null;
  /**
   * AS-005: the doc's CURRENT viewer slug, joined at read time, so the reused detail's "Open in doc"
   * link resolves to `/d/:slug`. Null on a workspace-level row (no docId) or a deleted doc. C-002:
   * a row the caller can no longer access has this nulled by the route's genericize pass (NOT here) —
   * the join itself is a plain slug lookup; the access decision stays in ONE place (resolveAccess).
   */
  docSlug: string | null;
}

/** Read + count ports for the cross-workspace own-actions feed. */
export interface ActorActivityRepo {
  /** Total of the caller's own rows across their current workspaces (drives pagination `total`). */
  countForActor(actorUserId: string): Promise<number>;
  /** A page of the caller's own rows, recent-first, current-member workspaces only (C-006). */
  listForActor(
    actorUserId: string,
    opts: { offset: number; limit: number },
  ): Promise<ActorActivityRow[]>;
}

export function createActorActivityRepo(db: DB): ActorActivityRepo {
  // C-001 + C-006: actorUserId = the caller AND an active membership row in the row's workspace.
  // The INNER join on workspace_members(workspaceId,userId=caller) is the current-member filter —
  // a left workspace has no row, so its events drop out.
  const whereActor = (actorUserId: string) =>
    and(eq(activity.actorUserId, actorUserId), eq(workspaceMembers.userId, actorUserId));

  return {
    async countForActor(actorUserId) {
      const [row] = await db
        .select({ n: count() })
        .from(activity)
        .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, activity.workspaceId))
        .where(whereActor(actorUserId));
      return Number(row?.n ?? 0);
    },

    async listForActor(actorUserId, { offset, limit }) {
      const rows = await db
        .select({
          id: activity.id,
          type: activity.type,
          actorUserId: activity.actorUserId,
          actorName: activity.actorName,
          workspaceId: activity.workspaceId,
          workspaceName: workspaces.name,
          docId: activity.docId,
          docSlug: docs.slug,
          projectId: activity.projectId,
          versionId: activity.versionId,
          commentId: activity.commentId,
          annotationId: activity.annotationId,
          summary: activity.summary,
          target: activity.target,
          meta: activity.meta,
          createdAt: activity.createdAt,
        })
        .from(activity)
        .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, activity.workspaceId))
        .leftJoin(workspaces, eq(workspaces.id, activity.workspaceId))
        // AS-005: join the doc's current slug for the "Open in doc" deep-link. leftJoin so a
        // workspace-level row (docId null) or a deleted doc keeps the row with a null slug.
        .leftJoin(docs, eq(docs.id, activity.docId))
        .where(whereActor(actorUserId))
        .orderBy(desc(activity.createdAt), desc(activity.id))
        .offset(offset)
        .limit(limit);
      return rows.map((r) => ({
        id: r.id,
        type: r.type,
        actorUserId: r.actorUserId ?? null,
        actorName: r.actorName,
        workspaceId: r.workspaceId,
        workspaceName: r.workspaceName ?? null,
        docId: r.docId ?? null,
        docSlug: r.docSlug ?? null,
        projectId: r.projectId ?? null,
        versionId: r.versionId ?? null,
        commentId: r.commentId ?? null,
        annotationId: r.annotationId ?? null,
        summary: r.summary ?? null,
        target: r.target ?? null,
        meta: r.meta ?? null,
        createdAt: r.createdAt,
      }));
    },
  };
}
