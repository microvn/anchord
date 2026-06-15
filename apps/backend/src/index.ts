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
import { createResolveAccess } from "./sharing/resolve-access";
import { createWorkspaceAccess } from "./workspace/tenancy-repo";
import { eq } from "drizzle-orm";
import { session as sessionTable } from "./db/schema";
import { createLoadViewer, createLoadContent } from "./render/viewer-loaders";
import { MailQueue } from "./auth/mail-queue";
import { createMailTransport, createEnqueueWorkspaceInvite } from "./auth/mail-transport";
import { createDocMemberRepo, findUserById } from "./sharing/doc-member-repo";
import { createDocMembersPendingInviteRepo } from "./sharing/invite";
import {
  createAnnotationRepo,
  createReanchorApplyRepo,
  createReanchorLedgerRepo,
} from "./annotation/repo";
import { runReanchorForNewVersion } from "./annotation/reanchor-job";

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
  // Dev-only: the brute-force sign-in limit (C-007) is applied by better-auth to the WHOLE
  // /api/auth/* subtree, so it also throttles the frequently-polled get-session and 429s a
  // normal session. Off in development so local testing isn't bounced; prod keeps it (the
  // proper prod fix — per-path customRules exempting get-session — is a follow-up auth change).
  rateLimitEnabled: cfg.NODE_ENV !== "development",
});

const resolveSession = betterAuthSessionResolver(auth);

// workspaces S-006 (C-002): scoped tenancy reads. Everything is keyed on a CONCRETE
// workspace id (from the /api/w/:workspaceId path the gate proved membership for), never
// "member of any workspace".
//   - resolveWorkspaceRole(workspaceId, userId): the path-scoped gate's membership read.
//   - isWorkspaceMemberOfDoc(docId, userId): membership of the DOC's OWN workspace — drives
//     anyone_in_workspace (AS-019/AS-020), so a member of B never reaches A's doc.
//   - isWorkspaceAdminForDoc(docId, userId): admin of the DOC's workspace — the sharing /
//     doc-move admin override, scoped to that workspace.
const wsAccess = createWorkspaceAccess(db);
const resolveWorkspaceRole = (workspaceId: string, userId: string) =>
  wsAccess.workspaceRoleOf(workspaceId, userId);
const isWorkspaceMemberOfDoc = async (docId: string, userId: string): Promise<boolean> => {
  const wsId = await wsAccess.workspaceOfDoc(docId);
  return wsId ? wsAccess.isWorkspaceMember(wsId, userId) : false;
};
const isWorkspaceAdminForDoc = async (docId: string, userId: string): Promise<boolean> => {
  const wsId = await wsAccess.workspaceOfDoc(docId);
  return wsId ? wsAccess.isWorkspaceAdminFor(wsId, userId) : false;
};
// The sharing/doc-move route override is keyed by (workspaceId, userId) directly (the
// path workspace), so it does not need to re-resolve the doc's workspace.
const isWorkspaceAdmin = (workspaceId: string, userId: string) =>
  wsAccess.isWorkspaceAdminFor(workspaceId, userId);

// doc-access-routing S-001: the OLD permissive `sharedAccessDeps` stubs
// (`isInvited: () => true, isWorkspaceMember: () => true`) are GONE from every
// doc-centric READ gate. Authorization now flows through the single async
// `sharedResolveAccess` (built below) backed by the real `sharedResolveDocRole`
// (real owner + active doc_members + link role + workspace-of-doc membership). The
// permissive ports no longer decide anything on the doc read / annotation / version
// paths — closing the cross-tenant bypass the stubs left behind (F1).
//
// The sharing (management) routes keep their own structural existence-hiding `canViewDoc`
// ports for now (they sit behind requireWorkspaceMember + the owner/admin manage gate, so
// they are not part of S-001's doc-centric READ list); a local accessDeps is built there.
const sharingAccessDeps = {
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
  // workspaces C-002/AS-019: anyone_in_workspace resolves against the DOC's OWN workspace.
  isWorkspaceMember: isWorkspaceMemberOfDoc,
});
const concreteLoadShareConfig = createLoadShareConfig(db);

