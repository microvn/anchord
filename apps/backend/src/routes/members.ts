// HTTP route mount for the workspace member directory (workspace-project S-002).
//
// "An admin invites and removes members; members cannot manage membership." This is
// INTEGRATION GLUE over the already-unit-tested membership service (src/workspace/
// members.ts). Same api-core composition as projectsRoutes/setupRoutes: apiEnvelope →
// requireSession → (per-handler) requireWorkspaceAdmin. Identity (actor.userId) is
// SERVER-resolved (anti-forgery): the admin check, the invitedBy, and the remove actor
// all come from the session, never the body — a member sending {role:"admin"} is ignored.
//
// Contract (all three are ADMIN-only — C-002/AS-004):
//   GET    /api/members                 → 200 { members: [...] }      (the directory, AS-003)
//   POST   /api/members/invite { email }→ 201 { status }              (invited|already_member, AS-003)
//   DELETE /api/members/:userId         → 200 { userId, removed }     (AS-012/C-007)
//
// Errors: 401 (no session), 403 FORBIDDEN (non-admin — AS-004), 400 VALIDATION_ERROR
//         (bad email), 404 NOT_FOUND (remove a non-member), 409 CONFLICT (remove the
//         sole admin), 404 (instance not set up — no workspace).

import { Elysia } from "elysia";
import { z } from "zod";
import { apiEnvelope } from "../http/envelope";
import { requireSession, requireWorkspaceAdmin, type SessionResolver } from "../http/auth-gate";
import { validateBody } from "../http/validate";
import { NotFoundError, ConflictError } from "../http/errors";
import {
  listMembers,
  inviteMember,
  removeMember,
  MemberRejected,
  type WorkspaceMembersRepo,
  type EnqueuedWorkspaceInvite,
} from "../workspace/members";
import { createWorkspaceMembersRepo, createProjectsRouteRepo, type ProjectsRouteRepo } from "../workspace/repo";
import type { DB } from "../db/client";

export const inviteMemberBodySchema = z.object({
  email: z.string().email("a valid email is required"),
});

export interface MembersRoutesDeps {
  db?: DB;
  /** Pre-built membership repo (tests). Wins over `db`. */
  repo?: WorkspaceMembersRepo;
  /** Pre-built workspace-context repo (tests) — supplies currentWorkspaceId + isAdmin. */
  ctx?: ProjectsRouteRepo;
  resolveSession: SessionResolver;
  /**
   * Records the invite intent (prod: enqueue an invite email via the mail queue). Optional
   * — omit to make invite a pure idempotency check (membership still materializes on the
   * invitee's signup via the live onUserCreated hook).
   */
  enqueueInvite?: (msg: EnqueuedWorkspaceInvite) => void;
}

/** Map a MemberRejected onto the right HTTP DomainError. */
function mapMemberRejected(err: MemberRejected): NotFoundError | ConflictError {
  switch (err.code) {
    case "not_member":
      return new NotFoundError(err.message);
    case "sole_admin":
      return new ConflictError(err.message);
  }
}

export function membersRoutes(deps: MembersRoutesDeps) {
  const repo: WorkspaceMembersRepo =
    deps.repo ??
    (() => {
      if (!deps.db) throw new Error("membersRoutes requires either `repo`/`ctx` or `db`");
      return createWorkspaceMembersRepo(deps.db);
    })();
  const ctx: ProjectsRouteRepo =
    deps.ctx ??
    (() => {
      if (!deps.db) throw new Error("membersRoutes requires either `repo`/`ctx` or `db`");
      return createProjectsRouteRepo(deps.db);
    })();

  /** Resolve the single workspace id or throw 404 (the instance must be set up). */
  async function workspaceId(): Promise<string> {
    const id = await ctx.currentWorkspaceId();
    if (!id) throw new NotFoundError("instance is not set up");
    return id;
  }

  /**
   * C-002/AS-004 admin-gate: throw 403 unless the SESSION actor is a workspace admin.
   * The adminness is the SERVER read (ctx.isAdmin over workspace_members.role), never the
   * body — a member's forged {role:"admin"} can't pass. Resolves the workspace first so a
   * pre-setup instance is a deterministic 404, not a confusing 403.
   */
  async function gateAdmin(actorId: string): Promise<string> {
    const wsId = await workspaceId();
    await requireWorkspaceAdmin({ userId: actorId }, (uid) => ctx.isAdmin(wsId, uid));
    return wsId;
  }

  return apiEnvelope(new Elysia())
    .use(requireSession({ resolveSession: deps.resolveSession }))
    // GET /api/members — the member directory (admin-only, AS-003/AS-004).
    .get("/api/members", async ({ actor }) => {
      const wsId = await gateAdmin(actor.userId);
      const members = await listMembers({ workspaceId: wsId }, { repo });
      return { members };
    })
    // POST /api/members/invite — invite an email as a member (admin-only, AS-003/AS-004).
    .post("/api/members/invite", async ({ body, actor, set }) => {
      const wsId = await gateAdmin(actor.userId);
      const { email } = validateBody(inviteMemberBodySchema, body);
      const result = await inviteMember(
        { workspaceId: wsId, email, invitedBy: actor.userId },
        { repo, enqueueInvite: deps.enqueueInvite },
      );
      set.status = 201;
      return { status: result.status };
    })
    // DELETE /api/members/:userId — remove a member (admin-only, AS-012/C-007).
    .delete("/api/members/:userId", async ({ params, actor }) => {
      const wsId = await gateAdmin(actor.userId);
      try {
        await removeMember(
          { workspaceId: wsId, targetUserId: params.userId, actorId: actor.userId },
          { repo },
        );
        return { userId: params.userId, removed: true };
      } catch (err) {
        if (err instanceof MemberRejected) throw mapMemberRejected(err);
        throw err;
      }
    });
}
