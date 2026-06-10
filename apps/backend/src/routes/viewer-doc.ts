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
// (createLoadViewerDoc → canViewVisible → canViewDoc + resolveDocRole): a missing doc OR one
// the caller cannot view BOTH come back null → 404 (AS-018, C-008).

import { Elysia } from "elysia";
import { apiEnvelope } from "../http/envelope";
import {
  requireSession,
  requireWorkspaceMember,
  type SessionResolver,
  type WorkspaceRoleResolver,
} from "../http/auth-gate";
import { NotFoundError } from "../http/errors";
import { renderMarkdown } from "../render/markdown";
import { createLoadViewerDoc, type ViewerLoaderDeps, type ViewerDocPayload } from "../render/viewer-loaders";
import type { Viewer } from "../sharing/access";

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
  doc: { title: string; kind: ViewerDocPayload["kind"]; version: number; status: "published"; generalAccess: ViewerDocPayload["generalAccess"] };
  content: string | { contentUrl: string };
} {
  const doc = {
    title: payload.title,
    kind: payload.kind,
    version: payload.version,
    status: payload.status,
    generalAccess: payload.generalAccess,
  };
  if (payload.kind === "markdown") {
    // C-002/C-008: markdown is rendered in the APP origin → MUST be sanitized (dompurify).
    return { doc, content: renderMarkdown(payload.content) };
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
    .get("/api/w/:workspaceId/docs/:slug", async ({ params, actor }) => {
      // The viewer (Viewer) is the SERVER-resolved session actor — never a body field.
      const viewer: Viewer = { kind: "user", userId: actor.userId };
      const payload = await loadViewerDoc(params.slug, viewer);
      // A missing doc OR one the caller cannot view → the same 404 (existence-hiding, C-008/AS-018).
      if (!payload) throw new NotFoundError();
      return toResponse(payload);
    });
}
