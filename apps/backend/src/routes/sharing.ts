// HTTP route mount for the sharing-permissions cluster (stories S-001/S-003/S-004).
//
// INTEGRATION GLUE: wires the already-built, unit-tested sharing services
// (src/sharing/share.ts, invite.ts, link-controls.ts) onto Elysia routes per the
// sharing-permissions `## API` contract, composing the api-core HTTP layer
// (envelope + auth gate + Zod validation + existence-hiding). No new sharing
// behaviour lives here — handlers resolve :slug → doc, gate OWNER, call the
// service, and shape the response.
//
// Contract (sharing-permissions ## API — all gated by the manage-sharing gate, C-007):
//   GET  /api/w/:wid/docs/:slug/share → S-006 AS-025/026/027 200 { level, role, editorsCanShare, people[], link{...} }
//   PUT  /api/docs/:slug/access  → S-001 AS-001/002/018      200 { level, role, editorsCanShare }
//   POST /api/docs/:slug/invites → S-003 AS-007/008          201 { status } active|pending
//   PUT  /api/docs/:slug/link    → S-004 AS-009..021         200 { link controls }
//   PATCH  /api/w/:wid/docs/:slug/members/:memberId → S-007 AS-028/031/032 200 { role }
//   DELETE /api/w/:wid/docs/:slug/members/:memberId → S-007 AS-029/030/031/032 200 { removed: true }
//
// EXISTENCE-HIDING (C-006): every route resolves :slug → a VISIBLE doc or 404 FIRST
// (missing doc OR a doc the caller cannot view both collapse to 404), BEFORE the
// manage-sharing gate — so managing sharing on an invisible doc is 404, never 403. 403
// is reserved for a VISIBLE doc whose caller may not manage sharing.
//
// MANAGE-SHARING GATE (C-007, Google-Docs model): the gate is
// `canManageSharing({ role: resolveDocRole(...), editorsCanShare })` — owner always;
// editor when the doc's editors_can_share toggle is on (AS-014) and denied when off
// (AS-023); viewer/commenter never (AS-024). The editors_can_share toggle ITSELF is
// owner-only (C-015/AS-022): PUT access carrying `editorsCanShare` from a non-owner →
// 403.
//
// OWNER SOURCE SEAM: `resolveDocRole(docId,userId)` resolves the effective role; the
// owner SOURCE is the remaining auth seam (no ownership column yet — see
// resolve-doc-role-repo.ts). Tests inject a resolver that returns the role under test.

import { Elysia } from "elysia";
import { z } from "zod";
import { apiEnvelope } from "../http/envelope";
import {
  requireSession,
  requireWorkspaceMember,
  type SessionResolver,
  type WorkspaceRoleResolver,
} from "../http/auth-gate";
import { withValidation } from "../http/validate";
import { ValidationError, ForbiddenError, NotFoundError, ConflictError } from "../http/errors";
import { enforceReadAccess } from "../http/access-result";
import { canViewDoc, type AccessDeps, type Viewer } from "../sharing/access";
import { type Role, canManageSharing } from "../sharing/roles";
import { setGeneralAccess, ShareRejected, type ShareRepo } from "../sharing/share";
import { createShareRepo, rotateCapabilityToken } from "../sharing/share-repo";
import { inviteByEmail, type DocMemberRepo, type EnqueuedInvite, type InviteDeps } from "../sharing/invite";
import { createDocMemberRepo, findUserByEmail, createEnqueueInvite } from "../sharing/doc-member-repo";
import { setPassword } from "../sharing/link-controls";
import {
  setLinkControls,
  type LinkControlsUpdate,
  type PersistedLinkControls,
} from "../sharing/link-controls-repo";
import { readShareState, type ShareStateRepo } from "../sharing/share-state";
import { createShareStateRepo } from "../sharing/share-state-repo";
import { createDocLookupRepo, type DocLookupRepo, type ResolveDocRole } from "./versions";
import { createLoadShareConfig } from "../sharing/resolve-doc-role-repo";
import { MailQueue, type MailTransport } from "../auth/mail-queue";
import { notifyOnInvited, type NotifyRepo } from "../notify/notify";
import { createNotifyRepo } from "../notify/repo";
import type { DB } from "../db/client";

// ── Zod request schemas ─────────────────────────────────────────────────────

