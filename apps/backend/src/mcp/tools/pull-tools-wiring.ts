// mcp-roundtrip S-004 — concrete Drizzle/service wiring for the pull/read tools.
//
// Maps the tools' injectable ports onto the EXISTING annotation-core model (db/schema.ts
// annotations + comments) + the shared resolveAccess gate (no new behaviour):
//   • resolveRole → the shared authoritative `resolveAccess` (doc-access-routing S-001),
//     exactly the web read path (AS-010.T1).
//   • listAllByDoc / listAllCommentsByDoc → direct reads that, UNLIKE annotation-core's
//     active-list `listByDoc`, do NOT exclude soft-deleted / dismissed rows — pull must
//     surface a removed/dismissed annotation's status to the agent (AS-007), not drop it.
//
// This module is THIN glue; the testable logic is in pull-tools.ts. Kept separate so the
// unit suite never needs a DB.

import { and, asc, desc, eq, gt, isNull, or, type SQL } from "drizzle-orm";
import { annotations, comments, user } from "../../db/schema";
import type { DB } from "../../db/client";
import type { Anchor } from "../../annotation/annotation";
import type { SuggestionPayload, SuggestionStatus } from "../../annotation/suggestion";
import type { Viewer } from "../../sharing/access";
import type { AccessResult } from "../../sharing/resolve-access";
import type { Role } from "../../sharing/roles";
import {
  pullTools,
  type PullCursor,
  type PullFilter,
  type PullPorts,
  type PullAnnotationRow,
  type PullCommentRow,
} from "./pull-tools";
import type { ToolDef } from "../server";

/**
 * Concrete pull ports over the annotations + comments tables. The key difference from
 * annotation-core's `listByDoc`/`listCommentsByDoc`: those filter out `deleted_at`/
 * `dismissed_at` (the active rail read); pull deliberately INCLUDES them and reports them as
 * status flags (AS-007: "including resolved, orphaned, dismissed"), so an agent sees the full
 * picture, not a silently truncated list.
 */
export function createMcpPullPorts(deps: {
  db: DB;
  resolveAccess: (docId: string, viewer: Viewer) => Promise<AccessResult>;
}): PullPorts {
  const { db, resolveAccess } = deps;
  return {
    async resolveRole(docId: string, userId: string): Promise<Role | null> {
      const viewer: Viewer = { kind: "user", userId };
      const { role } = await resolveAccess(docId, viewer);
      return role;
    },

    async listAllByDoc(
      docId: string,
      cursor?: PullCursor | null,
      filter?: PullFilter | null,
    ): Promise<PullAnnotationRow[]> {
      const cols = {
        id: annotations.id,
        type: annotations.type,
        anchor: annotations.anchor,
        status: annotations.status,
        isOrphaned: annotations.isOrphaned,
        suggestion: annotations.suggestion,
        suggestionStatus: annotations.suggestionStatus,
        deletedAt: annotations.deletedAt,
        dismissedAt: annotations.dismissedAt,
        updatedAt: annotations.updatedAt,
      };
      // AS-007 / C-004: with NO filter, pull surfaces EVERY annotation's status (default
      // unchanged). A supplied filter narrows server-side via extra WHERE conditions:
      //   status → eq(status); type → eq(type); include*===false → exclude that state.
      // The include* flags default true (kept), so a row is excluded ONLY when its flag is
      // explicitly false. Mirrors applyPullFilter (pull-tools.ts) one-to-one.
      const filterConds: SQL[] = [];
      if (filter?.status !== undefined) filterConds.push(eq(annotations.status, filter.status));
      if (filter?.type !== undefined) filterConds.push(eq(annotations.type, filter.type));
      if (filter?.includeOrphaned === false) filterConds.push(eq(annotations.isOrphaned, false));
      if (filter?.includeDismissed === false) filterConds.push(isNull(annotations.dismissedAt));
      if (filter?.includeDeleted === false) filterConds.push(isNull(annotations.deletedAt));

      // AS-008 / C-017: with a cursor, return ONLY rows whose (updated_at, id) is strictly
      // greater, ordered by (updated_at, id) ASC — the changed-since query. The lexicographic
      // predicate is `updated_at > c.updatedAt OR (updated_at = c.updatedAt AND id > c.id)`;
      // the (doc_id, updated_at, id) index serves it ordered. The filter conditions compose
      // with it (AS-007). Without a cursor, the full set newest-first (the original behavior).
      const rows = cursor
        ? await db
            .select(cols)
            .from(annotations)
            .where(
              and(
                eq(annotations.docId, docId),
                or(
                  gt(annotations.updatedAt, new Date(cursor.updatedAt)),
                  and(
                    eq(annotations.updatedAt, new Date(cursor.updatedAt)),
                    gt(annotations.id, cursor.id),
                  ),
                ),
                ...filterConds,
              ),
            )
            .orderBy(asc(annotations.updatedAt), asc(annotations.id))
        : await db
            .select(cols)
            .from(annotations)
            .where(and(eq(annotations.docId, docId), ...filterConds))
            .orderBy(desc(annotations.createdAt));
      return rows.map((r) => ({
        id: r.id,
        type: r.type,
        anchor: r.anchor as Anchor,
        status: r.status,
        isOrphaned: r.isOrphaned,
        dismissed: r.dismissedAt != null,
        deleted: r.deletedAt != null,
        suggestion: (r.suggestion as SuggestionPayload | null) ?? null,
        suggestionStatus: (r.suggestionStatus as SuggestionStatus | null) ?? null,
        updatedAt: r.updatedAt.getTime(),
      }));
    },

    async listAllCommentsByDoc(docId: string): Promise<PullCommentRow[]> {
      const rows = await db
        .select({
          id: comments.id,
          annotationId: comments.annotationId,
          parentId: comments.parentId,
          authorName: user.name,
          guestName: comments.guestName,
          body: comments.body,
          createdAt: comments.createdAt,
        })
        .from(comments)
        .innerJoin(annotations, eq(comments.annotationId, annotations.id))
        .leftJoin(user, eq(comments.authorId, user.id))
        // AS-007: include comments on deleted/dismissed annotations too — the agent reads the
        // full thread alongside that annotation's status (no active-list exclusion here).
        .where(eq(annotations.docId, docId))
        .orderBy(asc(comments.createdAt));
      return rows.map((r) => ({
        id: r.id,
        annotationId: r.annotationId,
        parentId: r.parentId,
        ...(r.authorName != null ? { authorName: r.authorName } : {}),
        ...(r.guestName != null ? { guestName: r.guestName } : {}),
        body: r.body,
        createdAt: r.createdAt.toISOString(),
      }));
    },
  };
}

/** Build the concrete pull tool registry fragment for the MCP server. */
export function createPullToolsForDb(deps: {
  db: DB;
  resolveAccess: (docId: string, viewer: Viewer) => Promise<AccessResult>;
}): Record<string, ToolDef> {
  return pullTools(createMcpPullPorts(deps));
}