// doc-access-routing S-001 / C-001: the SINGLE authoritative access gate every
// doc-centric READ flows through (viewer loaders, annotation read, version read). Built
// on the real sharedResolveDocRole, it also handles the anon path (anon may view only an
// anyone_with_link doc, at the link role — C-005). canView ⇔ a non-null role.
const sharedResolveAccess = createResolveAccess(db, { resolveDocRole: sharedResolveDocRole });

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
    (await docOwner(docId, userId)) && (await isWorkspaceMemberOfDoc(docId, userId)),
  isWorkspaceMember: isWorkspaceMemberOfDoc,
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

// render-publish S-002/S-003/S-004 — the access-gated doc viewer (/d/:slug, /v/:id).
//
// The session resolver for the viewer routes: better-auth's cookie → { userId } | null.
// resolveSession reads Headers; the viewer routes hand us the raw Request, so we adapt.
// Anonymous (no cookie) returns null and still works for an anyone_with_link doc.
const resolveViewerSession = async (request: Request): Promise<{ userId: string } | null> => {
  const actor = await resolveSession(request.headers);
  return actor ? { userId: actor.userId } : null;
};

// The loaders gate every doc with the SAME single access gate the versions/annotations
// routes use — the authoritative async sharedResolveAccess (S-001). Built in
// render/viewer-loaders.ts.
const viewerLoaderDeps = {
  db,
  resolveAccess: sharedResolveAccess,
};
const loadViewer = createLoadViewer(viewerLoaderDeps);
const loadContent = createLoadContent(viewerLoaderDeps);

