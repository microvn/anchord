import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { contentHeaders, sandboxIframe } from "./render/sandbox";
import { renderMarkdown } from "./render/markdown";
import { docsRoutes, type DocsRoutesDeps } from "./routes/docs";
import { versionsRoutes, type VersionsRoutesDeps } from "./routes/versions";
import { annotationsRoutes, type AnnotationsRoutesDeps } from "./routes/annotations";
import { sharingRoutes, type SharingRoutesDeps } from "./routes/sharing";
import { workspacesRoutes, type WorkspacesRoutesDeps } from "./routes/workspaces";
import { meRoutes, type MeRoutesDeps } from "./routes/me";
import { projectsRoutes, type ProjectsRoutesDeps } from "./routes/projects";
import { membersRoutes, type MembersRoutesDeps } from "./routes/members";
import { searchRoutes, type SearchRoutesDeps } from "./routes/search";
import { docMoveRoutes, type DocMoveRoutesDeps } from "./routes/doc-move";
import { inviteRoutes, type InviteRoutesDeps } from "./routes/invite";
import { authProvidersRoutes, type AuthProvidersRoutesDeps } from "./routes/auth-providers";
import type { DocRepo } from "./publish/service";
import type { SessionResolver } from "./http/auth-gate";
import type { DB } from "./db/client";

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
  /** Look up the current published version of a doc by slug (for /d/:slug viewer). */
  loadViewer?: (slug: string) => Promise<ViewerDoc | null>;
  /** Look up a version's raw content by version id (for /v/:id content route). */
  loadContent?: (versionId: string) => Promise<{ content: string; kind: ViewerDoc["kind"] } | null>;
  /** better-auth request handler (auth S-001); mounted at /api/auth/*. */
  authHandler?: (request: Request) => Promise<Response> | Response;
  /**
   * render-publish S-001: enables the enveloped, session-gated POST /api/docs.
   * Provide a Drizzle handle (production) or a pre-built DocRepo (tests), plus a
   * session resolver. Omit to leave /api/docs unmounted (e.g. viewer-only tests).
   */
  docs?: DocsRoutesDeps;
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
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Viewer shell: HTML/image render in a sandboxed iframe; Markdown renders in-app (sanitized). */
function viewerPage(doc: ViewerDoc): string {
  let main: string;
  if (doc.kind === "markdown") {
    main = `<main class="doc-md">${renderMarkdown(doc.content)}</main>`;
  } else {
    // html + image (incl. svg) → sandboxed iframe (opaque origin, scripts run isolated)
    main = sandboxIframe(`/v/${doc.versionId}`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc.title)}</title></head><body>${main}</body></html>`;
}

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

  // /d/:slug — viewer shell (trusted app origin)
  if (deps.loadViewer) {
    app.get("/d/:slug", async ({ params, set }) => {
      const doc = await deps.loadViewer!(params.slug);
      if (!doc) {
        set.status = 404;
        return "Not found";
      }
      set.headers["Content-Type"] = "text/html; charset=utf-8";
      return viewerPage(doc);
    });
  }

  // /v/:id — untrusted content, served sandboxed (opaque origin via CSP), scripts run isolated
  if (deps.loadContent) {
    app.get("/v/:id", async ({ params, set }) => {
      const v = await deps.loadContent!(params.id);
      if (!v) {
        set.status = 404;
        return "Not found";
      }
      for (const [k, val] of Object.entries(contentHeaders())) set.headers[k] = val;
      return v.content;
    });
  }

  return app;
}

export type App = ReturnType<typeof createApp>;
