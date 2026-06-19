// mcp-roundtrip S-005 — concrete Drizzle/service wiring for the write-back tools.
//
// Maps the tools' injectable ports onto the EXISTING annotation-core services (no new
// behaviour):
//   • addReply       → annotation/reply.ts `addReply` over createCommentRepo (flat thread,
//     C-004). The tool passes the resolved role as `sessionRole`, so the service re-authorizes
//     on the SAME role (can(role,"comment")) — the MCP path is never looser than the web path.
//   • resolveAnnotation → annotation/resolve.ts `setResolution(resolved: true)` over
//     createResolutionRepo. We read the annotation's suggestion/deleted state so the service's
//     proposal-owner-only + deleted-terminal guards (C-003/C-007) apply unchanged.
//   • resolveRole    → the shared authoritative `resolveAccess` (doc-access-routing S-001),
//     exactly the web write path.
//
// This module is THIN glue; the testable logic is in writeback-tools.ts. Kept separate so the
// unit suite never needs a DB.

import { eq } from "drizzle-orm";
import { annotations, comments } from "../../db/schema";
import type { DB } from "../../db/client";
import type { Viewer } from "../../sharing/access";
import type { AccessResult } from "../../sharing/resolve-access";
import type { Role } from "../../sharing/roles";
import { addReply } from "../../annotation/reply";
import { setResolution } from "../../annotation/resolve";
import { createCommentRepo, createResolutionRepo } from "../../annotation/repo";
import type { SuggestionStatus } from "../../annotation/suggestion";
import { writebackTools, type WritebackPorts } from "./writeback-tools";
import type { ToolDef } from "../server";

/**
 * Concrete write-back ports over the annotations + comments tables + the annotation-core
 * services. `resolveAccess` is the single authoritative per-doc gate; the reply/resolve
 * services run their own role + proposal + deleted guards against the role the tool resolved.
 */
export function createMcpWritebackPorts(deps: {
  db: DB;
  resolveAccess: (docId: string, viewer: Viewer) => Promise<AccessResult>;
}): WritebackPorts {
  const { db, resolveAccess } = deps;
  const commentRepo = createCommentRepo(db);
  const resolutionRepo = createResolutionRepo(db);

  return {
    async findCommentTarget(commentId) {
      // Join the comment to its annotation to get the doc for the per-doc authz gate.
      const [row] = await db
        .select({ annotationId: comments.annotationId, docId: annotations.docId })
        .from(comments)
        .innerJoin(annotations, eq(comments.annotationId, annotations.id))
        .where(eq(comments.id, commentId))
        .limit(1);
      return row ?? null;
    },

    async findAnnotationDoc(annotationId) {
      const [row] = await db
        .select({ docId: annotations.docId })
        .from(annotations)
        .where(eq(annotations.id, annotationId))
        .limit(1);
      return row ?? null;
    },

    async resolveRole(docId, userId): Promise<Role | null> {
      const viewer: Viewer = { kind: "user", userId };
      const { role } = await resolveAccess(docId, viewer);
      return role;
    },

    async addReply(input) {
      // Reuse annotation-core addReply (flat thread — C-004). sessionRole is the role the tool
      // already resolved, so the service re-authorizes on the SAME role (can(role,"comment")).
      const res = await addReply(
        {
          annotationId: input.annotationId,
          parentCommentId: input.parentCommentId,
          body: input.body,
          author: { kind: "user", userId: input.userId },
          sessionRole: input.sessionRole,
        },
        commentRepo,
      );
      return res.created
        ? { created: true, id: res.id, parentId: res.parentId }
        : { created: false, reason: res.reason };
    },

    async resolveAnnotation(input) {
      // Read the annotation's suggestion + deleted state so setResolution's proposal-owner-only
      // (C-003) and deleted-terminal (C-007) guards apply unchanged — a suggestion is a proposal.
      const [row] = await db
        .select({
          type: annotations.type,
          suggestionStatus: annotations.suggestionStatus,
          deletedAt: annotations.deletedAt,
        })
        .from(annotations)
        .where(eq(annotations.id, input.annotationId))
        .limit(1);
      const isProposal = row?.type === "suggestion";
      const res = await setResolution(
        {
          annotationId: input.annotationId,
          resolved: true, // S-005: the agent marks feedback HANDLED (resolve, never reopen).
          sessionRole: input.sessionRole,
          isProposal,
          suggestionStatus: (row?.suggestionStatus as SuggestionStatus | null) ?? undefined,
          deleted: row?.deletedAt != null,
        },
        resolutionRepo,
      );
      return res.ok ? { ok: true, status: res.status } : { ok: false, reason: res.reason };
    },
  };
}

/** Build the concrete write-back tool registry fragment for the MCP server. */
export function createWritebackToolsForDb(deps: {
  db: DB;
  resolveAccess: (docId: string, viewer: Viewer) => Promise<AccessResult>;
}): Record<string, ToolDef> {
  return writebackTools(createMcpWritebackPorts(deps));
}