const app = createApp({
  dbCheck,
  corsOrigin: cfg.CORS_ORIGIN === "*" ? true : cfg.CORS_ORIGIN.split(","),
  authHandler: auth.handler,
  // render-publish S-002/S-003/S-004: the access-gated doc viewer + content routes.
  loadViewer,
  loadContent,
  resolveViewerSession,
  // All data APIs are now path-scoped under /api/w/:workspaceId (workspaces S-006). Each
  // group gets resolveWorkspaceRole so the requireWorkspaceMember gate refuses a non-member
  // (404, existence-hiding) before any handler.
  // render-publish S-001: enveloped, session-gated POST /api/w/:workspaceId/docs.
  docs: { db, resolveSession, resolveWorkspaceRole },
  // render-publish S-005: enveloped, session-gated GET /api/w/:workspaceId/docs/:slug for
  // the in-app React viewer. Reuses the SAME access model (viewerLoaderDeps) the /d viewer
  // uses; markdown → sanitized app-theme HTML, html/image → /v sandbox reference (C-008).
  viewerDoc: { resolveSession, resolveWorkspaceRole, loaderDeps: viewerLoaderDeps },
  // versioning-diff S-001..S-004: version create/title/history/restore/diff.
  versions: {
    db,
    resolveSession,
    resolveWorkspaceRole,
    resolveDocRole: sharedResolveDocRole,
    resolveAccess: sharedResolveAccess,
    // annotation-core S-005 / C-012: when a new version is created, re-anchor the doc's
    // annotations onto the new content — carried annotations follow the text, lost ones
    // detach (never dropped). Fired off the publish path (the route doesn't await it). The
    // ledger keys (annotation_id, version_id) so a re-run is idempotent; a >25%-detached
    // run logs an alert.
    reanchorOnNewVersion: async ({ docId, version, newContentHtml }) => {
      const versionId = `${docId}:${version}`;
      const ledger = createReanchorLedgerRepo(db);
      await runReanchorForNewVersion(
        {
          annotations: createAnnotationRepo(db),
          apply: createReanchorApplyRepo(db),
          ledger,
          onSummary: (s) => {
            if (s.alert) {
              console.warn(
                `[reanchor] doc ${docId} v${version}: ${s.detached}/${s.total} annotations detached ` +
                  `(${Math.round(s.detachedRate * 100)}%) — over threshold`,
              );
            }
          },
        },
        { docId, versionId, newContentHtml },
      );
    },
  },
  // annotation-core S-001..S-007: annotation create/list, reply + guest comment,
  // resolve/reopen, suggestion create/decide.
  annotations: {
    db,
    resolveSession,
    resolveWorkspaceRole,
    resolveDocRole: sharedResolveDocRole,
    resolveAccess: sharedResolveAccess,
    loadShareConfig: concreteLoadShareConfig,
    // S-006: notify thread participants + doc owner on a reply (in-app row via the DB
    // notify repo + one email per recipient through the shared queue). Best-effort.
    notify: { mail: notifyMail },
  },
  // workspaces S-002/S-004: top-level workspace lifecycle + invitations.
  workspaces: {
    db,
    resolveSession,
    resolveActorEmail: (userId: string) => findUserById(db, userId),
    // AS-009: inviting a member ENQUEUES a workspace-invite email carrying the accept/
    // reject landing link the FE consumes — through the SAME shared queue + transport the
    // verification mail uses. Fixes the live wiring gap where this dep was absent so the
    // route's optional `enqueueInvite?.(...)` silently no-op'd (201, no mail, no way in).
    enqueueInvite: createEnqueueWorkspaceInvite(mailQueue, mailTransport),
  },
  // workspaces S-003: top-level bootstrap (/api/me) + switch. The active workspace is the
  // login-default landing (C-005); read/written on the session row.
  me: {
    db,
    resolveSession,
    getActiveWorkspaceId: async (userId: string) => {
      const [row] = await db
        .select({ id: sessionTable.activeWorkspaceId })
        .from(sessionTable)
        .where(eq(sessionTable.userId, userId))
        .limit(1);
      return row?.id ?? null;
    },
    setActiveWorkspaceId: async (userId: string, workspaceId: string) => {
      await db
        .update(sessionTable)
        .set({ activeWorkspaceId: workspaceId })
        .where(eq(sessionTable.userId, userId));
    },
  },
  // workspace-project S-003: project routes under /api/w/:workspaceId/projects.
  projects: { db, resolveSession, resolveWorkspaceRole },
  // workspaces S-005: per-workspace member directory + role management under
  // /api/w/:workspaceId/members (admin-gated; ≥1-admin invariant).
  members: { db, resolveSession, resolveWorkspaceRole },
  // workspace-project S-005: GET /api/w/:workspaceId/search, scoped to the workspace.
  search: { db, resolveSession, resolveWorkspaceRole },
  // workspace-project S-004: move/copy under /api/w/:workspaceId/docs/:slug. The admin
  // override is scoped to the doc's workspace (C-002).
  docMove: {
    db,
    resolveSession,
    resolveWorkspaceRole,
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
    resolveWorkspaceRole,
    // S-002: the membership-gated owner source — a removed owner loses manage-sharing.
    resolveDocRole: sharingResolveDocRole,
    // Manage-sharing gate (C-007) reads editors_can_share from here (reuses the same
    // concrete loader as annotation-core; the superset return shape covers both).
    loadShareConfig: concreteLoadShareConfig,
    accessDeps: sharingAccessDeps,
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
  // auth-ui GAP-002 (AS-007): the FE reads this to render only the OAuth buttons whose
  // ENV creds are present. Same gating output (cfg.oauth) the socialProviders block above
  // uses — one source of truth for "enabled".
  authProviders: { oauth: cfg.oauth },
}).listen(cfg.PORT);

console.log(`anchord on http://localhost:${cfg.PORT} (${cfg.NODE_ENV})`);
export type App = typeof app;