const accessBodySchema = z.object({
  level: z.enum(["restricted", "anyone_in_workspace", "anyone_with_link"]),
  // `role` shape is validated loosely here (string) so an invalid value (AS-018)
  // surfaces as the service's ShareRejected → 400, matching the contract's wording.
  role: z.string(),
  // C-015/AS-022: owner-only toggle. Present → the actor wants to change it; a non-owner
  // sending it is 403 (gated below), an owner's change threads through to the service.
  editorsCanShare: z.boolean().optional(),
});

const inviteBodySchema = z.object({
  email: z.string().email(),
  role: z.enum(["viewer", "commenter", "editor"]),
  message: z.string().optional(),
});

// S-007 (AS-028): a member's new role is one of viewer|commenter|editor; "owner" is
// never an assignable role (C-012/C-017) → an invalid value is a 400 from Zod.
const memberRoleBodySchema = z.object({
  role: z.enum(["viewer", "commenter", "editor"]),
});

// S-004 (AS-009/010/011 set; clear via null — see C-001 "each control independently
// clearable"). Each control is `.nullable().optional()`: omitted leaves it unchanged at
// the call site (the handler only writes what the body carries), `null` CLEARS it. The FE
// sends `null` to clear (apps/web/.../sharing/services/client.ts). `.nullable()` short-
// circuits BEFORE coercion, so `expiresAt: null` stays null and is NEVER coerced to
// `new Date(null)` (epoch-0, 1970-01-01) — a clear must not silently expire the link.
export const linkBodySchema = z.object({
  password: z.string().nullable().optional(),
  // ISO datetime string → Date; an invalid string is a 400 from Zod. null clears (stays null).
  expiresAt: z.coerce.date().nullable().optional(),
  viewLimit: z.number().int().positive().nullable().optional(),
});

export interface SharingRoutesDeps {
  /** Drizzle handle — builds the concrete repos per request. */
  db?: DB;
  /** Pre-built repos (tests). Win over `db`. */
  shareRepo?: ShareRepo;
  docMemberRepo?: DocMemberRepo;
  lookupRepo?: DocLookupRepo;
  /** S-006 read aggregator port (people list + link state). Built from `db` when omitted. */
  shareStateRepo?: ShareStateRepo;
  /** invite.ts ports — injectable for tests; built from `db`/mail in prod. */
  findUserByEmail?: (email: string) => { id: string } | null;
  enqueueInvite?: (msg: EnqueuedInvite) => void;
  /**
   * notifications-email S-005 (AS-010): the in-app notify repo used to write the invitee's
   * `invited` row when an EXISTING account is invited. Optional: built from `db` when omitted;
   * absent (no `db`, no inject) → the invite still works, just no in-app notice (tests).
   */
  notifyRepo?: NotifyRepo;
  /** Resolves the better-auth session → actor; gates every route (401 if none). */
  resolveSession: SessionResolver;
  /** workspaces S-006: resolves the caller's role in :workspaceId for the path-scoped gate. */
  resolveWorkspaceRole: WorkspaceRoleResolver;
  /** Doc-scoped effective-role resolver; the manage-sharing gate reads this (seam: owner source). */
  resolveDocRole: ResolveDocRole;
  /**
   * workspace-project S-002 (AS-012/C-007): the workspace-admin override for the
   * manage-sharing gate. When the doc's owner (M) is removed from the workspace, M can no
   * longer manage its sharing — the workspace ADMIN becomes the fallback manager. This
   * override lets an admin manage ANY doc's sharing in the workspace regardless of the
   * doc-scoped role. Optional: omit (→ `() => false`) to keep the pure Google-Docs gate
   * (no admin override) — every existing test/cluster behaves as before.
   *
   * workspaces S-006/C-002: now SCOPED to the doc's workspace (the :workspaceId path the
   * gate proved membership for) — `(workspaceId, userId)`, never "admin of any workspace".
   */
  isWorkspaceAdmin?: (workspaceId: string, userId: string) => Promise<boolean>;
  /**
   * Reads the doc's per-doc share toggles — the manage-sharing gate needs
   * `editorsCanShare` (C-007). Optional: built from `db` when omitted. Tests inject a
   * fake.
   */
  loadShareConfig?: (docId: string) => Promise<{ editorsCanShare: boolean }>;
  /**
   * S-004 link-controls persister. Optional: defaults to the real Drizzle `setLinkControls`
   * over `db`. Tests inject a fake to assert the route maps cleared controls (null) through
   * the handler without a real Postgres.
   */
  setLinkControls?: (docId: string, update: LinkControlsUpdate) => Promise<PersistedLinkControls>;
  /** Access deps for `canViewDoc` (existence-hiding). */
  accessDeps: AccessDeps;
  /** Mail wiring for the real enqueueInvite (prod). Omitted in tests (enqueueInvite injected). */
  mailQueue?: MailQueue;
  mailTransport?: MailTransport;
  /**
   * APP_SECRET — keys the accept-link token the invite mail carries (AS-011/C-009). Only
   * read when building the real enqueueInvite from `db`+mail; tests inject `enqueueInvite`
   * directly so they never need it. Defaults to a constant when omitted (link is still
   * well-formed; prod always passes the real secret).
   */
  secret?: string;
}

