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
