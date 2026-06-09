// HTTP route mount for move/copy a doc between projects (workspace-project S-004).
//
// INTEGRATION GLUE over the already-unit-tested move/copy service
// (src/workspace/doc-move.ts). Same api-core composition as the neighbouring docs/
// projects routes: apiEnvelope → requireSession → inline Zod body validation. Identity
// (actor.userId) is SERVER-resolved (anti-forgery): the move/copy authority comes from
// the session actor's effective role on the SOURCE doc, NEVER from the body.
//
// Contract:
//   POST /api/docs/:slug/move  { projectId } → 200 { docId, slug, projectId }
//        (editor-or-owner on source, or workspace admin; move relocates the doc as-is)
//   POST /api/docs/:slug/copy  { projectId } → 201 { docId, slug, projectId }
//        (any read access on source; copy = NEW doc, new slug, current version as v1,
//         NO annotations/comments — clean copy)
//
// Errors: 400 VALIDATION_ERROR (bad projectId), 401 (no session), 403 FORBIDDEN
//         (visible source, role too low to move), 404 NOT_FOUND (missing/inaccessible
//         source OR a bogus/cross-workspace target — existence-hiding).

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
import { NotFoundError, ForbiddenError } from "../http/errors";
import {
  moveDoc,
  copyDoc,
  DocMoveRejected,
  type DocMoveRepo,
} from "../workspace/doc-move";
import { createDocMoveRepo } from "../workspace/doc-move-repo";
import type { Role } from "../sharing/roles";
import { extractText } from "../render/extract-text";
import type { DB } from "../db/client";

/** Body for both move and copy: the target project to relocate/duplicate INTO. */
export const docMoveBodySchema = z.object({
  projectId: z.string().uuid(),
});

export interface DocMoveRoutesDeps {
  db?: DB;
  /** Pre-built move/copy repo (tests). Wins over `db`. */
  repo?: DocMoveRepo;
  resolveSession: SessionResolver;
  /** workspaces S-006: resolves the caller's role in :workspaceId for the path-scoped gate. */
  resolveWorkspaceRole: WorkspaceRoleResolver;
  /** The actor's effective role on the SOURCE doc (sharing seam). */
  resolveDocRole: (docId: string, userId: string) => Promise<Role | null>;
  /**
   * Whether the actor is an admin of THE DOC'S workspace (admin may move regardless of
   * doc role). workspaces S-006/C-002: scoped to (workspaceId, userId), never "any".
   */
  isWorkspaceAdmin?: (workspaceId: string, userId: string) => boolean | Promise<boolean>;
}

/** Map a DocMoveRejected onto the right HTTP DomainError. */
function mapRejected(err: DocMoveRejected): NotFoundError | ForbiddenError {
  return err.code === "forbidden"
    ? new ForbiddenError(err.message)
    : new NotFoundError(err.message);
}

export function docMoveRoutes(deps: DocMoveRoutesDeps) {
  const repo: DocMoveRepo =
    deps.repo ??
    (() => {
      if (!deps.db) throw new Error("docMoveRoutes requires either `repo` or `db`");
      return createDocMoveRepo(deps.db);
    })();

  // extractText = the publish-time extractor, so the copy's v1 is searchable like a fresh
  // publish. The doc-scoped role resolver is the sharing seam. isWorkspaceAdmin is bound
  // PER-REQUEST to ws.workspaceId (C-002 scoping) below.
  const baseDeps = { repo, resolveDocRole: deps.resolveDocRole, extractText };

  return apiEnvelope(new Elysia())
    .use(requireSession({ resolveSession: deps.resolveSession }))
    .use(requireWorkspaceMember({ resolveWorkspaceRole: deps.resolveWorkspaceRole }))
    // POST /api/docs/:slug/move — relocate the doc as-is (editor/owner/admin).
    .post("/api/w/:workspaceId/docs/:slug/move", async ({ params, body, actor, ws }) => {
      const { projectId } = validateBody(docMoveBodySchema, body);
      const serviceDeps = {
        ...baseDeps,
        isWorkspaceAdmin: deps.isWorkspaceAdmin
          ? (uid: string) => deps.isWorkspaceAdmin!(ws.workspaceId, uid)
          : undefined,
      };
      try {
        const res = await moveDoc(
          { slug: params.slug, targetProjectId: projectId, actorId: actor.userId },
          serviceDeps,
        );
        return { docId: res.docId, slug: res.slug, projectId: res.projectId };
      } catch (err) {
        if (err instanceof DocMoveRejected) throw mapRejected(err);
        throw err;
      }
    })
    // POST /api/docs/:slug/copy — duplicate into another project (any reader).
    .post("/api/w/:workspaceId/docs/:slug/copy", async ({ params, body, actor, ws, set }) => {
      const { projectId } = validateBody(docMoveBodySchema, body);
      const serviceDeps = {
        ...baseDeps,
        isWorkspaceAdmin: deps.isWorkspaceAdmin
          ? (uid: string) => deps.isWorkspaceAdmin!(ws.workspaceId, uid)
          : undefined,
      };
      try {
        const res = await copyDoc(
          { slug: params.slug, targetProjectId: projectId, actorId: actor.userId },
          serviceDeps,
        );
        set.status = 201;
        return { docId: res.docId, slug: res.slug, projectId: res.projectId };
      } catch (err) {
        if (err instanceof DocMoveRejected) throw mapRejected(err);
        throw err;
      }
    });
}
