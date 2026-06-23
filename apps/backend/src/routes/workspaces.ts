// HTTP route mount for workspace lifecycle + invitations (workspaces S-002/S-004).
// These stay at the TOP level (NOT under /api/w/:workspaceId) — creating a workspace
// or accepting an invite is not scoped to a workspace you already belong to.
//
// Contract:
//   POST /api/workspaces { name }                       → 201 { id, name, slug, role }  (S-002 AS-003)
//   PATCH /api/workspaces/:id { name }                  → 200 { id, name }              (S-002 AS-004/005, admin)
//   POST /api/workspaces/:id/invitations { email, role? } → 201 { id, status }          (S-004 AS-009/013, admin)
//   POST /api/invitations/:id/accept { token }          → 200 { workspaceId, role }     (S-004 AS-010/012)
//   POST /api/invitations/:id/reject { token }          → 200 { rejected: true }        (S-004 AS-011/012)
//   DELETE /api/workspaces/:id/invitations/:invitationId → 200 { revoked: true }         (S-005 AS-017, admin)
//
// Identity (actor.userId + actor email) is SERVER-resolved (anti-forgery). The
// admin check + email-match live in the tenancy service.

import { Elysia } from "elysia";
import { z } from "zod";
import { apiEnvelope } from "../http/envelope";
import { requireSession, type SessionResolver } from "../http/auth-gate";
import { validateBody } from "../http/validate";
import { ValidationError, NotFoundError, ForbiddenError, ConflictError } from "../http/errors";
import {
  createWorkspace,
  renameWorkspace,
  inviteToWorkspace,
  acceptInvitation,
  rejectInvitation,
  revokeWorkspaceInvitation,
  TenancyRejected,
  type TenancyRepo,
} from "../workspace/tenancy";
import { createTenancyRepo } from "../workspace/tenancy-repo";
import { buildWorkspaceAcceptLink } from "../auth/invite";
import { createProjectRepo } from "../workspace/repo";
import type { ProjectRepo } from "../workspace/projects";
import type { DB } from "../db/client";
import { notifyOnWorkspaceInvited, type NotifyRepo, type MailEnqueuer } from "../notify/notify";
import { createNotifyRepo } from "../notify/repo";

export const createWorkspaceBodySchema = z.object({
  name: z.string().min(1, "workspace name is required"),
});
export const renameWorkspaceBodySchema = createWorkspaceBodySchema;
export const inviteBodySchema = z.object({
  email: z.string().email("a valid email is required"),
  role: z.enum(["admin", "member"]).optional(),
});
export const invitationActionBodySchema = z.object({
  token: z.string().min(1, "token is required"),
});

/** Resolve the actor's email from their user id (SERVER read), never the body. */
export type ResolveActorEmail = (userId: string) => Promise<{ email: string } | null>;

export interface WorkspacesRoutesDeps {
  db?: DB;
  repo?: TenancyRepo;
  projectRepo?: ProjectRepo;
  resolveSession: SessionResolver;
  /** Resolve the actor's email for the invite email-match (C-004). */
  resolveActorEmail: ResolveActorEmail;
  /** Records the invite intent (prod: enqueue the invite email with the accept link). */
  enqueueInvite?: (msg: { workspaceId: string; email: string; token: string; invitationId: string }) => void;
  /**
   * workspace-notifications S-001: the notify seam for the in-app bell row on invite. The dispatch
   * is POST-COMMIT + BEST-EFFORT (never fails the invite). `repo` defaults to a Drizzle NotifyRepo
   * built from `db`; `mail` is required by the port but unused for `workspace_invited` (in-app only,
   * C-001 — the invite email is `enqueueInvite`'s job, never duplicated here). Omit entirely to
   * disable the bell notification (e.g. in a route test that asserts only the invite contract).
   */
  notify?: { repo?: NotifyRepo; mail: MailEnqueuer };
}

function mapRejected(
  err: TenancyRejected,
): ValidationError | NotFoundError | ForbiddenError | ConflictError {
  switch (err.code) {
    case "invalid_name":
      return new ValidationError(err.message);
    case "not_found":
    case "not_member":
      return new NotFoundError(err.message);
    case "forbidden":
      return new ForbiddenError(err.message);
    case "sole_admin":
      return new ConflictError(err.message);
    case "email_mismatch":
    case "not_pending":
      // Uniform 404 so the endpoint never reveals whether an invite exists / whose
      // email it targets (no enumeration oracle); the email-match failure is hidden.
      return new NotFoundError("invitation not found");
    default:
      return new ForbiddenError(err.message);
  }
}

