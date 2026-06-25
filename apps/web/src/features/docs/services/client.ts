import { api } from "@/lib/api";
import type { EdenResult } from "@/lib/api/use-api-query";

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

/**
 * GET /api/w/:workspaceId/projects — list projects (workspace-project S-003). Active by default;
 * pass `includeArchived` to also list archived projects (the "Show archived" toggle, AS-005).
 * Each project row carries a server-computed `docCount` (its accessible-doc count, AS-028) so the
 * Projects browser renders the "N docs" badge from this one read — no per-project follow-up fetch.
 */
export function fetchProjects(
  workspaceId: string,
  includeArchived = false,
  page?: number,
  limit?: number,
): Promise<EdenResult<unknown>> {
  // S-008: the list endpoint now accepts page/limit and returns a `pagination` block alongside
  // `projects` (the domain key is retained). Omit the params when not paginating so the response
  // shape is unchanged for the picker/complete-set consumers.
  const q: Record<string, string> = {};
  if (includeArchived) q.includeArchived = "true";
  if (page != null) q.page = String(page);
  if (limit != null) q.limit = String(limit);
  const query = Object.keys(q).length ? { query: q } : undefined;
  return treaty.api.w({ workspaceId }).projects.get(query) as Promise<EdenResult<unknown>>;
}

/** GET /api/w/:workspaceId/projects/:id/docs — access-filtered docs in a project (S-003/AS-006).
 *  S-008: accepts page/limit and returns `{ docs, pagination }` (domain key retained). */
export function fetchProjectDocs(
  workspaceId: string,
  projectId: string,
  page?: number,
  limit?: number,
): Promise<EdenResult<unknown>> {
  const q: Record<string, string> = {};
  if (page != null) q.page = String(page);
  if (limit != null) q.limit = String(limit);
  const query = Object.keys(q).length ? { query: q } : undefined;
  return treaty.api.w({ workspaceId }).projects({ id: projectId }).docs.get(query) as Promise<
    EdenResult<unknown>
  >;
}

/**
 * GET /api/w/:workspaceId/docs?page=&limit= — the workspace-wide docs read (S-008). Returns, in
 * ONE response, a PAGE of the access-filtered doc union (each annotated with `projectId` +
 * `projectName`), the active-project list (id + name — for the move/copy picker + project-count
 * stat; NO per-project doc count, AS-024), the workspace total, and the page summary. Retires the
 * old N+1 fan-out (1 projects read + 1 per project).
 */
export function fetchWorkspaceDocs(
  workspaceId: string,
  page?: number,
  limit?: number,
): Promise<EdenResult<unknown>> {
  const q: Record<string, string> = {};
  if (page != null) q.page = String(page);
  if (limit != null) q.limit = String(limit);
  const query = Object.keys(q).length ? { query: q } : undefined;
  return treaty.api.w({ workspaceId }).docs.get(query) as Promise<EdenResult<unknown>>;
}

/** POST /api/w/:workspaceId/projects — create a project (any member, C-002). */
export function createProject(workspaceId: string, name: string): Promise<EdenResult<unknown>> {
  return treaty.api.w({ workspaceId }).projects.post({ name }) as Promise<EdenResult<unknown>>;
}

/**
 * PATCH /api/w/:workspaceId/projects/:id { name } — rename (owner-or-admin). Returns { id, name }.
 * workspace-project S-003 (workspace-project-ui AS-003).
 */
export function renameProject(
  workspaceId: string,
  projectId: string,
  name: string,
): Promise<EdenResult<unknown>> {
  return treaty.api.w({ workspaceId }).projects({ id: projectId }).patch({ name }) as Promise<
    EdenResult<unknown>
  >;
}

/**
 * POST /api/w/:workspaceId/projects/:id/archive — hide from the default browse (owner-or-admin;
 * the default project is protected). workspace-project-ui AS-004.
 */
export function archiveProject(
  workspaceId: string,
  projectId: string,
): Promise<EdenResult<unknown>> {
  return treaty.api.w({ workspaceId }).projects({ id: projectId }).archive.post() as Promise<
    EdenResult<unknown>
  >;
}

