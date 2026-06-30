// HTTP route for render-publish S-005 — serve a doc to the in-app React viewer.
//
// GET /api/w/:workspaceId/docs/:slug — an ENVELOPED, session-gated, workspace-scoped
// JSON route (unlike the envelope-exempt RAW /d and /v routes). It returns the doc's
// metadata + its rendered content so the React 3-pane viewer (direction B) can render
// without scraping the /d server page.
//
// Contract (render-publish ## API + C-008):
//   200 { doc: { title, kind, version, status, generalAccess }, content }
//     - markdown → `content` is sanitized app-theme HTML (renderMarkdown → dompurify, C-002)
//     - html/image → `content` is { contentUrl: "/v/<versionId>" } — a reference to the
//       sandboxed content; the untrusted HTML is NEVER returned inline for the app origin (C-008)
//   404 — a doc the caller cannot access OR a missing slug, indistinguishable (existence-hiding).
//
// The access gate REUSES the same loader/access model as the /d viewer + annotation routes
// (createLoadViewerDoc → canViewVisible → resolveAccess): a missing doc OR one
// the caller cannot view BOTH come back null → 404 (AS-018, C-008).

import { Elysia } from "elysia";
import { apiEnvelope } from "../http/envelope";
import {
  requireSession,
  requireWorkspaceMember,
  type SessionResolver,
  type WorkspaceRoleResolver,
} from "../http/auth-gate";
import { NotFoundError, DocDeletedError } from "../http/errors";
import { renderMarkdown } from "../render/markdown";
import { injectBlockIds } from "../annotation/block-id";
import { buildDocDownload } from "../render/document-download";
import { createLoadViewerDoc, type ViewerLoaderDeps, type ViewerDocPayload } from "../render/viewer-loaders";
import type { Viewer } from "../sharing/access";
import { readAdmissionCookie } from "../sharing/capability-cookie";

/**
 * doc-access-routing S-002: resolve the viewer session OPTIONALLY from the raw Request.
 * `{ userId }` for a logged-in caller (better-auth cookie), `null` for an anonymous one —
 * exactly the seam the /d and /v viewer routes already use (app.ts `resolveViewerSession`).
 * Injected so the doc-addressed route gates without a real better-auth instance in tests.
 */
export type ViewerSessionResolver = (request: Request) => Promise<{ userId: string } | null>;

export interface ViewerDocRoutesDeps {
  /** Resolves the better-auth session → actor; gates the route (401 if none). */
  resolveSession: SessionResolver;
  /** workspaces S-006: resolves the caller's role in :workspaceId for the path-scoped gate. */
  resolveWorkspaceRole: WorkspaceRoleResolver;
  /**
   * The access-gated doc-by-slug loader (render/viewer-loaders.createLoadViewerDoc).
   * Pre-built for tests; built from `loaderDeps` when those are supplied instead.
   * Returns null for a missing OR no-access doc (existence-hiding).
   */
  loadViewerDoc?: (slug: string, viewer: Viewer) => Promise<ViewerDocPayload | null>;
  /** Loader deps (db + access model) — used to build loadViewerDoc when it isn't passed. */
  loaderDeps?: ViewerLoaderDeps;
}

/** Shape the loaded payload into the API's `{ doc, content }` (C-008: markdown HTML vs sandbox ref). */
function toResponse(payload: ViewerDocPayload): {
  doc: {
    title: string;
    kind: ViewerDocPayload["kind"];
    version: number;
    status: "published";
    generalAccess: ViewerDocPayload["generalAccess"];
    // doc-access-two-axis S-006 / C-008: raw axes carried alongside the lossy summary (AS-027).
    workspaceRole: ViewerDocPayload["workspaceRole"];
    linkRole: ViewerDocPayload["linkRole"];
    effectiveRole?: ViewerDocPayload["effectiveRole"];
    workspaceId: ViewerDocPayload["workspaceId"];
  };
  content: string | { contentUrl: string };
} {
  const doc = {
    title: payload.title,
    kind: payload.kind,
    version: payload.version,
    status: payload.status,
    generalAccess: payload.generalAccess,
    // doc-access-two-axis S-006 / C-008: the raw two-axis state alongside the derived
    // `generalAccess` summary, so the Share dialog can tell workspace-shared from link-only —
    // the distinction the lossy 3-value summary drops (AS-027). Always present (may be null).
    workspaceRole: payload.workspaceRole,
    linkRole: payload.linkRole,
    // S-001/C-002: the consumer (ShareDialog gate) reads this to show the Share affordance for an
    // owner/editor. Omit when null (anon) so the optional FE field stays absent rather than null.
    ...(payload.effectiveRole ? { effectiveRole: payload.effectiveRole } : {}),
    // doc-access-routing S-003/AS-030: the doc's OWN workspace (null when project-less, C-011).
    // The doc-scoped viewer has no :workspaceId path param, so a signed-in member sources it
    // from here to open the workspace-addressed Share dialog + Version history (C-007). Always
    // present (may be null) — the FE gates those member-only panels on a non-null value.
    workspaceId: payload.workspaceId,
  };
  if (payload.kind === "markdown") {
    // C-002/C-008: markdown is rendered in the APP origin → MUST be sanitized (dompurify).
    // S-006/C-009: then stamp positional block-ids on the served HTML so the viewer's
    // annotation layer can anchor to a block. Best-effort, never throws (AS-019..022).
    return { doc, content: injectBlockIds(renderMarkdown(payload.content)) };
  }
  // C-008: html/image content is NEVER returned inline for the app origin — only a
  // reference to the sandboxed /v content the viewer loads into an isolated iframe.
  return { doc, content: { contentUrl: `/v/${payload.versionId}` } };
}

