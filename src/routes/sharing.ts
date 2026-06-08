// HTTP route mount for the sharing-permissions cluster (stories S-001/S-003/S-004).
//
// INTEGRATION GLUE: wires the already-built, unit-tested sharing services
// (src/sharing/share.ts, invite.ts, link-controls.ts) onto Elysia routes per the
// sharing-permissions `## API` contract, composing the api-core HTTP layer
// (envelope + auth gate + Zod validation + existence-hiding). No new sharing
// behaviour lives here — handlers resolve :slug → doc, gate OWNER, call the
// service, and shape the response.
//
// Contract (sharing-permissions ## API — all three are owner-only, C-007):
//   PUT  /api/docs/:slug/access  → S-001 AS-001/002/003/018  200 { level, role, guestCommenting }
//   POST /api/docs/:slug/invites → S-003 AS-007/008          201 { status } active|pending
//   PUT  /api/docs/:slug/link    → S-004 AS-009..021         200 { link controls }
//
// EXISTENCE-HIDING (C-006): every route resolves :slug → a VISIBLE doc or 404 FIRST
// (missing doc OR a doc the caller cannot view both collapse to 404), BEFORE the owner
// gate — so managing sharing on an invisible doc is 404, never 403. 403 is reserved
// for a VISIBLE doc whose role is below owner (AS-014: an editor cannot manage sharing).
//
// OWNER GATE SEAM: the owner check is `resolveDocRole(docId,userId) === "owner"`. The
// owner SOURCE is the remaining auth seam (no ownership column yet — see
// resolve-doc-role-repo.ts). Tests inject a resolver that returns "owner"; live
// owner-enforcement lands when auth adds the ownership column.

import { Elysia } from "elysia";
import { z } from "zod";
import { apiEnvelope } from "../http/envelope";
import { requireSession, type SessionResolver } from "../http/auth-gate";
import { withValidation } from "../http/validate";
import { ValidationError, ForbiddenError } from "../http/errors";
import { enforceReadAccess } from "../http/access-result";
import { canViewDoc, type AccessDeps, type Viewer } from "../sharing/access";
import { type Role } from "../sharing/roles";
import { setGeneralAccess, ShareRejected, type ShareRepo } from "../sharing/share";
import { createShareRepo } from "../sharing/share-repo";
import { inviteByEmail, type DocMemberRepo, type EnqueuedInvite, type InviteDeps } from "../sharing/invite";
import { createDocMemberRepo, findUserByEmail, createEnqueueInvite } from "../sharing/doc-member-repo";
import { setPassword } from "../sharing/link-controls";
import { setLinkControls } from "../sharing/link-controls-repo";
import { createDocLookupRepo, type DocLookupRepo, type ResolveDocRole } from "./versions";
import { MailQueue, type MailTransport } from "../auth/mail-queue";
import type { DB } from "../db/client";

// ── Zod request schemas ─────────────────────────────────────────────────────

const accessBodySchema = z.object({
  level: z.enum(["restricted", "anyone_in_workspace", "anyone_with_link"]),
  // `role` shape is validated loosely here (string) so an invalid value (AS-018)
  // surfaces as the service's ShareRejected → 400, matching the contract's wording.
  role: z.string(),
  guestCommenting: z.boolean().optional(),
});

const inviteBodySchema = z.object({
  email: z.string().email(),
  role: z.enum(["viewer", "commenter", "editor"]),
  message: z.string().optional(),
});

const linkBodySchema = z.object({
  password: z.string().optional(),
  // ISO datetime string → Date; an invalid string is a 400 from Zod.
  expiresAt: z.coerce.date().optional(),
  viewLimit: z.number().int().positive().optional(),
});

export interface SharingRoutesDeps {
  /** Drizzle handle — builds the concrete repos per request. */
  db?: DB;
  /** Pre-built repos (tests). Win over `db`. */
  shareRepo?: ShareRepo;
  docMemberRepo?: DocMemberRepo;
  lookupRepo?: DocLookupRepo;
  /** invite.ts ports — injectable for tests; built from `db`/mail in prod. */
  findUserByEmail?: (email: string) => { id: string } | null;
  enqueueInvite?: (msg: EnqueuedInvite) => void;
  /** Resolves the better-auth session → actor; gates every route (401 if none). */
  resolveSession: SessionResolver;
  /** Doc-scoped effective-role resolver; the owner gate reads this (seam: owner source). */
  resolveDocRole: ResolveDocRole;
  /** Access deps for `canViewDoc` (existence-hiding). */
  accessDeps: AccessDeps;
  /** Mail wiring for the real enqueueInvite (prod). Omitted in tests (enqueueInvite injected). */
  mailQueue?: MailQueue;
  mailTransport?: MailTransport;
}

