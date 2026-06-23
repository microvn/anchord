// HTTP route mount for the per-workspace member directory + role management
// (workspaces S-005). All routes live under /api/w/:workspaceId/members and are gated
// by requireWorkspaceMember (a non-member is 404, existence-hiding). The admin-only
// operations re-check ws.role === "admin" via the tenancy service (which throws
// forbidden for a non-admin). Identity is the SERVER session actor — never the body.
//
// Contract (workspaces S-005):
//   GET    /api/w/:workspaceId/members              → 200 { members, invitations }   (AS-021, admin)
//   DELETE /api/w/:workspaceId/members/:userId      → 200 { userId, removed }         (AS-014/016/017, admin)
//   PATCH  /api/w/:workspaceId/members/:userId { role } → 200 { userId, role }        (AS-015/016/017, admin)
//
// Errors: 401 (no session), 404 (non-member of the workspace OR target not a member),
//         403 FORBIDDEN (non-admin), 409 CONFLICT (last admin), 400 VALIDATION_ERROR.

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
import { NotFoundError, ConflictError, ForbiddenError } from "../http/errors";
import {
  listWorkspaceMembers,
  removeWorkspaceMember,
  changeMemberRole,
  TenancyRejected,
  type TenancyRepo,
} from "../workspace/tenancy";
import { createTenancyRepo } from "../workspace/tenancy-repo";
import type { DB } from "../db/client";
import { notifyOnWorkspaceMemberRemoved, type NotifyRepo, type MailEnqueuer } from "../notify/notify";
import { createNotifyRepo } from "../notify/repo";

export const changeRoleBodySchema = z.object({
  role: z.enum(["admin", "member"]),
});

export interface MembersRoutesDeps {
  db?: DB;
  /** Pre-built tenancy repo (tests). Wins over `db`. */
  repo?: TenancyRepo;
  resolveSession: SessionResolver;
  resolveWorkspaceRole: WorkspaceRoleResolver;
  /**
   * workspace-notifications S-003: the notify seam for the removed-member notice (in-app + email).
   * The dispatch is POST-COMMIT + BEST-EFFORT (never fails the removal, C-004/AS-008). `repo`
   * defaults to a Drizzle NotifyRepo built from `db`; `mail` carries the email channel
   * (workspace_member_removed is high-signal). `appUrl` builds the workspace-shaped email deep-link.
   * Omit entirely to disable the notice (a route test that asserts only the removal contract).
   */
  notify?: { repo?: NotifyRepo; mail: MailEnqueuer; appUrl?: string };
}

/** Map a TenancyRejected onto the right HTTP DomainError. */
function mapRejected(err: TenancyRejected): NotFoundError | ConflictError | ForbiddenError {
  switch (err.code) {
    case "not_member":
    case "not_found":
      return new NotFoundError(err.message);
    case "sole_admin":
      return new ConflictError(err.message);
    case "forbidden":
      return new ForbiddenError(err.message);
    default:
      return new ForbiddenError(err.message);
  }
}

export function membersRoutes(deps: MembersRoutesDeps) {
  const repo: TenancyRepo =
    deps.repo ??
    (() => {
      if (!deps.db) throw new Error("membersRoutes requires either `repo` or `db`");
      return createTenancyRepo(deps.db);
    })();

  // workspace-notifications S-003: the notify repo for the post-commit removed-member notice. Built
  // from `db` when a `notify` dep is present but its repo isn't injected (prod); undefined disables
  // the notice (route tests that only assert the removal contract).
  const notifyRepo: NotifyRepo | undefined =
    deps.notify?.repo ?? (deps.notify && deps.db ? createNotifyRepo(deps.db) : undefined);

  return apiEnvelope(new Elysia())
    .use(requireSession({ resolveSession: deps.resolveSession }))
    .use(requireWorkspaceMember({ resolveWorkspaceRole: deps.resolveWorkspaceRole }))
    // GET — the member directory + pending invitations (admin-only, AS-021).
    .get("/api/w/:workspaceId/members", async ({ actor, ws }) => {
      try {
        return await listWorkspaceMembers(
          { workspaceId: ws.workspaceId, actorId: actor.userId },
          { repo },
        );
      } catch (err) {
        if (err instanceof TenancyRejected) throw mapRejected(err);
        throw err;
      }
    })
    // DELETE — remove a member (admin-only; ≥1-admin invariant — AS-014/016/017).
    .delete("/api/w/:workspaceId/members/:userId", async ({ params, actor, ws }) => {
      // workspace-notifications S-003 (F1/C-003/AS-006): snapshot the workspace NAME + the target's
      // EMAIL BEFORE the membership delete — post-delete they are unreadable via membership joins,
      // and the removed user must still be reachable. Best-effort: a snapshot read that throws must
      // not block the removal, so it is guarded and the notice is simply skipped on failure.
      let snapshot: { workspaceName: string; recipientEmail: string | null } | null = null;
      if (notifyRepo && deps.notify) {
        try {
          const wsRow = await repo.findWorkspace(ws.workspaceId);
          const recipientEmail = await notifyRepo.getUserEmail(params.userId);
          snapshot = { workspaceName: wsRow?.name ?? "", recipientEmail };
        } catch {
          // best-effort: a failed pre-delete snapshot never blocks the removal (C-004).
        }
      }

      try {
        await removeWorkspaceMember(
          { workspaceId: ws.workspaceId, actorId: actor.userId, targetUserId: params.userId },
          { repo },
        );
      } catch (err) {
        if (err instanceof TenancyRejected) throw mapRejected(err);
        throw err;
      }

      // POST-COMMIT, BEST-EFFORT (C-004/AS-008): the removal has succeeded; notify the removed user
      // in-app + email using the PRE-delete snapshot. A notify failure never rolls back the removal
      // (the dispatch swallows internally; the extra guard is belt-and-braces).
      if (notifyRepo && deps.notify && snapshot) {
        try {
          await notifyOnWorkspaceMemberRemoved(
            {
              workspaceId: ws.workspaceId,
              removedUserId: params.userId,
              workspaceName: snapshot.workspaceName,
              recipientEmail: snapshot.recipientEmail,
              actorUserId: actor.userId,
            },
            { repo: notifyRepo, mail: deps.notify.mail, appUrl: deps.notify.appUrl },
          );
        } catch {
          // best-effort: never surface a notify failure on the removal response (C-004/AS-008).
        }
      }

      return { userId: params.userId, removed: true };
    })
    // PATCH — change a member's role (admin-only; ≥1-admin invariant — AS-015/016/017).
    .patch("/api/w/:workspaceId/members/:userId", async ({ params, body, actor, ws }) => {
      const { role } = validateBody(changeRoleBodySchema, body);
      try {
        const res = await changeMemberRole(
          { workspaceId: ws.workspaceId, actorId: actor.userId, targetUserId: params.userId, role },
          { repo },
        );
        return { userId: res.userId, role: res.role };
      } catch (err) {
        if (err instanceof TenancyRejected) throw mapRejected(err);
        throw err;
      }
    });
}
