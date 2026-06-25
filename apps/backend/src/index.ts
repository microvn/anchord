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
import { session as sessionTable, user as userTable, docs as docsTable, projects as projectsTable } from "./db/schema";
import { createLoadContent } from "./render/viewer-loaders";
import { MailQueue } from "./auth/mail-queue";
import { createMailTransport, createEnqueueWorkspaceInvite } from "./auth/mail-transport";
import { createDocMemberRepo, findUserById } from "./sharing/doc-member-repo";
import { createCapabilityTokenRepo } from "./sharing/share-repo";
import { tryConsumeView } from "./sharing/link-controls-repo";
import { createDocMembersPendingInviteRepo } from "./sharing/invite";
import {
  createAnnotationRepo,
  createReanchorApplyRepo,
  createAnchorResolutionRepo,
} from "./annotation/repo";
import { runReanchorForNewVersion } from "./annotation/reanchor-job";
import { notifyOnDetached } from "./notify/notify";
import { createNotifyRepo } from "./notify/repo";
import { createIsActiveMemberName } from "./routes/annotations";
import { createCommentRateLimiter } from "./annotation/comment-rate-limit";
import { createApiTokenRepo } from "./mcp/token-repo";
import { McpRateLimiter } from "./mcp/rate-limit";
import { baselineTools } from "./mcp/server";
import { createPublishToolsForDb } from "./mcp/tools/publish-tools-wiring";
import { createPullToolsForDb } from "./mcp/tools/pull-tools-wiring";
import { createReadToolsForDb } from "./mcp/tools/read-tools-wiring";
import { createWritebackToolsForDb } from "./mcp/tools/writeback-tools-wiring";
import { createProjectToolsForDb } from "./mcp/tools/project-tools-wiring";
import { createSearchRepo } from "./search/search-repo";

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
  // better-auth builds OAuth redirect URIs and callback links from baseURL, so it MUST be the
  // instance's public origin (APP_URL) — NOT localhost, or every non-local deploy gets
  // redirect_uri=http://localhost:… and Google/GitHub reject with redirect_uri_mismatch.
  baseURL: cfg.APP_URL,
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

// workspace-activity S-001 (C-008): resolve a doc's OWN workspace + an actor's display name for
// the best-effort activity emit. workspaceOfDoc reuses the same tenancy helper the access resolver
// uses (so a row's workspaceId is anchored to the doc's real owner, never the caller's path).
const resolveActorName = async (userId: string): Promise<string | null> => {
  const [row] = await db.select({ name: userTable.name }).from(userTable).where(eq(userTable.id, userId)).limit(1);
  return row?.name ?? null;
};

// workspace-activity S-004: resolve a doc-scoped event's CURRENT viewer link target (slug +
// project name) for the detail page's "Open doc" deep-link. A DELETED doc has no row → null, and
// the detail degrades the button (AS-018). Read at detail time, never frozen at emit.
const resolveDocLink = async (docId: string): Promise<{ slug: string; projectName?: string } | null> => {
  const [row] = await db
    .select({ slug: docsTable.slug, projectName: projectsTable.name })
    .from(docsTable)
    .leftJoin(projectsTable, eq(docsTable.projectId, projectsTable.id))
    .where(eq(docsTable.id, docId))
    .limit(1);
  if (!row) return null;
  return { slug: row.slug, projectName: row.projectName ?? undefined };
};

