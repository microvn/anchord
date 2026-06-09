import { loadConfig } from "./config/env";
import { createDb } from "./db/client";
import { createApp } from "./app";
import { createAuth } from "./auth/auth";
import { betterAuthSessionResolver } from "./http/auth-gate";
import {
  createResolveDocRole,
  createLoadShareConfig,
  createIsDocOwner,
} from "./sharing/resolve-doc-role-repo";
import { createProjectsRouteRepo } from "./workspace/repo";
import { MailQueue } from "./auth/mail-queue";
import { createMailTransport } from "./auth/mail-transport";
import { createDocMemberRepo, findUserById } from "./sharing/doc-member-repo";
import { createDocMembersPendingInviteRepo } from "./sharing/invite";

const cfg = loadConfig(); // refuses to start on invalid/missing config (S-002, incl. SMTP C-008)
const { db, dbCheck } = createDb(cfg.DATABASE_URL);

// S-001: better-auth bound to the real Postgres DB; APP_SECRET signs the session cookie.
// S-002: pass through OAuth creds — each provider is configured only when env supplied both.
// Origins better-auth trusts for the CSRF origin check: the backend's own origin, any
// concrete CORS_ORIGIN entries (the deployed frontend), and — in development — the Vite
// dev server so the proxy workflow (web :5173 → backend) signs in. Production same-origin
// is covered by the baseURL origin.
const trustedOrigins = [
  `http://localhost:${cfg.PORT}`,
  ...(cfg.CORS_ORIGIN === "*" ? [] : cfg.CORS_ORIGIN.split(",").map((o) => o.trim())),
  ...(cfg.NODE_ENV === "development" ? ["http://localhost:5173"] : []),
];

// Shared mail queue + the transport selected from cfg.email (the same provider auth,
// invites, and notify all use). Built here (before createAuth) so the auth
// emailVerification block can enqueue verify mail through the same retry/dead-letter path.
const mailQueue = new MailQueue();
const mailTransport = createMailTransport(cfg.email);

// AS-008: the concrete pending-invite repo (sharing-permissions doc_members glue) that
// auth's afterEmailVerification hook drives to activate invites on email verification.
const pendingInviteRepo = createDocMembersPendingInviteRepo(createDocMemberRepo(db));

const auth = createAuth(db, {
  secret: cfg.APP_SECRET,
  baseURL: `http://localhost:${cfg.PORT}`,
  oauth: cfg.oauth,
  trustedOrigins,
  // AS-001/AS-012: send a verification email on sign-up (fixes the live bug where
  // requireEmailVerification:true had no sender → sign-in was permanently blocked).
  // AS-008: on verification, activate any pending invite for that exact email.
  emailVerification: { queue: mailQueue, transport: mailTransport, pendingInviteRepo },
});

const resolveSession = betterAuthSessionResolver(auth);

// workspace-project S-002 closes the membership seam. `workspaceCtx` reads the single
// workspace + real workspace_members, so:
//   - `isWorkspaceMember` (was `() => true`) resolves only for an actual member — correct
//     for anyone_in_workspace access (S-003/S-005 too).
//   - `isWorkspaceAdmin` resolves the single workspace then checks role === "admin"; it
//     drives /api/members' admin-gate (C-002/AS-004) AND the sharing admin-override
//     (AS-012: when a doc's owner is removed, the admin is the fallback share manager).
const workspaceCtx = createProjectsRouteRepo(db);
const isWorkspaceMember = (userId: string) => workspaceCtx.isWorkspaceMember(userId);
const isWorkspaceAdmin = async (userId: string): Promise<boolean> => {
  const wsId = await workspaceCtx.currentWorkspaceId();
  return wsId ? workspaceCtx.isAdmin(wsId, userId) : false;
};

