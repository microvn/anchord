import { api } from "../../lib/api";
import type { EdenResult } from "../../lib/use-api-query";

// Typed request thunks for the workspace-project backend routes
// (`/api/w/:id/projects`, `…/projects/:id/docs`, `…/docs`, `…/search`).
//
// Same rationale as features/workspaces/client.ts: the backend mounts these routes
// CONDITIONALLY, so the exported `App` treaty type can't statically widen to include
// them. We reach them through the SAME runtime treaty client (it resolves paths
// dynamically) and annotate the return ourselves. This is the one place the cast lives;
// component tests MOCK this module, so the cast is never exercised under test.
//
// Eden runtime path convention: static segments are property access, a `:param` segment
// is a function call carrying that param, and the verb is the leaf call.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const treaty = api as any;

/** GET /api/w/:workspaceId/projects — list projects (workspace-project S-003). */
export function fetchProjects(workspaceId: string): Promise<EdenResult<unknown>> {
  return treaty.api.w({ workspaceId }).projects.get() as Promise<EdenResult<unknown>>;
}

/** GET /api/w/:workspaceId/projects/:id/docs — access-filtered docs in a project (S-003/AS-006). */
export function fetchProjectDocs(
  workspaceId: string,
  projectId: string,
): Promise<EdenResult<unknown>> {
  return treaty.api.w({ workspaceId }).projects({ id: projectId }).docs.get() as Promise<
    EdenResult<unknown>
  >;
}

/** POST /api/w/:workspaceId/projects — create a project (any member, C-002). */
export function createProject(workspaceId: string, name: string): Promise<EdenResult<unknown>> {
  return treaty.api.w({ workspaceId }).projects.post({ name }) as Promise<EdenResult<unknown>>;
}

/** GET /api/w/:workspaceId/search?q= — full-text search across accessible docs (S-005). */
export function searchDocs(
  workspaceId: string,
  q: string,
  projectId?: string,
): Promise<EdenResult<unknown>> {
  return treaty.api.w({ workspaceId }).search.get({ query: { q, projectId } }) as Promise<
    EdenResult<unknown>
  >;
}

/** Body for the JSON publish variant. The route accepts { content, kind?, title?, projectId? }. */
export interface PublishDocBody {
  content: string;
  kind?: "html" | "markdown" | "image";
  title?: string;
  projectId?: string;
}

/** POST /api/w/:workspaceId/docs — publish an artifact (render-publish S-001). */
export function publishDoc(
  workspaceId: string,
  body: PublishDocBody,
): Promise<EdenResult<unknown>> {
  return treaty.api.w({ workspaceId }).docs.post(body) as Promise<EdenResult<unknown>>;
}

/**
 * POST /api/w/:workspaceId/docs/:slug/move { projectId } — relocate the doc as-is into another
 * project of THIS workspace (workspace-project S-004 / AS-008). Returns { docId, slug, projectId }.
 */
export function moveDoc(
  workspaceId: string,
  slug: string,
  projectId: string,
): Promise<EdenResult<unknown>> {
  return treaty.api.w({ workspaceId }).docs({ slug }).move.post({ projectId }) as Promise<
    EdenResult<unknown>
  >;
}

/**
 * POST /api/w/:workspaceId/docs/:slug/copy { projectId } — duplicate into another project of
 * THIS workspace (a clean copy: new slug, current version as v1, no annotations; the original
 * stays). workspace-project S-004 / AS-013. Returns the NEW doc { docId, slug, projectId }.
 */
export function copyDoc(
  workspaceId: string,
  slug: string,
  projectId: string,
): Promise<EdenResult<unknown>> {
  return treaty.api.w({ workspaceId }).docs({ slug }).copy.post({ projectId }) as Promise<
    EdenResult<unknown>
  >;
}