// mcp-roundtrip S-001: the shared PAT repo (HMAC-SHA256 keyed by APP_SECRET — C-008) + the
// in-process per-token rate limiter (C-007). Both the /mcp transport and the Developer-settings
// token surface read the SAME api_tokens table; the rate limiter is process-global so a token's
// budget is enforced across all its concurrent requests.
const apiTokenRepo = createApiTokenRepo(db, cfg.APP_SECRET);
const mcpRateLimiter = new McpRateLimiter();

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
//   - loadShareConfig: reads share_links.editors_can_share (the manage-sharing gate).
//     (Guest commenting is no longer a toggle — Google-Docs model, reversal 2026-06-20.)
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
// capability-share-link S-002 / C-006: pass APP_SECRET so the anon path validates the
// admission cookie (resolveAdmission) against the doc's CURRENT capability token and admits
// at the cookie's link role on every anon-reachable endpoint (read + comment/resolve write).
const sharedResolveAccess = createResolveAccess(db, {
  resolveDocRole: sharedResolveDocRole,
  secret: cfg.APP_SECRET,
});

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
  enqueue(msg: { to: string; subject: string; text?: string; html?: string }): string {
    const id = mailQueue.enqueue(msg);
    // Fire-and-forget delivery; the queue handles retry/dead-letter. Swallow here so an
    // unhandled rejection can't crash the process (the reply already returned).
    void mailQueue.deliverWithRetry(id, mailTransport).catch((err) => {
      console.error("notify mail delivery failed (dead-lettered)", err);
    });
    return id;
  },
};

// notifications-email S-004 (AS-009 / C-007): the per-publish DETACH notify sink wired into the
// reanchor job. Called once per publish with the per-author grouped tally; raises ONE in-app
// `detached` row per affected author (IN-APP ONLY — low-signal, no email). C-003: drop an author
// who lost current access via the shared resolver. Best-effort (notifyOnDetached swallows + logs),
// so it can never fail the (already async, off-publish) reanchor job.
const onDetachedGrouped = async (
  groups: { authorId: string; count: number }[],
  ctx: { docId: string; versionId: string },
): Promise<void> => {
  await notifyOnDetached(
    { refId: ctx.docId, authors: groups },
    {
      repo: createNotifyRepo(db),
      mail: notifyMail, // unused (low-signal → no email), but the port is required.
      accessFilter: async (userId) =>
        (await sharedResolveAccess(ctx.docId, { kind: "user", userId })).canView,
    },
  );
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
  // doc-access-routing S-003/AS-030: the doc-read response carries the doc's OWN workspace
  // (project → workspace; null when project-less, C-011) so the doc-scoped public viewer can
  // feed the member-only Share/Version panels their workspaceId (C-007). Reuses the same
  // tenancy helper the access resolver above already uses (wsAccess.workspaceOfDoc).
  workspaceOfDoc: (docId: string) => wsAccess.workspaceOfDoc(docId),
};
const loadContent = createLoadContent(viewerLoaderDeps);