// canViewDoc deps (existence-hiding). These ports are SYNC (canViewDoc is synchronous),
// so they stay permissive in this v0 wiring (treat authenticated users as invited/
// members so a visible doc reads). The AUTHORITATIVE anyone_in_workspace gate that S-002
// tightens is the resolve-doc-role `isWorkspaceMember` seam below (async, reads real
// workspace_members) — that is what decides the link-role for anyone_in_workspace.
// Tightening these sync canViewDoc ports needs an async canViewDoc refactor (out of S-002).
const sharedAccessDeps = {
  isInvited: () => true,
  isWorkspaceMember: () => true,
};

// SHARING SEAMS CLOSED (sharing-permissions). The interim placeholders the earlier
// route clusters used (resolveDocRole → "owner"/"editor"; loadShareConfig → OFF) are
// replaced with the CONCRETE Drizzle resolvers:
//   - resolveDocRole: real effective-role over invited (active doc_members) + link
//     (share_links.role when general-access admits) roles. Highest wins (C-002).
//   - loadShareConfig: reads share_links.guest_commenting.
//
// OWNER-SOURCE SEAM CLOSED (auth-routes S-002, C-003): S-001 added `docs.owner_id`
// (the authenticated publisher), so "is this user the owner" is now resolvable. We wire
// the CONCRETE `createIsDocOwner(db)` (reads docs.owner_id) in place of the old
// `async () => false` placeholder. The owner now folds into effectiveRole → highest wins
// (AS-003/AS-005), so the doc owner manages sharing for real, while a viewer/commenter
// still resolves to their lesser role → denied (AS-004/C-004).
const sharedResolveDocRole = createResolveDocRole(db, {
  isOwner: createIsDocOwner(db), // ← concrete owner read (auth-routes S-002 closes the seam)
  isWorkspaceMember,
});
const concreteLoadShareConfig = createLoadShareConfig(db);

// workspace-project S-002 (AS-012/C-007): the MANAGE-SHARING resolver gates the owner
// source on workspace MEMBERSHIP. We keep docs.owner_id set when a member is removed (no
// destructive owner rewrite — C-007: the doc is untouched), but a non-member owner can no
// longer act AS owner for sharing. So when M (the owner) is removed, M's manage-sharing
// role falls away and the workspace ADMIN (isWorkspaceAdmin override in the sharing gate)
// is the fallback manager. This is sharing-LOCAL: the shared resolver above (versions/
// annotations) is unchanged, so a removed owner still reads their own doc per general
// access — only the manage-sharing authority transfers to the admin.
const docOwner = createIsDocOwner(db);
const sharingResolveDocRole = createResolveDocRole(db, {
  isOwner: async (docId: string, userId: string) =>
    (await docOwner(docId, userId)) && (await isWorkspaceMember(userId)),
  isWorkspaceMember,
});

// workspace-project S-006 notify-on-reply (AS-011 / C-004): reuse the shared MailQueue +
// transport (built above). The notify path only ENQUEUES one mail per recipient; we drive
// delivery to a terminal state in the BACKGROUND (best-effort, post-commit) so a
// slow/failing transport never blocks the HTTP reply. A failed send dead-letters in the
// queue (operator-visible), never surfaced to the replier — matching notifyOnReply's
// best-effort contract.
const notifyMail = {
  enqueue(msg: { to: string; subject: string; body: string }): string {
    const id = mailQueue.enqueue(msg);
    // Fire-and-forget delivery; the queue handles retry/dead-letter. Swallow here so an
    // unhandled rejection can't crash the process (the reply already returned).
    void mailQueue.deliverWithRetry(id, mailTransport).catch((err) => {
      console.error("notify mail delivery failed (dead-lettered)", err);
    });
    return id;
  },
};