/**
 * Elysia plugin factory for the S-005 in-app viewer JSON route.
 *
 * Mounting order IS the api-core pattern (mirrors docsRoutes): apiEnvelope FIRST (so
 * every success/error below is enveloped), then requireSession + requireWorkspaceMember
 * (the path-scoped tenancy gate — a non-member sees 404, existence-hiding), then the route.
 */
export function viewerDocRoutes(deps: ViewerDocRoutesDeps) {
  const loadViewerDoc =
    deps.loadViewerDoc ??
    (() => {
      if (!deps.loaderDeps) {
        throw new Error("viewerDocRoutes requires either `loadViewerDoc` or `loaderDeps`");
      }
      return createLoadViewerDoc(deps.loaderDeps);
    })();

  return apiEnvelope(new Elysia())
    .use(requireSession({ resolveSession: deps.resolveSession }))
    .use(requireWorkspaceMember({ resolveWorkspaceRole: deps.resolveWorkspaceRole }))
    .get("/api/w/:workspaceId/docs/:slug", async ({ params, actor, set }) => {
      // H-6: never leak a doc URL in a Referer even from the JSON read path (defense in depth).
      set.headers["Referrer-Policy"] = "no-referrer";
      // The viewer (Viewer) is the SERVER-resolved session actor — never a body field.
      const viewer: Viewer = { kind: "user", userId: actor.userId };
      const payload = await loadViewerDoc(params.slug, viewer);
      // A missing doc OR one the caller cannot view → the same 404 (existence-hiding, C-008/AS-018).
      if (!payload) throw new NotFoundError();
      return toResponse(payload);
    });
}

export interface DocViewerRoutesDeps {
  /**
   * Resolves the viewer's session OPTIONALLY from the raw Request — anon allowed.
   * `null` → an anonymous viewer. The route is NOT session-gated (C-004): a missing
   * session never 401s; the access decision is made by the doc via resolveAccess.
   */
  resolveViewerSession?: ViewerSessionResolver;
  /**
   * The access-gated doc-by-slug loader (render/viewer-loaders.createLoadViewerDoc).
   * Pre-built for tests; built from `loaderDeps` when those are supplied instead.
   * Returns null for a missing OR no-access doc (existence-hiding).
   */
  loadViewerDoc?: (slug: string, viewer: Viewer) => Promise<ViewerDocPayload | null>;
  /** Loader deps (db + access model) — used to build loadViewerDoc when it isn't passed. */
  loaderDeps?: ViewerLoaderDeps;
}

/**
 * doc-access-routing S-002: the DOC-ADDRESSED read endpoint `GET /api/docs/:slug`
 * (no `/api/w/:workspaceId` prefix). The slug is globally unique (schema.ts:29), so the
 * link alone identifies the doc (C-002/C-007/C-010) and access is decided by the doc via
 * the single `resolveAccess` gate (S-001), not by a workspace in the path.
 *
 * It differs from the workspace-scoped `viewerDocRoutes` in exactly three ways:
 *   (a) no `:workspaceId` path param — addressed by slug alone (C-007);
 *   (b) the session is OPTIONAL, resolved from the raw Request — an anon is allowed
 *       (C-004), so there is NO `requireSession`/`requireWorkspaceMember` gate;
 *   (c) a no-access OR missing doc → the SAME 404 NOT_FOUND (existence-hiding, C-004),
 *       byte-identical for anon and signed-in, and NEVER a 401/UNAUTHENTICATED that the
 *       frontend's global handler would turn into a sign-in redirect.
 *
 * It reuses the SAME loader (createLoadViewerDoc) + `toResponse` shape as the
 * workspace-scoped route: markdown → sanitized app-origin HTML (C-006); html/image →
 * a `{ contentUrl: "/v/:versionId" }` sandbox reference, never inline (C-006).
 */
