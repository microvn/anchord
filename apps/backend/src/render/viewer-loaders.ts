// render-publish S-002/S-003/S-004 — the access-gated doc viewer loaders.
//
// These back the doc-scoped read (createLoadViewerDoc) and the /v/:id content route
// (createLoadContent, app.ts). Both are ACCESS-GATED: a missing doc OR one the caller
// cannot view BOTH return null, so the route 404s and never leaks an out-of-access doc
// (existence-hiding — sharing C-003 / api-core C-006).
//
// doc-access-routing S-006: the bare server-rendered /d/:slug loader (createLoadViewer)
// was removed — the share link opens the in-app SPA viewer. /v/:id (content surface) and
// createLoadViewerDoc (the doc-scoped read) stay.
//
// doc-access-routing S-001: the gate is now the SINGLE authoritative `resolveAccess`
// (sharing/resolve-access.ts). It folds owner + invited + workspace-when-in-workspace +
// link-when-with-link, resolved against the doc's OWN workspace, and handles the anon
// path (anon may view only anyone_with_link). This REPLACES the old two-layer gate
// (structural canViewDoc pre-gate + resolveDocRole) whose permissive stubs decided
// nothing and whose structural pre-gate wrongly blocked an invited outsider on an
// anyone_in_workspace doc (AS-002). canView ⇔ resolveAccess returns a non-null role.

import { desc, eq } from "drizzle-orm";
import { docs, docVersions, shareLinks } from "../db/schema";
import { deriveLevel } from "../sharing/derive-level";
import type { DB } from "../db/client";
import type { GeneralAccessLevel, Viewer } from "../sharing/access";
import type { AxisRole } from "../sharing/share";
import type { Role } from "../sharing/roles";
import type { AccessResult } from "../sharing/resolve-access";
import { DocDeletedError } from "../http/errors";
import type { ViewerDoc } from "../app";

export interface ViewerLoaderDeps {
  db: DB;
  /**
   * The SINGLE authoritative access gate (sharing/resolve-access.createResolveAccess):
   * `(docId, viewer) → { role, canView }`. The loaders carry the same instance the
   * annotation + version read paths gate on, so authorization is decided in one place.
   */
  resolveAccess: (docId: string, viewer: Viewer) => Promise<AccessResult>;
  /**
   * doc-access-routing S-003/AS-030: resolve the doc's OWN workspace
   * (docs.project_id → projects.workspace_id), `null` when the doc has no project (C-011).
   * The doc-read response carries this so the doc-scoped public viewer can feed the
   * member-only, workspace-addressed Share dialog + Version history their workspaceId
   * (there is no `:workspaceId` URL param on the doc-scoped route). Reuses the same
   * tenancy helper (`createWorkspaceAccess.workspaceOfDoc`) the access resolver uses.
   * Optional so existing callers/tests that don't supply it stay compatible (→ null).
   */
  workspaceOfDoc?: (docId: string) => Promise<string | null>;
}

/**
 * Decide whether `viewer` may view `docId` — delegates to the single `resolveAccess`
 * gate. Denied → false → the caller maps to null (existence-hiding).
 *
 * `generalAccess` is no longer consulted here (resolveAccess reads it itself); the
 * parameter is kept for call-site compatibility and ignored.
 */
export async function canViewVisible(
  deps: ViewerLoaderDeps,
  docId: string,
  _generalAccess: GeneralAccessLevel,
  viewer: Viewer,
): Promise<boolean> {
  const { canView } = await deps.resolveAccess(docId, viewer);
  return canView;
}

/**
 * The doc payload the in-app React viewer (S-005, direction B) loads by slug.
 * Carries the metadata (title, kind, current version number, status, generalAccess)
 * plus the version id needed to build the `/v/:id` sandbox reference for html/image.
 * The route turns this into the `GET /api/w/:workspaceId/docs/:slug` JSON: markdown
 * → sanitized app-theme HTML in `content` (C-008/C-002); html/image → a
 * `{ contentUrl: "/v/<versionId>" }` reference, never the untrusted content inline.
 */
export interface ViewerDocPayload {
  versionId: string;
  title: string;
  kind: ViewerDoc["kind"];
  /** Current (highest) version number. */
  version: number;
  /**
   * Doc lifecycle status. render-publish has no draft state (C-004: create → version 1),
   * so any doc that reaches the viewer (it has ≥1 published version, the loader requires
   * one) is "published". Derived, not a stored column — see the S-005 spec signal.
   */
  status: "published";
  /**
   * doc-access-two-axis S-006 / C-008: the DERIVED legacy general-access summary (deriveLevel),
   * never stored. LOSSY — it collapses {workspace=set, link=set} and {workspace=off, link=set}
   * both to "anyone_with_link", so the raw axes below accompany it (AS-027).
   */
  generalAccess: GeneralAccessLevel;
  /**
   * doc-access-two-axis S-006 / C-008: the RAW two-axis state read straight off share_links —
   * `workspaceRole`/`linkRole` (null = that axis is off). Carried ALONGSIDE the lossy
   * `generalAccess` summary so a richer client (the Share dialog) can tell a workspace-shared doc
   * from a link-only one — the distinction the 3-value summary drops (AS-021/022/027).
   */
  workspaceRole: AxisRole;
  linkRole: AxisRole;
  /**
   * The logged-in caller's effective role on this doc (owner/editor/commenter/viewer), resolved
   * via the authoritative `resolveDocRole` (highest-wins over membership + invite + link + owner).
   * `null` for an anon caller (no session userId). The in-app viewer gates the Share affordance on
   * this (sharing-permissions-ui S-001 / C-002): owner/editor → Share button; viewer/commenter →
   * none. Without it the owner's Share button never renders (the consumer's linked-field).
   */
  effectiveRole: Role | null;
  /**
   * doc-access-routing S-003/AS-030: the doc's OWN workspace id (resolved via
   * project → workspace), or `null` when the doc has no project (C-011). The doc-scoped
   * public viewer has no `:workspaceId` URL param, so the member-only Share dialog +
   * Version history (kept workspace-addressed per C-007) source their workspace from THIS
   * field. A signed-in member with a non-null workspaceId sees those panels; an anon or a
   * project-less doc (null) → panels hidden. Response field only — no schema change.
   */
  workspaceId: string | null;
  /** Raw current-version content (markdown text / html / image url) — the route renders it. */
  content: string;
}