export function sharingRoutes(deps: SharingRoutesDeps) {
  const need = (name: string): never => {
    throw new Error(`sharingRoutes requires \`${name}\` or \`db\``);
  };
  const shareRepo = deps.shareRepo ?? (deps.db ? createShareRepo(deps.db) : need("shareRepo"));
  const docMemberRepo =
    deps.docMemberRepo ?? (deps.db ? createDocMemberRepo(deps.db) : need("docMemberRepo"));
  const lookupRepo = deps.lookupRepo ?? (deps.db ? createDocLookupRepo(deps.db) : need("lookupRepo"));
  // S-006: resolved LAZILY (only the GET …/share route uses it) so existing callers that
  // wire the write routes without `db`/`shareStateRepo` (route tests) keep working.
  const shareStateRepo = (): ShareStateRepo =>
    deps.shareStateRepo ?? (deps.db ? createShareStateRepo(deps.db) : need("shareStateRepo"));
  const loadShareConfig =
    deps.loadShareConfig ?? (deps.db ? createLoadShareConfig(deps.db) : need("loadShareConfig"));

  // invite.ts's findUserByEmail port is SYNC; over Drizzle it must be async. We resolve
  // it per-request in the handler (await) and pass a resolved closure to the service.
  const inviteSecret = deps.secret ?? "anchord-invite-token";
  const enqueueInvite =
    deps.enqueueInvite ??
    (deps.mailQueue && deps.mailTransport
      ? createEnqueueInvite(deps.mailQueue, deps.mailTransport, inviteSecret)
      : deps.db
        ? createEnqueueInvite(new MailQueue(), noopTransport(), inviteSecret)
        : need("enqueueInvite"));

  // S-005 (AS-010): the in-app `invited` notifier for the account-exists branch. Built from the
  // notify repo (injected, or from `db`). Absent → no in-app notice (route tests without `db`).
  // `invited` is low-signal so the notify path enqueues NO email — but the MailEnqueuer port is
  // still required, so we hand it a no-op enqueuer (it is never called for a low-signal type).
  const notifyRepo = deps.notifyRepo ?? (deps.db ? createNotifyRepo(deps.db) : undefined);
  const notifyInvited = notifyRepo
    ? async (userId: string, refId: string): Promise<void> => {
        await notifyOnInvited(
          { refId, inviteeUserId: userId },
          { repo: notifyRepo, mail: { enqueue: () => "noop" } },
        );
      }
    : undefined;

  /** Resolve :slug → a visible DocLookup or throw 404 (existence-hiding, C-006). */
  async function loadVisibleDoc(slug: string, userId: string) {
    const doc = await lookupRepo.findDocBySlug(slug);
    const viewer: Viewer = { kind: "user", userId };
    const allowed =
      doc !== null &&
      canViewDoc({ docId: doc.id, generalAccess: doc.generalAccess, viewer, deps: deps.accessDeps }).allowed;
    return enforceReadAccess({ doc, allowed });
  }

  /**
   * Manage-sharing gate (C-007, Google-Docs model): a VISIBLE doc whose caller may not
   * manage sharing → 403. Owner always passes; an editor passes only when the doc's
   * editors_can_share is on (AS-014/AS-023); viewer/commenter never (AS-024). Returns
   * the resolved role so the access route can apply the owner-only toggle guard (C-015).
   */
  async function requireManageSharing(
    workspaceId: string,
    docId: string,
    userId: string,
  ): Promise<Role> {
    // AS-012/C-007: a workspace admin overrides the doc-scoped gate (the fallback
    // manager when the doc's owner is removed). Resolve it first so an admin passes even
    // when they hold no doc-scoped role at all. The admin acts AS the owner for sharing.
    // workspaces C-002: the admin check is scoped to THIS workspace, never "any".
    const isWsAdmin = deps.isWorkspaceAdmin ?? (async () => false);
    if (await isWsAdmin(workspaceId, userId)) {
      return "owner";
    }
    const role: Role | null = await deps.resolveDocRole(docId, userId);
    const { editorsCanShare } = role
      ? await loadShareConfig(docId)
      : { editorsCanShare: false };
    if (!role || !canManageSharing({ role, editorsCanShare })) {
      throw new ForbiddenError();
    }
    return role;
  }

  return (
    apiEnvelope(new Elysia())
      .use(requireSession({ resolveSession: deps.resolveSession }))
      .use(requireWorkspaceMember({ resolveWorkspaceRole: deps.resolveWorkspaceRole }))

      // ── GET /api/w/:workspaceId/docs/:slug/share — S-006 (read share state for the dialog) ──
      // C-016: gated IDENTICALLY to the management writes (requireManageSharing) and
      // NEVER returns the link password — the aggregator exposes hasPassword only.
      .get("/api/w/:workspaceId/docs/:slug/share", async ({ params, actor, ws }) => {
        const doc = await loadVisibleDoc(params.slug, actor.userId); // 404 if missing/hidden
        // 403 if the caller may not manage sharing (AS-027 / C-016) — same gate as writes. The
        // resolved role is also returned as `viewerRole` so the dialog's owner-only gate (C-003)
        // works from any entry point (the docs-list ⋯ preloads no effectiveRole).
        const viewerRole = await requireManageSharing(ws.workspaceId, doc.id, actor.userId);
        return readShareState(doc.id, params.slug, shareStateRepo(), viewerRole);
      })

      // ── PUT /api/docs/:slug/access — S-001 (general access + link role) ──
      .group("", (app) =>
        app
          .use(withValidation(accessBodySchema))
          .put("/api/w/:workspaceId/docs/:slug/access", async ({ params, actor, ws, validBody }) => {
            const body = validBody as z.infer<typeof accessBodySchema>;
            const doc = await loadVisibleDoc(params.slug, actor.userId); // 404 if missing/hidden
            // 403 if the caller may not manage sharing (AS-014/AS-023/AS-024).
            const role = await requireManageSharing(ws.workspaceId, doc.id, actor.userId);
            const actorIsOwner = role === "owner";
            // C-015/AS-022: a non-owner carrying editorsCanShare → 403 (owner-only toggle),
            // before the service write. (The service guards this too — belt + braces.)
            if (body.editorsCanShare !== undefined && !actorIsOwner) {
              throw new ForbiddenError();
            }
            try {
              const result = await setGeneralAccess(
                doc.id,
                {
                  level: body.level,
                  // role validity (AS-018) is the service's guard → ShareRejected → 400.
                  role: body.role as never,
                  editorsCanShare: body.editorsCanShare,
                },
                shareRepo,
                { actorIsOwner },
              );
              return {
                level: result.level,
                role: result.role,
                editorsCanShare: result.editorsCanShare,
              };
            } catch (err) {
              // AS-018 invalid role → 400 VALIDATION_ERROR.
              if (err instanceof ShareRejected) throw new ValidationError(err.message);
              throw err;
            }
          }),
      )

      // ── POST /api/docs/:slug/invites — S-003 (invite by email) ──
      .group("", (app) =>
        app
          .use(withValidation(inviteBodySchema))
          .post("/api/w/:workspaceId/docs/:slug/invites", async ({ params, actor, ws, validBody, set }) => {
            const body = validBody as z.infer<typeof inviteBodySchema>;
            const doc = await loadVisibleDoc(params.slug, actor.userId);
            await requireManageSharing(ws.workspaceId, doc.id, actor.userId);
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
              // S-005 (AS-010): in-app notice to a bound invitee (account-exists branch only).
              notifyInvited,
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
            // Return the new doc_members row id so the FE can target PATCH/DELETE on the
            // just-invited row immediately (AS-022 — remove a freshly invited pending person).
            return { status: result.status, id: result.id };
          }),
      )

      // ── PUT /api/docs/:slug/link — S-004 (password / expiry / view-limit controls) ──
      .group("", (app) =>
        app
          .use(withValidation(linkBodySchema))
          .put("/api/w/:workspaceId/docs/:slug/link", async ({ params, actor, ws, validBody }) => {
            const body = validBody as z.infer<typeof linkBodySchema>;
            const doc = await loadVisibleDoc(params.slug, actor.userId);
            await requireManageSharing(ws.workspaceId, doc.id, actor.userId);
            // Hash the password (argon2id, C-010) before it ever touches the DB; an
            // empty/omitted password clears it (null).
            const passwordHash =
              body.password != null && body.password.length > 0
                ? await setPassword(body.password)
                : null;
            const persist =
              deps.setLinkControls ??
              (deps.db
                ? (docId: string, update: LinkControlsUpdate) =>
                    setLinkControls(deps.db!, docId, update)
                : need("setLinkControls"));
            const persisted = await persist(doc.id, {
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

      // ── POST /api/w/:workspaceId/docs/:slug/link/rotate — S-004 (regenerate the capability link) ──
      // C-004 / AS-011: an EXPLICIT owner action that REPLACES the live capability token with a
      // fresh one while general access stays anyone_with_link and the link role is UNCHANGED — so
      // the old link is permanently dead and every admission cookie minted from it is refused
      // (its bound token-hash no longer matches). Gated by the SAME manage-sharing gate as
      // set-general-access (GAP-002): owner always, an editor when editors_can_share is on,
      // viewer/commenter never (→ 403). Existence-hide first (404), then the gate (403).
      // Edge (C-004): rotating a doc that is NOT anyone_with_link has no link to rotate → 409,
      // not a crash.
      .post("/api/w/:workspaceId/docs/:slug/link/rotate", async ({ params, actor, ws }) => {
        const doc = await loadVisibleDoc(params.slug, actor.userId); // 404 if missing/hidden
        await requireManageSharing(ws.workspaceId, doc.id, actor.userId); // 403 if not a manager
        if (!deps.db) {
          throw new Error("sharingRoutes rotate route requires `db` to replace the token");
        }
        const result = await rotateCapabilityToken(deps.db, doc.id);
        if (!result.rotated) {
          // Nothing to rotate — the doc is not anyone_with_link (no capability link).
          throw new ConflictError("Doc is not shared via a capability link — nothing to rotate");
        }
        // The fresh token is the new secret; the SPA re-reads /share to surface the new /s/<token>.
        return { rotated: true };
      })

      // ── PATCH /api/w/:workspaceId/docs/:slug/members/:memberId — S-007 (change a member's role) ──
      // Gated IDENTICALLY to the other management writes (C-017): existence-hide → 404,
      // then requireManageSharing → 403 for a non-manager (AS-031). The owner has no
      // doc_members row, so a non-member memberId (owner / member of another doc) → repo
      // returns null → 404 (AS-032 owner-protection holds structurally).
      .group("", (app) =>
        app
          .use(withValidation(memberRoleBodySchema))
          .patch(
            "/api/w/:workspaceId/docs/:slug/members/:memberId",
            async ({ params, actor, ws, validBody }) => {
              const body = validBody as z.infer<typeof memberRoleBodySchema>;
              const doc = await loadVisibleDoc(params.slug, actor.userId); // 404 if missing/hidden
              await requireManageSharing(ws.workspaceId, doc.id, actor.userId); // 403 if not a manager
              const updated = await docMemberRepo.updateRole(params.memberId, doc.id, body.role);
              if (!updated) throw new NotFoundError(); // not an active member of THIS doc (AS-032)
              return { role: updated.role };
            },
          ),
      )

      // ── DELETE /api/w/:workspaceId/docs/:slug/members/:memberId — S-007 (remove member / revoke invite) ──
      // Same gate as PATCH. Removing an active member (AS-029) or a pending invite (AS-030)
      // is the SAME delete — a pending invite IS a doc_members row. A memberId that isn't a
      // row of THIS doc (owner / other doc) → repo returns false → 404 (AS-032).
      .delete(
        "/api/w/:workspaceId/docs/:slug/members/:memberId",
        async ({ params, actor, ws }) => {
          const doc = await loadVisibleDoc(params.slug, actor.userId); // 404 if missing/hidden
          await requireManageSharing(ws.workspaceId, doc.id, actor.userId); // 403 if not a manager
          const removed = await docMemberRepo.remove(params.memberId, doc.id);
          if (!removed) throw new NotFoundError(); // not a member of THIS doc (AS-032)
          return { removed: true };
        },
      )
  );
}

/** A no-op MailTransport so the prod enqueueInvite degrades gracefully when no real
 *  transport is wired yet (the mail cluster owns the live transport selection). */
function noopTransport(): MailTransport {
  return { async send() {} };
}
