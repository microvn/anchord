import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { contentHeaders } from "./render/sandbox";
import { injectBlockIds } from "./annotation/block-id";
import { injectBridge, injectStorageShim, generateNonce } from "./annotation/sandbox-bridge";
import { docsRoutes, type DocsRoutesDeps } from "./routes/docs";
import { viewerDocRoutes, docViewerRoutes, type ViewerDocRoutesDeps, type DocViewerRoutesDeps } from "./routes/viewer-doc";
import { versionsRoutes, type VersionsRoutesDeps } from "./routes/versions";
import { annotationsRoutes, type AnnotationsRoutesDeps } from "./routes/annotations";
import { sharingRoutes, type SharingRoutesDeps } from "./routes/sharing";
import { workspacesRoutes, type WorkspacesRoutesDeps } from "./routes/workspaces";
import { meRoutes, type MeRoutesDeps } from "./routes/me";
import { notificationsRoutes, type NotificationsRoutesDeps } from "./routes/notifications";
import { projectsRoutes, type ProjectsRoutesDeps } from "./routes/projects";
import { membersRoutes, type MembersRoutesDeps } from "./routes/members";
import { searchRoutes, type SearchRoutesDeps } from "./routes/search";
import { docMoveRoutes, type DocMoveRoutesDeps } from "./routes/doc-move";
import { inviteRoutes, type InviteRoutesDeps } from "./routes/invite";
import { authProvidersRoutes, type AuthProvidersRoutesDeps } from "./routes/auth-providers";
import {
  mcpTransportRoutes,
  mcpTokenRoutes,
  type McpTransportDeps,
  type McpTokenRoutesDeps,
} from "./routes/mcp";
import type { DocRepo } from "./publish/service";
import type { SessionResolver } from "./http/auth-gate";
import type { DB } from "./db/client";
import type { Viewer } from "./sharing/access";

export type ViewerDoc = {
  versionId: string;
  slug: string;
  title: string;
  kind: "html" | "markdown" | "image";
  content: string; // HTML/MD text; for image: an asset URL
};

