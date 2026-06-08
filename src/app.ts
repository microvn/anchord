import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { contentHeaders, sandboxIframe } from "./render/sandbox";
import { renderMarkdown } from "./render/markdown";
import { docsRoutes } from "./routes/docs";
import { versionsRoutes, type VersionsRoutesDeps } from "./routes/versions";
import { annotationsRoutes, type AnnotationsRoutesDeps } from "./routes/annotations";
import { sharingRoutes, type SharingRoutesDeps } from "./routes/sharing";
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
  docs?: {
    db?: DB;
    repo?: DocRepo;
    resolveSession: SessionResolver;
  };
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
   * OWNER-only PUT /api/docs/:slug/access, POST /api/docs/:slug/invites, and PUT
   * /api/docs/:slug/link routes. Provide a Drizzle handle (production) or pre-built
   * repos (tests), plus the session resolver, the doc-scoped role resolver (the owner
   * gate reads it), and access deps. Omit to leave these routes unmounted.
   */
  sharing?: SharingRoutesDeps;
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
  if (deps.authHandler) {
    const authHandler = deps.authHandler;
    app.all("/api/auth/*", ({ request }) => authHandler(request));
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