export function sharingRoutes(deps: SharingRoutesDeps) {
  const need = (name: string): never => {
    throw new Error(`sharingRoutes requires \`${name}\` or \`db\``);
  };
  const shareRepo = deps.shareRepo ?? (deps.db ? createShareRepo(deps.db) : need("shareRepo"));
  const docMemberRepo =
    deps.docMemberRepo ?? (deps.db ? createDocMemberRepo(deps.db) : need("docMemberRepo"));
  const lookupRepo = deps.lookupRepo ?? (deps.db ? createDocLookupRepo(deps.db) : need("lookupRepo"));

  // invite.ts's findUserByEmail port is SYNC; over Drizzle it must be async. We resolve
  // it per-request in the handler (await) and pass a resolved closure to the service.
  const enqueueInvite =
    deps.enqueueInvite ??
    (deps.mailQueue && deps.mailTransport
      ? createEnqueueInvite(deps.mailQueue, deps.mailTransport)
      : deps.db
        ? createEnqueueInvite(new MailQueue(), noopTransport())
        : need("enqueueInvite"));

  /** Resolve :slug → a visible DocLookup or throw 404 (existence-hiding, C-006). */
  async function loadVisibleDoc(slug: string, userId: string) {
    const doc = await lookupRepo.findDocBySlug(slug);
    const viewer: Viewer = { kind: "user", userId };
    const allowed =
      doc !== null &&
      canViewDoc({ docId: doc.id, generalAccess: doc.generalAccess, viewer, deps: deps.accessDeps }).allowed;
    return enforceReadAccess({ doc, allowed });
  }

  /** Owner gate (C-007): a VISIBLE non-owner → 403 (AS-014). Seam: owner source. */
  async function requireOwner(docId: string, userId: string): Promise<void> {
    const role: Role | null = await deps.resolveDocRole(docId, userId);
    if (role !== "owner") throw new ForbiddenError();
  }

  return (
    apiEnvelope(new Elysia())
      .use(requireSession({ resolveSession: deps.resolveSession }))

      // ── PUT /api/docs/:slug/access — S-001 (general access + link role + guest) ──
      .group("", (app) =>
        app
          .use(withValidation(accessBodySchema))
          .put("/api/docs/:slug/access", async ({ params, actor, validBody }) => {
            const body = validBody as z.infer<typeof accessBodySchema>;
            const doc = await loadVisibleDoc(params.slug, actor.userId); // 404 if missing/hidden
            await requireOwner(doc.id, actor.userId); // 403 if not owner (AS-014)
            try {
              const result = await setGeneralAccess(
                doc.id,
                {
                  level: body.level,
                  // role validity (AS-018) is the service's guard → ShareRejected → 400.
                  role: body.role as never,
                  guestCommenting: body.guestCommenting,
                },
                shareRepo,
              );
              return {
                level: result.level,
                role: result.role,
                guestCommenting: result.guestCommenting,
              };
            } catch (err) {
              // AS-018 invalid role + AS-003 guest-on-restricted → 400 VALIDATION_ERROR.
              if (err instanceof ShareRejected) throw new ValidationError(err.message);
              throw err;
            }
          }),
      )

      // ── POST /api/docs/:slug/invites — S-003 (invite by email) ──
      .group("", (app) =>
        app
          .use(withValidation(inviteBodySchema))
          .post("/api/docs/:slug/invites", async ({ params, actor, validBody, set }) => {
            const body = validBody as z.infer<typeof inviteBodySchema>;
            const doc = await loadVisibleDoc(params.slug, actor.userId);
            await requireOwner(doc.id, actor.userId);
            // findUserByEmail: sync port for the service. Resolve over Drizzle here if no
            // fake was injected, then hand the service a resolved closure.
            const account =
              deps.findUserByEmail != null
                ? deps.findUserByEmail(body.email)
                : deps.db
                  ? await findUserByEmail(deps.db, body.email)
                  : null;
            const inviteDeps: InviteDeps = {
              findUserByEmail: () => account,
              members: docMemberRepo,
              enqueueInvite,
            };
            const result = await inviteByEmail(
              {
                docId: doc.id,
                email: body.email,
                role: body.role,
                message: body.message,
                invitedBy: actor.userId,
              },
              inviteDeps,
            );
            set.status = 201;
            return { status: result.status };
          }),
      )

      // ── PUT /api/docs/:slug/link — S-004 (password / expiry / view-limit controls) ──
      .group("", (app) =>
        app
          .use(withValidation(linkBodySchema))
          .put("/api/docs/:slug/link", async ({ params, actor, validBody }) => {
            const body = validBody as z.infer<typeof linkBodySchema>;
            const doc = await loadVisibleDoc(params.slug, actor.userId);
            await requireOwner(doc.id, actor.userId);
            // Hash the password (argon2id, C-010) before it ever touches the DB; an
            // empty/omitted password clears it (null).
            const passwordHash =
              body.password != null && body.password.length > 0
                ? await setPassword(body.password)
                : null;
            if (!deps.db) {
              throw new Error("sharingRoutes link route requires `db` to persist controls");
            }
            const persisted = await setLinkControls(deps.db, doc.id, {
              passwordHash,
              expiresAt: body.expiresAt ?? null,
              viewLimit: body.viewLimit ?? null,
            });
            return {
              passwordSet: persisted.passwordSet,
              expiresAt: persisted.expiresAt,
              viewLimit: persisted.viewLimit,
              viewCount: persisted.viewCount,
            };
          }),
      )
  );
}

/** A no-op MailTransport so the prod enqueueInvite degrades gracefully when no real
 *  transport is wired yet (the mail cluster owns the live transport selection). */
function noopTransport(): MailTransport {
  return { async send() {} };
}