export type AppDeps = {
  /** Liveness probe for the database. Resolves if reachable, throws if not. */
  dbCheck: () => Promise<void>;
  corsOrigin?: string | string[] | boolean;
  /**
   * Look up a version's raw content by version id for the /v/:id content route,
   * ACCESS-GATED (the version's doc must be viewable by `viewer`).
   * Missing version OR no access → `null` → the route 404s (existence-hiding).
   *
   * doc-access-routing S-006: the bare server-rendered `/d/:slug` viewer (and its
   * `loadViewer` loader + `viewerPage` shell) were removed — the share link now opens
   * the in-app SPA viewer, served by the SPA fallback. `/v/:id` stays as the iframe
   * content surface.
   */
  loadContent?: (
    versionId: string,
    viewer: Viewer,
  ) => Promise<{ content: string; kind: ViewerDoc["kind"] } | null>;
  /**
   * Resolve the viewer's session from the raw Request (the better-auth cookie) for the
   * access-gated content route (/v). Returns `{ userId }` for a logged-in caller, or
   * `null` for an anonymous one (no cookie). Injected so the route gates without a real
   * better-auth instance in tests. Required for loadContent gating; when absent the route
   * treats every caller as anonymous.
   */
  resolveViewerSession?: (request: Request) => Promise<{ userId: string } | null>;
  /** better-auth request handler (auth S-001); mounted at /api/auth/*. */
  authHandler?: (request: Request) => Promise<Response> | Response;
  /**
   * render-publish S-001: enables the enveloped, session-gated POST /api/docs.
   * Provide a Drizzle handle (production) or a pre-built DocRepo (tests), plus a
   * session resolver. Omit to leave /api/docs unmounted (e.g. viewer-only tests).
   */
  docs?: DocsRoutesDeps;
  /**
   * render-publish S-005: enables the enveloped, session-gated, workspace-scoped
   * GET /api/w/:workspaceId/docs/:slug for the in-app React viewer (direction B).
   * Returns the doc's meta + rendered content (markdown → sanitized app-theme HTML;
   * html/image → a `{ contentUrl: /v/:id }` sandbox reference, never inline — C-008).
   * Access-gated existence-hiding (a missing OR no-access doc → 404). Provide the
   * loader deps (db + access model) + session/workspace resolvers, or a pre-built
   * loadViewerDoc (tests). Omit to leave the route unmounted.
   */
  viewerDoc?: ViewerDocRoutesDeps;
  /**
   * doc-access-routing S-002: enables the DOC-ADDRESSED GET /api/docs/:slug for the
   * in-app React viewer — addressed by slug alone (no workspace in the path, C-002/C-007),
   * session OPTIONAL (anon-capable, C-004). Access is decided by the doc via the single
   * resolveAccess gate; a missing OR no-access doc → the SAME 404 NOT_FOUND (existence-
   * hiding), never a 401 the FE would turn into a sign-in redirect. Markdown → sanitized
   * app-origin HTML; html/image → a `{ contentUrl: /v/:id }` sandbox reference (C-006).
   * Provide loader deps (db + access model) + the optional session resolver, or a pre-built
   * loadViewerDoc (tests). Omit to leave the route unmounted.
   */
  docViewer?: DocViewerRoutesDeps;
  /**
   * versioning-diff S-001..S-004: enables the enveloped, session-gated version
   * create/title-patch/history/restore/diff routes under /api/docs/:slug. Provide
   * a Drizzle handle (production) or pre-built repos (tests), plus the session
   * resolver, the doc-scoped role resolver (sharing seam), and access deps. Omit
   * to leave these routes unmounted.
   */
  versions?: VersionsRoutesDeps;
  /**
   * annotation-core S-001..S-007: enables the enveloped annotation create/list,
   * reply + guest comment, resolve/reopen, and suggestion create/decide routes
   * under /api/docs/:slug and /api/annotations|suggestions/:id. Provide a Drizzle
   * handle (production) or pre-built repos (tests), plus the session resolver, the
   * doc-scoped role resolver (sharing seam), access deps, and the guest-commenting
   * toggle resolver (sharing seam). Omit to leave these routes unmounted.
   */
  annotations?: AnnotationsRoutesDeps;
  /**
   * sharing-permissions S-001/S-003/S-004: enables the enveloped, session-gated,
   * manage-sharing-gated PUT /api/docs/:slug/access, POST /api/docs/:slug/invites, and
   * PUT /api/docs/:slug/link routes (C-007 Google-Docs model: owner always; editor when
   * editors_can_share is on; viewer/commenter never). Provide a Drizzle handle
   * (production) or pre-built repos (tests), plus the session resolver, the doc-scoped
   * role resolver, the share-config loader (editors_can_share), and access deps. Omit to
   * leave these routes unmounted.
   */
  sharing?: SharingRoutesDeps;
  /**
   * workspaces S-002/S-004: workspace lifecycle (create/rename) + invitations
   * (invite/accept/reject) at the TOP level (/api/workspaces, /api/invitations). Omit to
   * leave them unmounted.
   */
  workspaces?: WorkspacesRoutesDeps;
  /**
   * workspaces S-003: the bootstrap surface (GET /api/me lists my workspaces + role +
   * active; POST /api/me/active-workspace switches). Top-level. Omit to leave unmounted.
   */
  me?: MeRoutesDeps;
  /**
   * notifications-email S-006: the in-app notification READ surface under /api/me/notifications
   * (list paginated, unread-count, mark-read, mark-all-read). USER-scoped (requireSession +
   * actor.userId), NOT workspace-scoped — a notification is personal (C-008). Omit to leave
   * the routes unmounted.
   */
  notifications?: NotificationsRoutesDeps;
  /**
   * workspace-project S-003: enables the enveloped, session-gated project routes
   * (create/list/rename/archive/unarchive/delete + access-filtered browse-docs-in-
   * project) under /api/projects. Provide a Drizzle handle (production) or pre-built
   * repos (tests), plus the session resolver. Omit to leave /api/projects unmounted.
   */
  projects?: ProjectsRoutesDeps;
  /**
   * workspace-project S-002: enables the enveloped, session-gated, ADMIN-gated member
   * directory under /api/members (GET list, POST /invite, DELETE /:userId). Only admins
   * manage membership (C-002/AS-004); removing a member deletes only the membership row,
   * never their docs (C-007). Provide a Drizzle handle (production) or pre-built repos
   * (tests), plus the session resolver. Omit to leave /api/members unmounted.
   */
  members?: MembersRoutesDeps;
  /**
   * workspace-project S-005: enables the enveloped, session-gated GET /api/search.
   * Searches title + extracted content + comment bodies, access-filtered to docs the
   * actor can see (C-003 existence-hiding), optionally scoped to a project (AS-010).
   * Provide a Drizzle handle (production) or a pre-built SearchRepo (tests), plus the
   * session resolver. Omit to leave /api/search unmounted.
   */
  search?: SearchRoutesDeps;
  /**
   * workspace-project S-004: enables the enveloped, session-gated POST
   * /api/docs/:slug/move and /api/docs/:slug/copy. Move relocates a doc as-is between
   * projects (editor/owner/admin); copy duplicates the current version into another
   * project as a clean new doc (any reader; no annotations/comments copied — C-008).
   * Provide a Drizzle handle (production) or a pre-built repo (tests), plus the session
   * resolver + the doc-scoped role resolver. Omit to leave these routes unmounted.
   */
  docMove?: DocMoveRoutesDeps;
  /**
   * auth S-005 (AS-011 / harden H6): enables the enveloped, session-gated POST
   * /api/invite/accept. Accepts a pending invite via its shareable accept-link
   * (inviteId + token from the link), email-independent of the verify/invite mail.
   * The accepting email is the SERVER-resolved session actor's verified email, never
   * the body. Provide a Drizzle handle (production) or a pre-built pending-invite repo
   * (tests) + a session resolver + actor-email resolver + APP_SECRET. Omit to leave it
   * unmounted.
   */
  invite?: InviteRoutesDeps;
  /**
   * auth-ui GAP-002 (AS-007): enables the enveloped, top-level, PRE-SESSION
   * GET /api/auth-providers, which returns the OAuth providers the operator enabled
   * (ENV creds present). The sign-in/sign-up screens read it to render only those
   * "Continue with …" buttons. Provide the config's `oauth` toggle. Omit to leave
   * it unmounted.
   */
  authProviders?: AuthProvidersRoutesDeps;
  /**
   * mcp-roundtrip S-001: the agent MCP transport at POST /mcp. Mounted on a BARE Elysia with
   * NO apiEnvelope, so responses are raw JSON-RPC, not enveloped (C-005/AS-023). Origin is
   * validated against the allowlist; the bearer is redacted from logs (C-014); the token is
   * re-validated on EVERY request (C-001/AS-022). Omit to leave /mcp unmounted.
   */
  mcp?: McpTransportDeps;
  /**
   * mcp-roundtrip S-001: the Developer-settings PAT web surface (enveloped, session-gated) —
   * GET/POST/DELETE /api/me/tokens (list/create/revoke; plaintext shown once — AS-020/AS-021).
   * Distinct from the `mcp` transport. Omit to leave the token-management routes unmounted.
   */
  mcpTokens?: McpTokenRoutesDeps;
};