const app = createApp({
  dbCheck,
  corsOrigin: cfg.CORS_ORIGIN === "*" ? true : cfg.CORS_ORIGIN.split(","),
  // self-host S-005 / C-007: serve the built web app when WEB_ROOT is configured (production
  // image). Undefined in dev → the Vite dev server owns the FE, the backend stays API-only.
  webRoot: cfg.WEB_ROOT,
  authHandler: auth.handler,
  // doc-access-routing S-006: the bare server-rendered /d/:slug viewer was removed — the
  // share link opens the in-app SPA viewer. Only /v/:id (the sandbox content surface) is
  // served here; the doc-scoped read is GET /api/docs/:slug (docViewer below).
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
  // doc-access-routing S-002: DOC-ADDRESSED GET /api/docs/:slug — slug-only (no workspace
  // path), session OPTIONAL (anon-capable). Same loader/access model as the /d viewer; a
  // no-access OR missing doc → 404 (existence-hiding), never a 401 → no FE sign-in bounce.
  docViewer: { resolveViewerSession, loaderDeps: viewerLoaderDeps },
  // capability-share-link S-002: the anonymous redeem surface POST /s/:token/redeem +
  // GET /s/:token/resolve. Resolves the token → doc (existence-hiding 404 on an unknown
  // token), mints a signed admission cookie bound to docId + token-hash + link role
  // (C-006/C-007), returns only { slug, role } so the SPA never shows the slug (C-009), and
  // sets Referrer-Policy: no-referrer without ever logging the raw token (C-008). Secure cookie
  // off in development (local HTTP) so the cookie is actually stored.
  shareRedeem: {
    resolveCapabilityToken: createCapabilityTokenRepo(db),
    // capability-share-link S-006 / C-003: enforce the owner's link controls before serving —
    // expiry + password gate (the route), then the ATOMIC view-limit consume (exactly once per
    // open, after the other gates pass so a denied open burns no view — AS-022/AS-023).
    consumeView: (docId) => tryConsumeView(db, docId),
    secret: cfg.APP_SECRET,
    secure: cfg.NODE_ENV !== "development",
  },
  // versioning-diff S-001..S-004: version create/title/history/restore/diff.
  versions: {
    db,
    resolveSession,
    resolveWorkspaceRole,
    resolveDocRole: sharedResolveDocRole,
    resolveAccess: sharedResolveAccess,
    // doc-access-routing S-005 / C-007: makes the DOC-ADDRESSED version reads
    // (GET /api/docs/:slug/versions + /diff) anon-capable — same optional-session seam the
    // /d, /v and /api/docs/:slug viewer routes use. Writes stay workspace-scoped above.
    resolveViewerSession,
    // annotation-core S-005 / C-012: when a new version is created, re-anchor the doc's
    // annotations onto the new content — carried annotations follow the text, lost ones
    // detach (never dropped). Fired off the publish path (the route doesn't await it). The
    // ledger keys (annotation_id, version_id) so a re-run is idempotent; a >25%-detached
    // run logs an alert.
    reanchorOnNewVersion: async ({ docId, version, content, kind, onDetached }) => {
      const versionId = `${docId}:${version}`;
      const ledger = createAnchorResolutionRepo(db);
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
            // workspace-activity S-005 / AS-021 (F-5): log ONE System `detached` activity row with
            // the detached count from THIS summary (the only place the count exists). Best-effort —
            // the route's emit swallows + logs; a lost row is acceptable (C-002).
            if (s.detached > 0) void onDetached?.(s.detached);
          },
          // S-004 (AS-009): raise ONE grouped in-app `detached` row per affected author per publish.
          onDetachedGrouped,
        },
        { docId, versionId, content, kind },
      );
    },
    // workspace-activity S-005: log publish/restore/detached to the workspace activity feed.
    // workspaceOfDoc anchors the row's workspace to the doc's OWN workspace (C-008); resolveActorName
    // resolves the actor name per-emit. Best-effort post-commit — never blocks the publish/restore.
    activity: {
      workspaceOfDoc: (docId: string) => wsAccess.workspaceOfDoc(docId),
      resolveActorName,
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
    // doc-access-routing S-004: the anon comment write surface. rateLimitComment throttles
    // anonymous writes per IP+doc (C-008/AS-022) — a refused write 429s AND skips the reply
    // mail dispatch (no flood). isActiveMemberName rejects a guest name colliding with an
    // active member / doc-owner display name (C-009/AS-023) so a guest can't read as a member.
    rateLimitComment: createCommentRateLimiter(),
    isActiveMemberName: createIsActiveMemberName(db),
    // S-006: notify thread participants + doc owner on a reply (in-app row via the DB
    // notify repo + one email per recipient through the shared queue). Best-effort.
    notify: { mail: notifyMail, appUrl: cfg.APP_URL },
    // workspace-activity S-001: log a comment/reply/resolve to the workspace activity feed.
    // workspaceOfDoc anchors the row's workspace to the doc's OWN workspace (C-008); resolveActorName
    // resolves the actor name per-emit. Best-effort post-commit — never blocks the comment/resolve.
    activity: {
      workspaceOfDoc: (docId: string) => wsAccess.workspaceOfDoc(docId),
      resolveActorName,
    },
  },
  // workspaces S-002/S-004: top-level workspace lifecycle + invitations.
  workspaces: {
    db,
    resolveSession,
    resolveActorEmail: (userId: string) => findUserById(db, userId),
    // workspace-activity S-006 (C-005): log workspace_renamed / invite / member-join (invite-accept)
    // to the activity feed. WORKSPACE-LEVEL events — the route passes the workspaceId directly, so
    // no workspaceOfDoc here; the repo is built from `db`. resolveActorName resolves the actor name
    // per-emit. Best-effort post-commit — never blocks the rename/invite/accept.
    activity: { resolveActorName },
    // AS-009: inviting a member ENQUEUES a workspace-invite email carrying the accept/
    // reject landing link the FE consumes — through the SAME shared queue + transport the
    // verification mail uses. Fixes the live wiring gap where this dep was absent so the
    // route's optional `enqueueInvite?.(...)` silently no-op'd (201, no mail, no way in).
    enqueueInvite: createEnqueueWorkspaceInvite(mailQueue, mailTransport, cfg.APP_URL),
    // workspace-notifications S-001: the post-commit in-app bell row on invite. `mail` is required
    // by the port but unused (workspace_invited is in-app only, C-001 — no second email).
    notify: { mail: notifyMail },
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
  // notifications-email S-006: the in-app bell READ surface. USER-scoped (the read repo scopes
  // every query to actor.userId — C-008), backed by the real notifications table the earlier
  // stories write into.
  notifications: { db, resolveSession },
  // workspace-activity S-001/S-002: the workspace event feed under /api/w/:workspaceId/activity.
  // Session-gated + workspace-scoped (requireWorkspaceMember); recent-first, paginated (20/cap 50).
  // S-002 / C-003: the feed-list + single-event reads are role- + access-gated through the SAME
  // shared resolveAccess the doc viewer uses (admins all; members see workspace-level events plus
  // doc-scoped events on docs they can open, resolved at READ time, F-2).
  activity: { db, resolveSession, resolveWorkspaceRole, resolveAccess: sharedResolveAccess, resolveDocLink },
  // your-activity-actions S-001: the personal cross-workspace "Your actions" feed under
  // /api/me/activity. ACCOUNT-scoped (the caller's own actions only — C-001), current-member
  // workspaces only (C-006). C-002: a doc-scoped row whose target the caller can no longer access
  // still lists but genericizes its target-derived display via the SAME shared resolveAccess.
  meActivity: { db, resolveSession, resolveAccess: sharedResolveAccess },
  // workspace-project S-003: project routes under /api/w/:workspaceId/projects.
  // workspace-activity S-006 / AS-024 (C-005): a project create logs ONE `project` event. The
  // workspace is the path workspace (passed by the route), so no workspaceOfDoc; the repo is built
  // from `db`. resolveActorName resolves the actor name per-emit. Best-effort post-commit.
  projects: { db, resolveSession, resolveWorkspaceRole, activity: { resolveActorName } },
  // workspaces S-005: per-workspace member directory + role management under
  // /api/w/:workspaceId/members (admin-gated; ≥1-admin invariant).
  members: {
    db,
    resolveSession,
    resolveWorkspaceRole,
    // workspace-notifications S-003: the post-commit removed-member notice (in-app + email). The
    // workspace name + recipient email are snapshotted PRE-delete by the route; the email deep-link
    // is workspace-shaped (built from APP_URL). Best-effort — a notify failure never fails removal.
    notify: { mail: notifyMail, appUrl: cfg.APP_URL },
    // workspace-activity S-006 (C-005): a successful removal logs ONE `member_removed` event. The
    // workspace is the path workspace (passed by the route), so no workspaceOfDoc; the repo is built
    // from `db`. resolveActorName resolves the actor name per-emit. Best-effort post-commit.
    activity: { resolveActorName },
  },
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
    // workspace-activity S-006 / AS-022 (C-005 / C-008): a successful general-access change logs ONE
    // doc-scoped `share` event. workspaceOfDoc anchors the row to the doc's OWN workspace (C-008),
    // reusing the same tenancy helper the access resolver uses; resolveActorName resolves the actor
    // name per-emit. Best-effort post-commit — never blocks the share change.
    activity: {
      workspaceOfDoc: (docId: string) => wsAccess.workspaceOfDoc(docId),
      resolveActorName,
    },
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
  // mcp-roundtrip S-001: the Developer-settings PAT surface + the agent /mcp transport.
  // Both share ONE api_tokens repo (HMAC-SHA256 keyed by APP_SECRET — C-008). The transport's
  // Origin allowlist is the backend's own base-URL origin (C-005, DNS-rebinding guard); the
  // token is re-validated on every JSON-RPC request inside the transport (C-001).
  mcpTokens: {
    db,
    secret: cfg.APP_SECRET,
    resolveSession,
    isWorkspaceMember: (workspaceId: string, userId: string) =>
      wsAccess.isWorkspaceMember(workspaceId, userId),
  },
  mcp: {
    tokens: apiTokenRepo,
    rateLimiter: mcpRateLimiter,
    // S-001 ships the baseline `ping` tool; S-002 registers the publish domain tools
    // (anchord_create_document / anchord_update_document) over the existing publish +
    // version-append + re-anchor services. resolveAccess is the shared authoritative gate
    // (editor+ on update — AS-004/AS-005); reanchorOnNewVersion is the SAME async seam the
    // version routes fire (C-012). S-003..S-006 will spread their fragments here too.
    tools: {
      ...baselineTools(),
      ...createPublishToolsForDb({
        db,
        appUrl: cfg.APP_URL,
        resolveAccess: sharedResolveAccess,
        reanchorOnNewVersion: async ({ docId, version, content, kind, changedBlockIds }) => {
          const versionId = `${docId}:${version}`;
          await runReanchorForNewVersion(
            {
              annotations: createAnnotationRepo(db),
              apply: createReanchorApplyRepo(db),
              ledger: createAnchorResolutionRepo(db),
              onSummary: (s) => {
                if (s.alert) {
                  console.warn(
                    `[reanchor] doc ${docId} v${version}: ${s.detached}/${s.total} annotations detached ` +
                      `(${Math.round(s.detachedRate * 100)}%) — over threshold`,
                  );
                }
              },
              // notifications-email S-004 (AS-009): the MCP publish path also detaches annotations
              // — raise the SAME grouped per-author in-app notice off this fire-site.
              onDetachedGrouped,
            },
            // S-004/C-004: forward the patch's changed-block set (undefined for the whole-doc
            // update path → full matcher; present for a patch → deterministic carry off-block).
            { docId, versionId, content, kind, changedBlockIds },
          );
        },
      }),
      // S-004: the pull/read tools (anchord_pull_annotations / anchord_list_comments) over
      // the annotation-core model. resolveAccess is the SAME shared per-doc gate (AS-010.T1).
      ...createPullToolsForDb({
        db,
        resolveAccess: sharedResolveAccess,
      }),
      // S-003: the read tools (anchord_list_documents / anchord_read_document /
      // anchord_search_documents) over the workspace-wide accessible-docs read + search. Every
      // membership/browse check is parameterized by the TOKEN's workspace_id (C-013/AS-029):
      // list/search take ctx.workspaceId into their workspace-scoped reads; read re-checks the
      // doc's OWN workspace (wsAccess.workspaceOfDoc) against the token's. resolveAccess is the
      // SAME shared per-doc gate; search reuses the existing FTS repo (access-filtered in SQL).
      ...createReadToolsForDb({
        db,
        resolveAccess: sharedResolveAccess,
        workspaceOfDoc: (docId: string) => wsAccess.workspaceOfDoc(docId),
        search: { repo: createSearchRepo(db) },
      }),
      // S-005: the write-back tools (anchord_reply_comment / anchord_resolve_comment) over the
      // annotation-core reply + resolve services. resolveAccess is the SAME shared per-doc gate
      // (commenter+ to reply/resolve); the services re-authorize on the resolved role + apply
      // their proposal-owner-only / deleted-terminal guards unchanged.
      ...createWritebackToolsForDb({
        db,
        resolveAccess: sharedResolveAccess,
      }),
      // S-006: the project tools (anchord_list_projects / anchord_read_project /
      // anchord_create_project) over the workspace-project service. list/read declare
      // projects:read, create declares projects:write (C-009/AS-016). Every read is scoped by
      // the TOKEN's workspace_id (C-010/C-013): list/read use ProjectRepo.listActive/findById
      // (workspace-member visibility, no per-owner ACL — a foreign projectId resolves to null →
      // rejected-not-disclosed); create makes a non-default project owned by the token-owner in
      // the token's workspace, returning a projectId usable by create_document.
      ...createProjectToolsForDb(db),
    },
    allowedOrigins: [`http://localhost:${cfg.PORT}`],
  },
}).listen(cfg.PORT);

console.log(`anchord on http://localhost:${cfg.PORT} (${cfg.NODE_ENV})`);
export type App = typeof app;
