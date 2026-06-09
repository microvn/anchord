// HTTP route mount for the versioning-diff cluster (stories S-001..S-004).
//
// INTEGRATION GLUE: wires the already-built, already-unit-tested version + diff
// services (src/services/version.ts, src/services/diff.ts) onto Elysia routes per
// the versioning-diff `## API` contract, composing the api-core HTTP layer
// (envelope + auth gate + Zod validation + pagination + existence-hiding). No new
// version/diff behaviour lives here — handlers resolve :slug → doc, gate access,
// call the service, and shape the response.
//
// Contract (versioning-diff ## API):
//   POST   /api/docs/:slug/versions            → S-001 AS-001  (editor) 201 { version, previousVersion }
//   PATCH  /api/docs/:slug                      → S-001 AS-002  (editor) 200 { slug, title }  (NO version)
//   GET    /api/docs/:slug/versions            → S-002 AS-003  (viewer+) 200 { items, pagination }
//   POST   /api/docs/:slug/versions/:n/restore → S-003 AS-004  (editor) 201 { version, previousVersion }
//   GET    /api/docs/:slug/diff?from=&to=      → S-004 AS-006/7/8 (viewer+) 200 { mode, ... }
//
// EXISTENCE-HIDING (C-006): for EVERY route, a missing doc OR a doc the caller
// cannot view collapses to 404 via enforceReadAccess — a write to a doc you can't
// see is 404 (not 403). 403 is reserved for a VISIBLE doc whose role is too low.

import { Elysia } from "elysia";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { apiEnvelope } from "../http/envelope";
import {
  requireSession,
  requireCapability,
  requireWorkspaceMember,
  type SessionResolver,
  type WorkspaceRoleResolver,
} from "../http/auth-gate";
import { withValidation } from "../http/validate";
import { ValidationError, NotFoundError } from "../http/errors";
import { enforceReadAccess } from "../http/access-result";
import { paginationQuery, paginate, type PaginationParams } from "../http/pagination";
import { canViewDoc, type AccessDeps, type Viewer } from "../sharing/access";
import { type Role } from "../sharing/roles";
import {
  appendVersion,
  updateTitle,
  listVersionHistory,
  restoreVersion,
} from "../services/version";
import { compareVersions } from "../services/diff";
import type { VersionRepo } from "../services/version";
import { createVersionRepo } from "../services/version-repo";
import { docs, docVersions } from "../db/schema";
import type { DB } from "../db/client";
import type { GeneralAccessLevel } from "../sharing/access";

/**
 * The doc fields a route needs once it has resolved a `:slug`: the id (for the
 * version service), the access level + kind (for the gate / diff mode), and the
 * current title. `null` when no doc with that slug exists.
 */
export interface DocLookup {
  id: string;
  title: string;
  kind: "html" | "markdown" | "image";
  generalAccess: GeneralAccessLevel;
}

/**
 * Read port: resolve a doc by slug, plus read a single version's content+hash for
 * the diff endpoint. Both are injectable (fake in route tests, Drizzle in prod).
 */
export interface DocLookupRepo {
  /** Find a doc by its (immutable) slug, or null if none exists. */
  findDocBySlug(slug: string): Promise<DocLookup | null>;
  /** Read a single version's content+hash for the diff, or null if it doesn't exist. */
  getVersionContent(
    docId: string,
    version: number,
  ): Promise<{ content: string; contentHash: string } | null>;
}

/** Concrete Drizzle-backed DocLookupRepo — thin read glue. */
export function createDocLookupRepo(db: DB): DocLookupRepo {
  return {
    async findDocBySlug(slug) {
      const [row] = await db
        .select({
          id: docs.id,
          title: docs.title,
          kind: docs.kind,
          generalAccess: docs.generalAccess,
        })
        .from(docs)
        .where(eq(docs.slug, slug));
      return row ?? null;
    },
    async getVersionContent(docId, version) {
      const [row] = await db
        .select({ content: docVersions.content, contentHash: docVersions.contentHash })
        .from(docVersions)
        .where(and(eq(docVersions.docId, docId), eq(docVersions.version, version)));
      return row ?? null;
    },
  };
}