/**
 * Build the anchord HTTP app. Dependencies are injected so the app is testable
 * without a real database or network (no telemetry — nothing reaches out except
 * what a handler is explicitly asked to do).
 */
export function createApp(deps: AppDeps) {
  const app = new Elysia()
    .use(cors({ origin: deps.corsOrigin ?? true }))
    .get("/health", async ({ set }) => {
      let db_ok = false;
      try {
        await deps.dbCheck();
        db_ok = true;
      } catch {
        db_ok = false;
      }
      set.status = 200;
      return { status: db_ok ? "ok" : "degraded", db_ok, version: "0.0.0" };
    });

  // /api/auth/* — better-auth handles sign up / sign in / session / logout (S-001).
  // Mounted as a catch-all so better-auth owns the whole sub-tree (DB-backed,
  // httpOnly session cookie signed with APP_SECRET — C-001).
  //
  // auth-routes S-004: `parse: "none"` is LOAD-BEARING. better-auth reads the
  // request body itself (`request.json()` for sign-up/sign-in). If Elysia parses
  // the body first it drains the stream, and better-auth then sees an empty body
  // → 500 "Unexpected end of JSON input" and sign-in never issues a cookie. We
  // hand better-auth the untouched Request, so it owns the whole protocol incl.
  // body reading (api-core C-009: better-auth owns its sub-tree).
  if (deps.authHandler) {
    const authHandler = deps.authHandler;
    app.all("/api/auth/*", ({ request }) => authHandler(request), { parse: "none" });
  }

  // /api/docs — render-publish S-001 publish endpoint. Self-enveloped + session-
  // gated (docsRoutes composes apiEnvelope + requireSession + withValidation), so
  // it lives UNDER the JSON envelope while /api/auth/* above stays OUTSIDE it
  // (better-auth owns its own protocol — api-core C-009).
  if (deps.docs) {
    app.use(docsRoutes(deps.docs));
  }

  // GET /api/w/:workspaceId/docs/:slug — render-publish S-005, the in-app React viewer's
  // doc loader. Self-enveloped + session-gated + workspace-scoped, mounted outside the
  // /api/auth/* catch-all. Markdown → sanitized app-theme HTML; html/image → a sandbox
  // /v reference (C-008: untrusted HTML never inline); existence-hiding 404 (AS-018).
  if (deps.viewerDoc) {
    app.use(viewerDocRoutes(deps.viewerDoc));
  }

  // GET /api/docs/:slug — doc-access-routing S-002, the DOC-ADDRESSED viewer loader. Self-
  // enveloped, NO workspace path param, session OPTIONAL (anon-capable). Mounted outside the
  // /api/auth/* catch-all. A missing OR no-access doc → the SAME 404 (existence-hiding), never
  // a 401: anon and signed-in callers get byte-identical not-found, so the FE never bounces to
  // sign-in. Markdown → sanitized app-origin HTML; html/image → a /v sandbox reference (C-006).
  if (deps.docViewer) {
    app.use(docViewerRoutes(deps.docViewer));
  }

  // /api/docs/:slug/... — versioning-diff S-001..S-004. Self-enveloped + session-
  // gated (versionsRoutes composes apiEnvelope + requireSession + withValidation),
  // mounted outside the /api/auth/* better-auth catch-all, alongside docsRoutes.
  if (deps.versions) {
    app.use(versionsRoutes(deps.versions));
  }

  // /api/docs/:slug/annotations|suggestions + /api/annotations|suggestions/:id —
  // annotation-core S-001..S-007. Self-enveloped, mounted outside /api/auth/*. The
  // comment route is guest-capable (no requireSession), so the plugin gates per-route.
  if (deps.annotations) {
    app.use(annotationsRoutes(deps.annotations));
  }

  // /api/docs/:slug/{access,invites,link} — sharing-permissions S-001/S-003/S-004.
  // Self-enveloped + session-gated + owner-only, mounted outside /api/auth/*.
  if (deps.sharing) {
    app.use(sharingRoutes(deps.sharing));
  }

  // /api/workspaces + /api/invitations — workspaces S-002/S-004. Top-level (not scoped to
  // an existing workspace). Create/rename a workspace; invite by email; accept/reject.
  if (deps.workspaces) {
    app.use(workspacesRoutes(deps.workspaces));
  }

  // /api/me — workspaces S-003 bootstrap. Lists my workspaces + role + active; switch.
  if (deps.me) {
    app.use(meRoutes(deps.me));
  }

  // /api/me/notifications — notifications-email S-006, the in-app bell READ surface. Self-
  // enveloped + session-gated, USER-scoped (every read/mark scoped to actor.userId — C-008),
  // mounted outside /api/auth/*. List/unread-count/mark-read/mark-all-read.
  if (deps.notifications) {
    app.use(notificationsRoutes(deps.notifications));
  }

  // /api/projects — workspace-project S-003. Self-enveloped + session-gated, mounted
  // outside /api/auth/*. Create/list/rename/archive/unarchive/delete + access-filtered
  // browse of docs in a project (existence-hiding out-of-access docs — C-003/AS-006).
  if (deps.projects) {
    app.use(projectsRoutes(deps.projects));
  }

  // /api/members — workspace-project S-002. Self-enveloped + session-gated + ADMIN-gated,
  // mounted outside /api/auth/*. Member directory + invite + remove (members cannot manage
  // membership — AS-004/C-002; removing a member never deletes their docs — C-007).
  if (deps.members) {
    app.use(membersRoutes(deps.members));
  }

  // /api/search — workspace-project S-005. Self-enveloped + session-gated, mounted
  // outside /api/auth/*. Full-text search across accessible docs (title + extracted
  // content + comment bodies), access-filtered (existence-hiding out-of-access docs —
  // C-003), optionally project-scoped (AS-010). FTS SQL is isolated in the search repo.
  if (deps.search) {
    app.use(searchRoutes(deps.search));
  }

  // /api/docs/:slug/{move,copy} — workspace-project S-004. Self-enveloped + session-
  // gated, mounted outside /api/auth/*. Move relocates a doc as-is between projects
  // (editor/owner/admin); copy duplicates the current version as a clean new doc (any
  // reader; no annotations/comments copied — C-008). Distinct paths from the versions
  // cluster's /api/docs/:slug/versions, so the two coexist on /api/docs/:slug.
  if (deps.docMove) {
    app.use(docMoveRoutes(deps.docMove));
  }

  // /api/invite/accept — auth S-005 (AS-011 / harden H6). Self-enveloped + session-gated,
  // mounted outside /api/auth/*. Accepts a pending invite via its email-independent
  // accept-link; the accepting email is the SERVER session actor's verified email (C-005).
  if (deps.invite) {
    app.use(inviteRoutes(deps.invite));
  }

  // /api/auth-providers — auth-ui GAP-002 (AS-007). Enveloped, top-level, PRE-SESSION
  // (the sign-in/sign-up screens read it before any session exists). Returns only the
  // OAuth provider NAMES the operator enabled (ENV creds present) so the FE renders just
  // those buttons; no creds leak.
  if (deps.authProviders) {
    app.use(authProvidersRoutes(deps.authProviders));
  }

  // /api/me/tokens — mcp-roundtrip S-001 PAT management (Developer settings). Self-enveloped +
  // session-gated, mounted outside /api/auth/*. List/create/revoke the caller's tokens.
  if (deps.mcpTokens) {
    app.use(mcpTokenRoutes(deps.mcpTokens));
  }

  // /mcp — mcp-roundtrip S-001 agent transport. A BARE Elysia (NO apiEnvelope), so responses
  // stay raw JSON-RPC (C-005/AS-023). MUST be mounted outside any enveloped group — the
  // envelope is opt-in via apiEnvelope(), which this route never calls, and the enveloped
  // groups above each scope their onAfterHandle to their own sub-app, so none reaches here.
  if (deps.mcp) {
    app.use(mcpTransportRoutes(deps.mcp));
  }

  // Resolve the caller for the access-gated content route: the better-auth session
  // cookie → a `Viewer`. No cookie / no resolver → anon. The loader gates on this, so a
  // restricted/anyone_in_workspace doc's content is never served to someone who can't see it.
  //
  // doc-access-routing S-006: the bare server-rendered `/d/:slug` viewer and its
  // `viewerPage`/`loadViewer` path are GONE — the share link opens the in-app SPA viewer
  // (served by the SPA fallback). Only `/v/:id` (the iframe content surface) remains here.
  const resolveViewer = async (request: Request): Promise<Viewer> => {
    if (!deps.resolveViewerSession) return { kind: "anon" };
    const session = await deps.resolveViewerSession(request);
    return session ? { kind: "user", userId: session.userId } : { kind: "anon" };
  };

  // /v/:id — untrusted content, served sandboxed (opaque origin via CSP), scripts run
  // isolated. ACCESS-GATED the same way: the version's doc must be viewable by the caller.
  if (deps.loadContent) {
    // Raw Response (envelope-exempt, as above) carrying the sandbox CSP/opaque-origin headers.
    app.get("/v/:id", async ({ params, request }) => {
      const viewer = await resolveViewer(request);
      const v = await deps.loadContent!(params.id, viewer);
      if (!v) return new Response("Not found", { status: 404 });
      // S-006/C-009: the sandboxed /v content carries positional block-ids AND the
      // in-iframe annotation bridge (GAP-004) so the iframe can turn a text selection into
      // an anchor and relay it to the FE over a dedicated MessageChannel. HTML/SVG get both;
      // an image (no block tags) is an inert no-op for block-ids but still gets the bridge
      // script (harmless — it just finds no selectable blocks). Best-effort on malformed.
      //
      // The per-request `nonce` (crypto random) is baked into the bridge's `ready` message
      // and its <script nonce> attribute. The FE parent discovers it from the `ready` message
      // and trusts it ONLY when event.source === iframe.contentWindow (FE-side check). The
      // nonce raises the forgery bar but is NOT the guarantee: a body script can scrape the
      // served DOM for it. The HARD backstop that a forged "create annotation" can never
      // succeed is server-side re-authorization of the session role on POST .../annotations
      // (C-001 / api-core C-005), independent of any iframe message.
      //
      // CSP: contentHeaders() keeps `sandbox allow-scripts` with NO `script-src` — so the
      // bridge runs AND the doc's own scripts still run (AS-006/AS-007: isolation by opaque
      // origin, not stripping). Adding `script-src 'nonce-…'` would also neutralize body
      // scripts, contradicting AS-006/AS-007 — deferred to a spec decision (S2 signal). The
      // nonce attribute is present now so that flip is a one-line CSP change later.
      // S-007/C-010: PREPEND an in-memory client-storage shim BEFORE the doc's own scripts so a
      // theme-toggle (etc.) that reads localStorage on load runs instead of crashing on the opaque
      // origin. Per-frame, non-persistent, NOT bridged — does not weaken the opaque-origin isolation.
      const nonce = generateNonce();
      const served = injectBridge(injectStorageShim(injectBlockIds(v.content), nonce), nonce);
      return new Response(served, { headers: contentHeaders() });
    });
  }

  return app;
}

export type App = ReturnType<typeof createApp>;
