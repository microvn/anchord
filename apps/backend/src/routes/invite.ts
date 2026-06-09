// HTTP route mount for the invite accept-link (auth S-005 — AS-011 / harden H6 / C-009).
//
// "The pending invite is still acceptable via an in-app/shareable link that does not
// depend on the email arriving." acceptInviteByLink (src/auth/invite.ts) is built +
// unit-tested but had no endpoint — this mounts it.
//
// Contract:
//   POST /api/invite/accept { inviteId, token } — auth: session.
//   Success: 200 { status: "active", docId, role }.
//   Refusals (bad token / wrong actor email / not pending / unknown invite) → 200
//     { status: "not_accepted" } — deliberately uniform so the endpoint never reveals
//     whether an inviteId exists or whose email it targets (no enumeration oracle).
//   Errors: 401 (no session), 400 VALIDATION_ERROR (bad body).
//
// SECURITY BOUNDARY (mirrors onEmailVerified): the accepting EMAIL is the SERVER-resolved
// session actor's verified email, NEVER a body-supplied email. The body carries only the
// inviteId + token from the link; identity comes from the session. So a signed-in user
// can only claim an invite that was issued to THEIR own verified email — handing the link
// to the wrong person does not let them claim it (AS-009 family).
//
// The token is verified by recomputation: the server mints the EXPECTED token for the
// inviteId from APP_SECRET (invite-token.ts) and acceptInviteByLink compares it to the
// presented one. No DB token column needed (see invite-token.ts).

import { Elysia } from "elysia";
import { z } from "zod";
import { apiEnvelope } from "../http/envelope";
import { requireSession, type SessionResolver } from "../http/auth-gate";
import { withValidation } from "../http/validate";
import { acceptInviteByLink, buildAcceptLink, type PendingInviteRepo } from "../auth/invite";
import { mintInviteToken } from "../auth/invite-token";
import { createDocMemberRepo } from "../sharing/doc-member-repo";
import { createDocMembersPendingInviteRepo } from "../sharing/invite";
import type { DB } from "../db/client";

export const acceptInviteBodySchema = z.object({
  inviteId: z.string().min(1, "inviteId is required"),
  token: z.string().min(1, "token is required"),
});

export type AcceptInviteBody = z.infer<typeof acceptInviteBodySchema>;

/** Resolve the session actor's verified email + id (server-side), never the body. */
export type ResolveActorEmail = (
  userId: string,
) => Promise<{ email: string; emailVerified: boolean } | null>;

export interface InviteRoutesDeps {
  db?: DB;
  /** Pre-built pending-invite repo (tests). Wins over `db`. */
  pendingInviteRepo?: PendingInviteRepo;
  resolveSession: SessionResolver;
  /**
   * Resolve the actor's verified email from their user id (SERVER read over the
   * better-auth `user` table). The accepting email + verified gate come from here,
   * never from the request body (anti-forgery, mirrors onEmailVerified's gate).
   */
  resolveActorEmail: ResolveActorEmail;
  /** APP_SECRET — the key the accept-link token is minted/verified with. */
  secret: string;
}

/**
 * Elysia plugin factory for `POST /api/invite/accept`. Self-enveloped + session-gated,
 * mounted outside the /api/auth/* better-auth catch-all (same apiEnvelope →
 * requireSession → withValidation composition as setupRoutes/docsRoutes).
 */
export function inviteRoutes(deps: InviteRoutesDeps) {
  const repo: PendingInviteRepo =
    deps.pendingInviteRepo ??
    (() => {
      if (!deps.db) throw new Error("inviteRoutes requires either `pendingInviteRepo` or `db`");
      return createDocMembersPendingInviteRepo(createDocMemberRepo(deps.db));
    })();

  return apiEnvelope(new Elysia())
    .use(requireSession({ resolveSession: deps.resolveSession }))
    .use(withValidation(acceptInviteBodySchema))
    .post("/api/invite/accept", async ({ validBody, actor }) => {
      const { inviteId, token } = validBody as AcceptInviteBody;

      // SERVER-resolved identity: the accepting email + verified flag come from the
      // session actor, never the body. No account row / no email → cannot accept.
      const me = await deps.resolveActorEmail(actor.userId);
      if (!me) return { status: "not_accepted" as const };

      // The expected token is recomputed from the id + secret (invite-token.ts). Passing
      // it as acceptInviteByLink's expectedToken makes the presented token verifiable
      // without a DB token column; the email-match + verified gate (C-005) lives in
      // acceptInviteByLink and runs against the SERVER email + verified flag.
      const expectedToken = mintInviteToken(inviteId, deps.secret);
      const link = buildAcceptLink(inviteId, token);
      const activated = await acceptInviteByLink(
        link,
        actor.userId,
        me.email,
        me.emailVerified,
        expectedToken,
        repo,
      );

      if (!activated) return { status: "not_accepted" as const };
      return { status: "active" as const, docId: activated.docId, role: activated.role };
    });
}