/**
 * DOC-SCOPED ROLE SEAM (sharing-permissions, built next).
 *
 * Editor-gated writes need the caller's EFFECTIVE role for THIS doc (resolved
 * across owner / invite / link general-access). That concrete resolution is
 * sharing-permissions' repo, which lands when the sharing routes are mounted. For
 * THIS cluster we depend on a `resolveDocRole(docId, userId)` PORT: a fake in
 * tests, and (until sharing routes exist) a conservative real default wired in
 * index.ts. Returning `null` means "no doc-scoped role" → treated as least
 * privilege at the call site (editor check fails → 403).
 */
export type ResolveDocRole = (docId: string, userId: string) => Promise<Role | null>;

export interface VersionsRoutesDeps {
  /** Drizzle handle — builds the concrete VersionRepo + DocLookupRepo per request. */
  db?: DB;
  /** Pre-built version repo (tests). Wins over `db`. */
  versionRepo?: VersionRepo;
  /** Pre-built doc-lookup repo (tests). Wins over `db`. */
  lookupRepo?: DocLookupRepo;
  /** Resolves the better-auth session → actor; gates every route (401 if none). */
  resolveSession: SessionResolver;
  /** workspaces S-006: resolves the caller's role in :workspaceId for the path-scoped gate. */
  resolveWorkspaceRole: WorkspaceRoleResolver;
  /** Doc-scoped effective-role resolver (the sharing seam — see ResolveDocRole). */
  resolveDocRole: ResolveDocRole;
  /**
   * Access deps for `canViewDoc` (invite / workspace-membership ports). These are
   * sharing-permissions / workspace-project seams too; inject a fake in tests and
   * the conservative concrete impls in index.ts.
   */
  accessDeps: AccessDeps;
}

const versionBodySchema = z.object({
  content: z.string(),
  contentHash: z.string().optional(),
});

const titleBodySchema = z.object({
  title: z.string(),
});

const diffQuerySchema = z.object({
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive(),
});

function sha256Hex(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(new TextEncoder().encode(text));
  return hasher.digest("hex");
}

/**
 * Elysia plugin factory for the versioning-diff `/api/docs/:slug/...` routes.
 *
 * Mirrors docsRoutes: apiEnvelope FIRST, then requireSession, then per-route
 * withValidation, then the handler. A thrown DomainError (Unauthenticated /
 * Validation / NotFound / Forbidden) is shaped by the envelope's onError.
 */