export function docViewerRoutes(deps: DocViewerRoutesDeps) {
  const loadViewerDoc =
    deps.loadViewerDoc ??
    (() => {
      if (!deps.loaderDeps) {
        throw new Error("docViewerRoutes requires either `loadViewerDoc` or `loaderDeps`");
      }
      return createLoadViewerDoc(deps.loaderDeps);
    })();

  // Optional session: no resolver, or no cookie → an anonymous viewer (C-004). The
  // route never throws UnauthenticatedError, so the response for a no-access doc is the
  // same 404 whether the caller is signed in or not.
  const resolveViewer = async (request: Request): Promise<Viewer> => {
    // C-006: an anon viewer carries its admission cookie so resolveAccess can validate it
    // against the doc's current capability token (resolveAdmission) and admit at the link
    // role — exactly as annotations.ts threads it for the anon annotation reads/writes. The
    // SPA viewer loads this doc-read FIRST, so without the cookie an anon who redeemed a
    // valid capability link would still 404 here (the S-002 C-006 fix had missed this seam).
    const anonViewer = (): Viewer => ({ kind: "anon", admissionCookie: readAdmissionCookie(request) });
    if (!deps.resolveViewerSession) return anonViewer();
    const session = await deps.resolveViewerSession(request);
    return session ? { kind: "user", userId: session.userId } : anonViewer();
  };

  return apiEnvelope(new Elysia()).get("/api/docs/:slug", async ({ params, request, set }) => {
    // H-6: never leak a doc URL in a Referer even from the JSON read path (defense in depth).
    set.headers["Referrer-Policy"] = "no-referrer";
    const viewer = await resolveViewer(request);
    const payload = await loadViewerDoc(params.slug, viewer);
    // Existence-hiding (C-004): a missing doc AND a no-access doc return the SAME
    // NOT_FOUND — never a 401 — so anon and signed-in callers get byte-identical bodies
    // and the FE's global 401 handler can never turn this into a sign-in redirect.
    if (!payload) throw new NotFoundError();
    return toResponse(payload);
  });
}

/**
 * viewer-overflow-menu S-005: the DOC-ADDRESSED raw download `GET /api/docs/:slug/download`.
 * BARE (no apiEnvelope) — it returns a raw file Response (bytes/text + Content-Disposition), like
 * the /v/:id content surface, NOT the JSON envelope. It reuses the SAME loader + access model as
 * the doc read (`docViewerRoutes` → createLoadViewerDoc → resolveAccess): a caller must have at
 * least viewer access under EITHER axis (workspace/generic OR link/people), or the download is
 * refused with the same existence-hiding 404 as the read (C-007/AS-017). The body is the faithful
 * raw source by kind (markdown → .md, html → .html source, image → original bytes; C-006/AS-015/016)
 * — the loader returns the raw stored content, so html is the pristine source, never the /v/:id
 * block-id/bridge-injected variant.
 */
export function docDownloadRoutes(deps: DocViewerRoutesDeps) {
  const loadViewerDoc =
    deps.loadViewerDoc ??
    (() => {
      if (!deps.loaderDeps) {
        throw new Error("docDownloadRoutes requires either `loadViewerDoc` or `loaderDeps`");
      }
      return createLoadViewerDoc(deps.loaderDeps);
    })();

  const resolveViewer = async (request: Request): Promise<Viewer> => {
    const anonViewer = (): Viewer => ({ kind: "anon", admissionCookie: readAdmissionCookie(request) });
    if (!deps.resolveViewerSession) return anonViewer();
    const session = await deps.resolveViewerSession(request);
    return session ? { kind: "user", userId: session.userId } : anonViewer();
  };

  return new Elysia().get("/api/docs/:slug/download", async ({ params, request, set }) => {
    set.headers["Referrer-Policy"] = "no-referrer";
    const viewer = await resolveViewer(request);
    let payload: ViewerDocPayload | null;
    try {
      payload = await loadViewerDoc(params.slug, viewer);
    } catch (e) {
      // A soft-deleted doc the caller could otherwise see → 410 (mirrors the read's deleted notice);
      // no prior access never reaches here (resolveAccess returns plain DENIED → null → 404 below).
      if (e instanceof DocDeletedError) return new Response("Gone", { status: 410 });
      throw e;
    }
    // Existence-hiding (C-007/AS-017): a missing doc AND a no-view doc both → 404, never the bytes.
    if (!payload) return new Response("Not found", { status: 404 });

    const dl = buildDocDownload(payload.content, payload.kind, payload.title);
    // `dl.body` is string | Uint8Array; both are valid BodyInit at runtime (the DOM lib's typing
    // omits the Uint8Array<ArrayBufferLike> generic, so cast).
    return new Response(dl.body as BodyInit, {
      headers: {
        "Content-Type": dl.contentType,
        // RFC 5987: ASCII fallback + UTF-8 form so non-ascii titles download with a sane name.
        "Content-Disposition": `attachment; filename="${dl.filename}"; filename*=UTF-8''${encodeURIComponent(dl.filename)}`,
        "Referrer-Policy": "no-referrer",
      },
    });
  });
}
