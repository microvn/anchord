// render-publish S-002/S-003/S-004 — the access-gated doc viewer loaders.
//
// These back the /d/:slug and /v/:id routes (app.ts). Both are ACCESS-GATED: a missing
// doc OR one the caller cannot view BOTH return null, so the route 404s and never leaks
// an out-of-access doc (existence-hiding — sharing C-003 / api-core C-006).
//
// The gate reuses the EXISTING access model — it invents no new rule:
//   1. canViewDoc (the structural general_access level rule). Authoritative for the anon
//      path: a restricted / anyone_in_workspace doc is denied to an anon caller, no leak.
//   2. For a logged-in caller on a non-open doc, the authoritative async resolveDocRole
//      (real invited doc_members + share-link role + workspace membership + owner) must
//      return SOME role. No role → denied. anyone_with_link is open to all → skip the read.
//      (The sync canViewDoc deps are permissive by design in the v0 wiring — see index.ts;
//      resolveDocRole is the authoritative seam, so the loaders consult it for the gate.)

import { desc, eq } from "drizzle-orm";
import { docs, docVersions } from "../db/schema";
import type { DB } from "../db/client";
import { canViewDoc, type AccessDeps, type GeneralAccessLevel, type Viewer } from "../sharing/access";
import type { Role } from "../sharing/roles";
import type { ViewerDoc } from "../app";

export interface ViewerLoaderDeps {
  db: DB;
  /** Structural canViewDoc ports (anon/level rule). */
  accessDeps: AccessDeps;
  /** Authoritative doc-scoped effective-role read (membership/invite/owner). null → no role. */
  resolveDocRole: (docId: string, userId: string) => Promise<Role | null>;
}

/**
 * Decide whether `viewer` may view a doc at `generalAccess` — the two-layer gate above.
 * Denied → false → the caller maps to null (existence-hiding).
 */
export async function canViewVisible(
  deps: ViewerLoaderDeps,
  docId: string,
  generalAccess: GeneralAccessLevel,
  viewer: Viewer,
): Promise<boolean> {
  const structural = canViewDoc({ docId, generalAccess, viewer, deps: deps.accessDeps }).allowed;
  if (!structural) return false;
  if (generalAccess === "anyone_with_link" || viewer.kind === "anon") return structural;
  // Logged-in caller on restricted / anyone_in_workspace → require a concrete role.
  const role = await deps.resolveDocRole(docId, viewer.userId);
  return role !== null;
}

/** Build the access-gated /d/:slug loader. */
export function createLoadViewer(
  deps: ViewerLoaderDeps,
): (slug: string, viewer: Viewer) => Promise<ViewerDoc | null> {
  return async (slug, viewer) => {
    const [doc] = await deps.db
      .select({
        id: docs.id,
        slug: docs.slug,
        title: docs.title,
        kind: docs.kind,
        generalAccess: docs.generalAccess,
      })
      .from(docs)
      .where(eq(docs.slug, slug))
      .limit(1);
    if (!doc) return null;
    if (!(await canViewVisible(deps, doc.id, doc.generalAccess, viewer))) return null;

    // CURRENT version = highest `version` row (mirrors doc-move-repo.currentVersion / search).
    const [ver] = await deps.db
      .select({ id: docVersions.id, content: docVersions.content })
      .from(docVersions)
      .where(eq(docVersions.docId, doc.id))
      .orderBy(desc(docVersions.version))
      .limit(1);
    if (!ver) return null; // a doc with no published version has nothing to render

    return {
      versionId: ver.id,
      slug: doc.slug,
      title: doc.title,
      kind: doc.kind,
      content: ver.content,
    };
  };
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
  generalAccess: GeneralAccessLevel;
  /** Raw current-version content (markdown text / html / image url) — the route renders it. */
  content: string;
}

/**
 * Build the access-gated S-005 loader: doc-by-slug → meta + current-version content,
 * for the in-app React viewer. Same two-layer existence-hiding gate as createLoadViewer
 * (a missing doc OR one the caller cannot view BOTH return null → the route 404s, AS-018).
 */
export function createLoadViewerDoc(
  deps: ViewerLoaderDeps,
): (slug: string, viewer: Viewer) => Promise<ViewerDocPayload | null> {
  return async (slug, viewer) => {
    const [doc] = await deps.db
      .select({
        id: docs.id,
        title: docs.title,
        kind: docs.kind,
        generalAccess: docs.generalAccess,
      })
      .from(docs)
      .where(eq(docs.slug, slug))
      .limit(1);
    if (!doc) return null;
    if (!(await canViewVisible(deps, doc.id, doc.generalAccess, viewer))) return null;

    // CURRENT version = highest `version` row (mirrors createLoadViewer / search).
    const [ver] = await deps.db
      .select({ id: docVersions.id, version: docVersions.version, content: docVersions.content })
      .from(docVersions)
      .where(eq(docVersions.docId, doc.id))
      .orderBy(desc(docVersions.version))
      .limit(1);
    if (!ver) return null; // a doc with no published version has nothing to render

    return {
      versionId: ver.id,
      title: doc.title,
      kind: doc.kind,
      version: ver.version,
      status: "published",
      generalAccess: doc.generalAccess,
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
        generalAccess: docs.generalAccess,
      })
      .from(docVersions)
      .innerJoin(docs, eq(docs.id, docVersions.docId))
      .where(eq(docVersions.id, versionId))
      .limit(1);
    if (!row) return null;
    if (!(await canViewVisible(deps, row.docId, row.generalAccess, viewer))) return null;
    return { content: row.content, kind: row.kind };
  };
}