export function versionsRoutes(deps: VersionsRoutesDeps) {
  const versionRepo: VersionRepo =
    deps.versionRepo ??
    (() => {
      if (!deps.db) throw new Error("versionsRoutes requires `versionRepo` or `db`");
      return createVersionRepo(deps.db);
    })();

  const lookupRepo: DocLookupRepo =
    deps.lookupRepo ??
    (() => {
      if (!deps.db) throw new Error("versionsRoutes requires `lookupRepo` or `db`");
      return createDocLookupRepo(deps.db);
    })();

  /**
   * Resolve :slug → a visible DocLookup or throw 404 (existence-hiding, C-006).
   * Used by EVERY route: missing doc OR no view-access both collapse to 404 here,
   * BEFORE any role check — so a write to an invisible doc is 404, not 403.
   */
  async function loadVisibleDoc(slug: string, userId: string): Promise<DocLookup> {
    const doc = await lookupRepo.findDocBySlug(slug);
    const viewer: Viewer = { kind: "user", userId };
    const allowed =
      doc !== null &&
      canViewDoc({
        docId: doc.id,
        generalAccess: doc.generalAccess,
        viewer,
        deps: deps.accessDeps,
      }).allowed;
    return enforceReadAccess({ doc, allowed });
  }

  /** Gate an editor-only write on the caller's doc-scoped role → 403 if too low. */
  async function requireEditor(docId: string, userId: string): Promise<void> {
    const role = await deps.resolveDocRole(docId, userId);
    // No doc-scoped role → least privilege (viewer); the capability check fails → 403.
    requireCapability({ userId, role: role ?? "viewer" }, "edit");
  }

  return (
    apiEnvelope(new Elysia())
      .use(requireSession({ resolveSession: deps.resolveSession }))
      .use(requireWorkspaceMember({ resolveWorkspaceRole: deps.resolveWorkspaceRole }))

      // ── POST /api/docs/:slug/versions — S-001 / AS-001 (append a new version) ──
      .group("", (app) =>
        app
          .use(withValidation(versionBodySchema))
          .post("/api/w/:workspaceId/docs/:slug/versions", async ({ params, actor, validBody, set }) => {
            const { content, contentHash } = validBody as z.infer<typeof versionBodySchema>;
            const doc = await loadVisibleDoc(params.slug, actor.userId); // 404 if missing/hidden
            await requireEditor(doc.id, actor.userId); // 403 if not editor
            const result = await appendVersion(
              doc.id,
              content,
              contentHash ?? sha256Hex(content),
              versionRepo,
              // C-005 (auth-routes S-003): record the publisher from the SERVER-resolved
              // session actor, never from the request body. published_by is now a
              // text FK → user.id (auth-routes S-001 retyped it), so the real
              // better-auth id persists.
              actor.userId,
              // S-005 / C-006: the doc's kind drives extract-text so the appended
              // (now current) version is searchable — closing the past-v1 content hole.
              doc.kind,
            );
            set.status = 201;
            return { version: result.version, previousVersion: result.previousVersion };
          }),
      )

      // ── PATCH /api/docs/:slug — S-001 / AS-002 (title only, NO new version) ──
      .group("", (app) =>
        app
          .use(withValidation(titleBodySchema))
          .patch("/api/w/:workspaceId/docs/:slug", async ({ params, actor, validBody }) => {
            const { title } = validBody as z.infer<typeof titleBodySchema>;
            const doc = await loadVisibleDoc(params.slug, actor.userId);
            await requireEditor(doc.id, actor.userId);
            await updateTitle(doc.id, title, versionRepo); // does NOT touch doc_versions
            return { slug: params.slug, title };
          }),
      )

      // ── GET /api/docs/:slug/versions — S-002 / AS-003 (paginated history) ──
      .get(
        "/api/w/:workspaceId/docs/:slug/versions",
        async ({ params, actor, query }) => {
          const doc = await loadVisibleDoc(params.slug, actor.userId); // viewer+ via canViewDoc
          const page = paginationQuery().parse(query) as PaginationParams;
          const all = await listVersionHistory(doc.id, versionRepo);
          const total = all.length;
          const start = (page.page - 1) * page.limit;
          const items = all.slice(start, start + page.limit);
          return paginate(items, { page: page.page, limit: page.limit, total });
        },
      )

      // ── POST /api/docs/:slug/versions/:n/restore — S-003 / AS-004 ──
      .post(
        "/api/w/:workspaceId/docs/:slug/versions/:n/restore",
        async ({ params, actor, set }) => {
          const target = Number(params.n);
          if (!Number.isInteger(target) || target < 1) {
            throw new ValidationError("version must be an integer >= 1", { field: "n" });
          }
          const doc = await loadVisibleDoc(params.slug, actor.userId); // 404 if missing/hidden
          await requireEditor(doc.id, actor.userId); // 403 if not editor
          let result;
          try {
            // C-005: publisher from session. S-005 / C-006: pass kind so the restored
            // (now current) content is re-indexed for search.
            result = await restoreVersion(doc.id, target, versionRepo, actor.userId, doc.kind);
          } catch {
            // restoreVersion throws when version n does not exist → 404 (doc visible,
            // but the specific version is missing).
            throw new NotFoundError(`Version ${target} not found`);
          }
          set.status = 201;
          return { version: result.version, previousVersion: result.previousVersion };
        },
      )

      // ── GET /api/docs/:slug/diff?from=&to= — S-004 / AS-006/007/008 ──
      .get(
        "/api/w/:workspaceId/docs/:slug/diff",
        async ({ params, actor, query }) => {
          const parsed = diffQuerySchema.safeParse(query);
          if (!parsed.success) {
            throw new ValidationError("from and to must be positive integers", {
              field: parsed.error.issues[0]?.path.map(String).join(".") ?? "from",
            });
          }
          const { from, to } = parsed.data;
          const doc = await loadVisibleDoc(params.slug, actor.userId); // viewer+
          const a = await lookupRepo.getVersionContent(doc.id, from);
          const b = await lookupRepo.getVersionContent(doc.id, to);
          if (!a) throw new NotFoundError(`Version ${from} not found`);
          if (!b) throw new NotFoundError(`Version ${to} not found`);
          return compareVersions({
            kind: doc.kind,
            a: {
              version: from,
              content: a.content,
              contentHash: a.contentHash,
              renderTarget: `/v/${doc.id}/${from}`,
            },
            b: {
              version: to,
              content: b.content,
              contentHash: b.contentHash,
              renderTarget: `/v/${doc.id}/${to}`,
            },
          });
        },
      )
  );
}