/**
 * Build the access-gated S-005 loader: doc-by-slug → meta + current-version content,
 * for the in-app React viewer. Two-layer existence-hiding gate (a missing doc OR one the
 * caller cannot view BOTH return null → the route 404s, AS-018).
 */
export function createLoadViewerDoc(
  deps: ViewerLoaderDeps,
): (slug: string, viewer: Viewer) => Promise<ViewerDocPayload | null> {
  return async (slug, viewer) => {
    const [row] = await deps.db
      .select({
        id: docs.id,
        title: docs.title,
        kind: docs.kind,
        // doc-access-two-axis S-001 stopgap: derive the legacy level from the two axes.
        workspaceRole: shareLinks.workspaceRole,
        linkRole: shareLinks.linkRole,
      })
      .from(docs)
      .leftJoin(shareLinks, eq(shareLinks.docId, docs.id))
      .where(eq(docs.slug, slug))
      .limit(1);
    if (!row) return null;
    const doc = {
      id: row.id,
      title: row.title,
      kind: row.kind,
      // doc-access-two-axis S-006 / C-008: carry BOTH the raw axes and the derived summary.
      workspaceRole: row.workspaceRole,
      linkRole: row.linkRole,
      generalAccess: deriveLevel(row.workspaceRole, row.linkRole),
    };
    // doc-access-routing S-001: ONE resolveAccess call gives BOTH the view gate AND the
    // caller's effective role (for the viewer's Share gate, S-001/C-002) — no second read.
    const access = await deps.resolveAccess(doc.id, viewer);
    // doc-delete-trash S-004 / C-009 (AS-014/AS-015): a soft-deleted doc the viewer WOULD
    // HAVE had access to surfaces the gated "this doc was deleted" notice — a distinct 410
    // DocDeletedError (the FE maps it to NoAccessView variant="deleted"). A viewer with NO
    // prior access never carries this reason (resolveAccess returns plain DENIED for them),
    // so they fall through to the existence-hiding 404 below — no enumeration oracle.
    // Content is NEVER read on this branch (we throw before loading the version).
    if (access.reason === "deleted") throw new DocDeletedError();
    if (!access.canView) return null;

    // CURRENT version = highest `version` row (mirrors doc-move-repo.currentVersion / search).
    const [ver] = await deps.db
      .select({ id: docVersions.id, version: docVersions.version, content: docVersions.content })
      .from(docVersions)
      .where(eq(docVersions.docId, doc.id))
      .orderBy(desc(docVersions.version))
      .limit(1);
    if (!ver) return null; // a doc with no published version has nothing to render

    const effectiveRole = access.role;

    // AS-030: the doc's OWN workspace (project → workspace), null when project-less (C-011).
    // Resolved only when the dep is wired (prod); absent (older callers/tests) → null.
    const workspaceId = deps.workspaceOfDoc ? await deps.workspaceOfDoc(doc.id) : null;

    return {
      versionId: ver.id,
      title: doc.title,
      kind: doc.kind,
      version: ver.version,
      status: "published",
      generalAccess: doc.generalAccess,
      // S-006 / C-008: raw axes alongside the lossy summary (AS-027).
      workspaceRole: doc.workspaceRole,
      linkRole: doc.linkRole,
      effectiveRole,
      workspaceId,
      content: ver.content,
    };
  };
}

/** Build the access-gated /v/:id content loader (gates on the version's OWN doc). */
export function createLoadContent(
  deps: ViewerLoaderDeps,
): (versionId: string, viewer: Viewer) => Promise<{ content: string; kind: ViewerDoc["kind"] } | null> {
  return async (versionId, viewer) => {
    const [row] = await deps.db
      .select({
        content: docVersions.content,
        docId: docs.id,
        kind: docs.kind,
        // doc-access-two-axis S-001 stopgap: derive the legacy level from the two axes.
        workspaceRole: shareLinks.workspaceRole,
        linkRole: shareLinks.linkRole,
      })
      .from(docVersions)
      .innerJoin(docs, eq(docs.id, docVersions.docId))
      .leftJoin(shareLinks, eq(shareLinks.docId, docs.id))
      .where(eq(docVersions.id, versionId))
      .limit(1);
    if (!row) return null;
    const generalAccess = deriveLevel(row.workspaceRole, row.linkRole);
    if (!(await canViewVisible(deps, row.docId, generalAccess, viewer))) return null;
    return { content: row.content, kind: row.kind };
  };
}