export function workspacesRoutes(deps: WorkspacesRoutesDeps) {
  const repo: TenancyRepo =
    deps.repo ??
    (() => {
      if (!deps.db) throw new Error("workspacesRoutes requires either `repo` or `db`");
      return createTenancyRepo(deps.db);
    })();
  const projectRepo: ProjectRepo | undefined =
    deps.projectRepo ?? (deps.db ? createProjectRepo(deps.db) : undefined);
  const tenancyDeps = { repo, projectRepo };

  // workspace-notifications S-001: the notify repo for the post-commit in-app bell row on invite.
  // Built from `db` when a `notify` dep is present but its repo isn't injected (prod); undefined
  // disables the bell notification (route tests that don't exercise it).
  const notifyRepo: NotifyRepo | undefined =
    deps.notify?.repo ?? (deps.notify && deps.db ? createNotifyRepo(deps.db) : undefined);

  return apiEnvelope(new Elysia())
    .use(requireSession({ resolveSession: deps.resolveSession }))
    // POST /api/workspaces — create a workspace; the creator becomes its admin (AS-003).
    .post("/api/workspaces", async ({ body, actor, set }) => {
      const { name } = validateBody(createWorkspaceBodySchema, body);
      try {
        const ws = await createWorkspace({ name, actorId: actor.userId }, tenancyDeps);
        set.status = 201;
        return { id: ws.id, name: ws.name, slug: ws.slug, role: ws.role };
      } catch (err) {
        if (err instanceof TenancyRejected) throw mapRejected(err);
        throw err;
      }
    })
    // PATCH /api/workspaces/:id — rename (admin-only, AS-004/005).
    .patch("/api/workspaces/:id", async ({ params, body, actor }) => {
      const { name } = validateBody(renameWorkspaceBodySchema, body);
      try {
        const ws = await renameWorkspace(
          { workspaceId: params.id, actorId: actor.userId, name },
          tenancyDeps,
        );
        return { id: ws.id, name: ws.name };
      } catch (err) {
        if (err instanceof TenancyRejected) throw mapRejected(err);
        throw err;
      }
    })
    // POST /api/workspaces/:id/invitations — invite by email (admin-only, AS-009/013).
    .post("/api/workspaces/:id/invitations", async ({ params, body, actor, set }) => {
      const { email, role } = validateBody(inviteBodySchema, body);
      try {
        const inv = await inviteToWorkspace(
          { workspaceId: params.id, actorId: actor.userId, email, role },
          tenancyDeps,
        );
        deps.enqueueInvite?.({
          workspaceId: params.id,
          email,
          token: inv.token,
          invitationId: inv.id,
        });
        // workspace-notifications S-001 (C-001/C-002/C-004): POST-COMMIT, BEST-EFFORT in-app bell row.
        // Resolves the invitee's account by email (no account → no row, AS-002), excludes the inviting
        // admin (AS-003), snapshots the workspace name into refLabel (F1). IN-APP ONLY — never sends a
        // second email (the invite email above is the only one). A notify failure never fails the
        // invite (the dispatch swallows internally; the extra guard is belt-and-braces).
        if (notifyRepo && deps.notify) {
          try {
            const ws = await repo.findWorkspace(params.id);
            await notifyOnWorkspaceInvited(
              {
                workspaceId: params.id,
                inviteeEmail: email,
                workspaceName: ws?.name ?? "",
                actorUserId: actor.userId,
              },
              { repo: notifyRepo, mail: deps.notify.mail },
            );
          } catch {
            // best-effort: never surface a notify failure on the invite response (C-004).
          }
        }
        set.status = 201;
        // AS-009/AS-011: surface the accept/reject landing link in the response so the
        // invitee can be reached even if the email is slow/dead-lettered (the admin can
        // copy it). Same link the invite email carries; the FE landing consumes it.
        return {
          id: inv.id,
          status: inv.status,
          acceptLink: buildWorkspaceAcceptLink(inv.id, inv.token, email),
        };
      } catch (err) {
        if (err instanceof TenancyRejected) throw mapRejected(err);
        throw err;
      }
    })
    // POST /api/invitations/:id/accept — accept; email must match (AS-010/012).
    .post("/api/invitations/:id/accept", async ({ params, body, actor }) => {
      const { token } = validateBody(invitationActionBodySchema, body);
      const me = await deps.resolveActorEmail(actor.userId);
      if (!me) throw new NotFoundError("invitation not found");
      try {
        const res = await acceptInvitation(
          { invitationId: params.id, token, actorId: actor.userId, actorEmail: me.email },
          tenancyDeps,
        );
        return { workspaceId: res.workspaceId, role: res.role };
      } catch (err) {
        if (err instanceof TenancyRejected) throw mapRejected(err);
        throw err;
      }
    })
    // POST /api/invitations/:id/reject — reject; leaves no membership (AS-011/012).
    .post("/api/invitations/:id/reject", async ({ params, body, actor }) => {
      const { token } = validateBody(invitationActionBodySchema, body);
      const me = await deps.resolveActorEmail(actor.userId);
      if (!me) throw new NotFoundError("invitation not found");
      try {
        await rejectInvitation({ invitationId: params.id, token, actorEmail: me.email }, tenancyDeps);
        return { rejected: true };
      } catch (err) {
        if (err instanceof TenancyRejected) throw mapRejected(err);
        throw err;
      }
    })
    // DELETE /api/workspaces/:id/invitations/:invitationId — revoke a pending invite
    // (admin-only, AS-017). Admin-authorized (not token-gated like reject); marks it revoked.
    .delete("/api/workspaces/:id/invitations/:invitationId", async ({ params, actor }) => {
      try {
        await revokeWorkspaceInvitation(
          { workspaceId: params.id, actorId: actor.userId, invitationId: params.invitationId },
          tenancyDeps,
        );
        return { revoked: true };
      } catch (err) {
        if (err instanceof TenancyRejected) throw mapRejected(err);
        throw err;
      }
    });
}