/** POST /api/w/:workspaceId/projects/:id/unarchive — show again (owner-or-admin). AS-005. */
export function unarchiveProject(
  workspaceId: string,
  projectId: string,
): Promise<EdenResult<unknown>> {
  return treaty.api.w({ workspaceId }).projects({ id: projectId }).unarchive.post() as Promise<
    EdenResult<unknown>
  >;
}

/**
 * DELETE /api/w/:workspaceId/projects/:id — delete (owner-or-admin). The backend REFUSES a
 * non-empty or default project with a 409 CONFLICT envelope (C-002); the caller surfaces that
 * reason. workspace-project-ui AS-006/AS-007.
 */
export function deleteProject(
  workspaceId: string,
  projectId: string,
): Promise<EdenResult<unknown>> {
  return treaty.api.w({ workspaceId }).projects({ id: projectId }).delete() as Promise<
    EdenResult<unknown>
  >;
}

/** GET /api/w/:workspaceId/search?q= — full-text search across accessible docs (S-005). */
export function searchDocs(
  workspaceId: string,
  q: string,
  projectId?: string,
  page?: number,
  limit?: number,
): Promise<EdenResult<unknown>> {
  // S-008: search now paginates server-side; page/limit ride the query alongside q/projectId,
  // and the response carries a `pagination` block next to the retained `results` key.
  const query: Record<string, string> = { q };
  if (projectId) query.projectId = projectId;
  if (page != null) query.page = String(page);
  if (limit != null) query.limit = String(limit);
  return treaty.api.w({ workspaceId }).search.get({ query }) as Promise<EdenResult<unknown>>;
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

/**
 * DELETE /api/w/:workspaceId/docs/:slug — soft-delete a doc into Trash (doc-delete-trash S-001 /
 * AS-001). The doc is tombstoned (versions + annotations preserved) and disappears from every
 * listing; it can be restored from Trash. The backend gates on (owner/editor) OR workspace-admin
 * and refuses a commenter/viewer with 403 (AS-004). Returns { docId, slug, deleted: true }.
 */
export function deleteDoc(workspaceId: string, slug: string): Promise<EdenResult<unknown>> {
  return treaty.api.w({ workspaceId }).docs({ slug }).delete() as Promise<EdenResult<unknown>>;
}

/**
 * GET /api/w/:workspaceId/trash — the workspace Trash (doc-delete-trash S-003 / AS-013). Returns
 * `{ docs: [{ id, slug, title, deletedAt }] }`, scoped to this workspace (C-007 / AS-026); an empty
 * list is the empty state. Membership-gated server-side.
 */
export function listTrash(workspaceId: string): Promise<EdenResult<unknown>> {
  return treaty.api.w({ workspaceId }).trash.get() as Promise<EdenResult<unknown>>;
}

/**
 * POST /api/w/:workspaceId/trash/:id/restore — restore a deleted doc from Trash (S-003 / AS-010).
 * The doc returns to its original project (or the restorer's default when that project is gone,
 * AS-011) with annotations + versions intact, and comes back PRIVATE — both access axes off + the
 * capability token rotated (AS-023). The backend gates on (owner/editor) OR workspace-admin and
 * refuses a commenter/viewer with 403 (AS-020). Returns { docId, slug, projectId, restored: true }.
 */
export function restoreDoc(workspaceId: string, docId: string): Promise<EdenResult<unknown>> {
  return treaty.api.w({ workspaceId }).trash({ id: docId }).restore.post() as Promise<
    EdenResult<unknown>
  >;
}

/**
 * POST /api/w/:workspaceId/trash/:id/permanent — permanently (hard) delete a doc from Trash
 * (doc-delete-trash S-007 / AS-034). The doc row and its versions/annotations/comments/share_links
 * are removed from the database — gone from Trash and unrecoverable. The backend gates OWNER-OR-ADMIN
 * only (narrower than soft-delete, which also allows editors); a per-doc editor/commenter is refused
 * with 403 (AS-035). Under /trash/:id (the /docs/:slug path can't host a second :id param — it would
 * crash the app at boot); POST since it sits beside the restore POST. Returns { docId, slug, purged }.
 */
export function permanentlyDeleteDoc(
  workspaceId: string,
  docId: string,
): Promise<EdenResult<unknown>> {
  return treaty.api.w({ workspaceId }).trash({ id: docId }).permanent.post() as Promise<
    EdenResult<unknown>
  >;
}