const app = createApp({
  dbCheck,
  corsOrigin: cfg.CORS_ORIGIN === "*" ? true : cfg.CORS_ORIGIN.split(","),
  authHandler: auth.handler,
  // render-publish S-001: enveloped, session-gated POST /api/docs over the real DB.
  docs: { db, resolveSession },
  // versioning-diff S-001..S-004: version create/title/history/restore/diff over the real DB.
  versions: {
    db,
    resolveSession,
    resolveDocRole: sharedResolveDocRole,
    accessDeps: sharedAccessDeps,
  },
  // annotation-core S-001..S-007: annotation create/list, reply + guest comment,
  // resolve/reopen, suggestion create/decide over the real DB. Shares the interim
  // role/access seams; guest commenting defaults OFF until the sharing cluster lands.
  annotations: {
    db,
    resolveSession,
    resolveDocRole: sharedResolveDocRole,
    accessDeps: sharedAccessDeps,
    loadShareConfig: concreteLoadShareConfig,
    // S-006: notify thread participants + doc owner on a reply (in-app row via the DB
    // notify repo + one email per recipient through the shared queue). Best-effort.
    notify: { mail: notifyMail },
  },
  // workspace-project S-001: first-run POST /api/setup over the real DB (create the
  // single workspace + claim admin; later signups become members via the auth hook).
  // S-003 (AS-014/C-009): the installer's default project is created here too (db →
  // concrete projectRepo inside setupRoutes).
  setup: { db, resolveSession },
  // workspace-project S-003: project create/list/rename/archive/unarchive/delete +
  // access-filtered browse of docs in a project over the real DB.
  projects: { db, resolveSession },
  // workspace-project S-002: ADMIN-gated member directory (GET /api/members, POST
  // /api/members/invite, DELETE /api/members/:userId). Members cannot manage membership
  // (C-002/AS-004); removing a member deletes only the membership row, never their docs
  // (C-007). Invite enqueue degrades to a no-op here (membership materializes on the
  // invitee's signup via the onUserCreated hook); the mail cluster owns live transport.
  members: { db, resolveSession },
  // workspace-project S-005: GET /api/search over the real DB. Full-text search across
  // accessible docs (title + extracted content + comment bodies), access-filtered
  // (existence-hiding) and optionally project-scoped. FTS SQL isolated in the search repo.
  search: { db, resolveSession },
  // workspace-project S-004: move/copy a doc between projects over the real DB. Move
  // (relocate as-is) needs editor-or-owner on the source — uses the shared concrete
  // resolveDocRole (owner folds in via createIsDocOwner) — or a workspace admin
  // (isWorkspaceAdmin override). Copy (clean duplicate, no annotations — C-008) needs
  // only read access. The move/copy repo + extract-text are built inside the route.
  docMove: {
    db,
    resolveSession,
    resolveDocRole: sharedResolveDocRole,
    isWorkspaceAdmin,
  },
  // sharing-permissions S-001/S-003/S-004: owner-only access/invites/link controls.
  // Owner gate reads the concrete resolver. The invite mail now flows through the shared
  // queue + transport, and the pending-invite mail carries a real accept-link minted with
  // APP_SECRET (AS-011) so the invitee can join even if the verify/invite email fails.
  sharing: {
    db,
    resolveSession,
    // S-002: the membership-gated owner source — a removed owner loses manage-sharing.
    resolveDocRole: sharingResolveDocRole,
    // Manage-sharing gate (C-007) reads editors_can_share from here (reuses the same
    // concrete loader as annotation-core; the superset return shape covers both).
    loadShareConfig: concreteLoadShareConfig,
    accessDeps: sharedAccessDeps,
    // workspace-project S-002 (AS-012/C-007): the workspace-admin override. When a doc's
    // owner is REMOVED from the workspace they can no longer manage its sharing; the admin
    // becomes the fallback manager and can change the doc's general access.
    isWorkspaceAdmin,
    // AS-011/C-009: real invite mail + the secret the accept-link token is minted with.
    mailQueue,
    mailTransport,
    secret: cfg.APP_SECRET,
  },
  // auth S-005 (AS-011 / harden H6): the invite accept-link endpoint. The accepting
  // email is resolved from the session actor (findUserById over the user table), never
  // the body; the token is verified against APP_SECRET. Email-independent of any mail.
  invite: {
    db,
    resolveSession,
    pendingInviteRepo,
    resolveActorEmail: (userId: string) => findUserById(db, userId),
    secret: cfg.APP_SECRET,
  },
}).listen(cfg.PORT);

console.log(`anchord on http://localhost:${cfg.PORT} (${cfg.NODE_ENV})`);
export type App = typeof app;
