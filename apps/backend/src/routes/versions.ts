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
import { type Viewer } from "../sharing/access";
import { type AccessResult } from "../sharing/resolve-access";
import { type Role } from "../sharing/roles";
import {
  appendVersion,
  updateTitle,
  listVersionHistory,
  restoreVersion,
} from "../services/version";
import { compareVersions, computeLineDiff } from "../services/diff";
import type { VersionRepo } from "../services/version";
import { createVersionRepo } from "../services/version-repo";
import { emitActivity, type ActivityEmitDeps, SYSTEM_ACTOR_NAME } from "../activity/emit";
import { createActivityRepo, type ActivityRepo } from "../activity/repo";
import { docs, docVersions, shareLinks } from "../db/schema";
import { deriveLevel } from "../sharing/derive-level";
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
  /**
   * Read a single version's row id + content + hash for the diff, or null if it doesn't exist.
   * The row `id` is what the served `/v/:id` content surface resolves by (viewer-loaders'
   * createLoadContent), so the diff handler builds each side's `renderTarget` from THIS id —
   * referencing that exact version's content, never the current version's (S-004 / AS-013, C-007).
   */
  getVersionContent(
    docId: string,
    version: number,
  ): Promise<{ id: string; content: string; contentHash: string } | null>;
}

/** Concrete Drizzle-backed DocLookupRepo — thin read glue. */
export function createDocLookupRepo(db: DB): DocLookupRepo {
  return {
    async findDocBySlug(slug) {
      // doc-access-two-axis S-001 stopgap: docs.general_access is dropped — derive the
      // legacy level from the share_links axes (leftJoin so a doc with no row → restricted).
      const [row] = await db
        .select({
          id: docs.id,
          title: docs.title,
          kind: docs.kind,
          workspaceRole: shareLinks.workspaceRole,
          linkRole: shareLinks.linkRole,
        })
        .from(docs)
        .leftJoin(shareLinks, eq(shareLinks.docId, docs.id))
        .where(eq(docs.slug, slug));
      if (!row) return null;
      const { workspaceRole, linkRole, ...rest } = row;
      return { ...rest, generalAccess: deriveLevel(workspaceRole, linkRole) };
    },
    async getVersionContent(docId, version) {
      const [row] = await db
        .select({
          id: docVersions.id,
          content: docVersions.content,
          contentHash: docVersions.contentHash,
        })
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
  /** Doc-scoped effective-role resolver (used for editor-gated WRITE capability checks). */
  resolveDocRole: ResolveDocRole;
  /**
   * doc-access-routing S-001 / C-001: the SINGLE authoritative read gate for the version
   * READ surface (history, diff) — and the existence-hiding pre-gate on every write.
   * Replaces the permissive `canViewDoc` stub. `(docId, viewer) → { role, canView }`.
   */
  resolveAccess: (docId: string, viewer: Viewer) => Promise<AccessResult>;
  /**
   * doc-access-routing S-005 / C-007: resolve the viewer session OPTIONALLY from the raw
   * Request for the DOC-ADDRESSED version reads (history + diff). `{ userId }` for a
   * logged-in caller, `null` for anon — the same seam the /d, /v and `/api/docs/:slug`
   * viewer routes use. When supplied, the doc-scoped read routes are mounted (anon-capable,
   * gated only by `resolveAccess`); absent → those routes are not mounted (tests that only
   * exercise the workspace-scoped writes don't need it). The workspace-scoped routes are
   * unaffected.
   */
  resolveViewerSession?: (request: Request) => Promise<{ userId: string } | null>;
  /**
   * annotation-core S-005 / C-012: re-anchor the doc's annotations onto a newly-created
   * version. The route FIRES this (does not await) after a successful append/restore so it
   * runs OFF the publish path — it must not gate the 201, and its failure can't break a
   * successful publish. The concrete impl (index.ts) loads annotations + content, runs the
   * matcher, applies carried/detached, persists the ledger, and reports a summary. Optional:
   * absent in tests that don't exercise re-anchor.
   */
  reanchorOnNewVersion?: (input: {
    docId: string;
    version: number;
    /** RAW version content (markdown source or HTML); the job renders it before re-anchoring. */
    content: string;
    /** Doc kind — drives renderForAnchoring inside the job (markdown→HTML before the matcher). */
    kind: "html" | "markdown" | "image";
    /**
     * workspace-activity S-005 / AS-021 / F-5: the route hands re-anchor a sink for the DETACHED
     * count. The count is only known inside the (fired-not-awaited) re-anchor SUMMARY callback —
     * so the route can't read it after firing. The job invokes this with the number of annotations
     * it could NOT place; the route's `detached` activity emit lives in this sink (actor = System).
     * Optional: a re-anchor impl that doesn't report a summary simply never calls it (a lost emit
     * is acceptable per C-002). Called only when something detached (count > 0).
     */
    onDetached?: (count: number) => void | Promise<void>;
  }) => Promise<unknown> | unknown;
  /**
   * workspace-activity S-005 (C-002 / C-005 / C-008): emit version-lifecycle activity rows
   * (publish / restore / detached) after the version write commits. Best-effort post-commit — a
   * failure NEVER blocks the publish/restore (emitActivity swallows + logs, AS-006-style). Provide
   * a pre-built ActivityRepo (tests) — else one is built from `db` — plus `workspaceOfDoc` (anchors
   * the row to the doc's OWN workspace, C-008) and `resolveActorName` (resolves the actor name
   * per-emit, the session carries only userId). OMIT the whole block to leave version activity
   * logging off (a publish/restore still succeeds; no activity row) — keeps route tests that don't
   * exercise activity unchanged.
   */
  activity?: {
    repo?: ActivityRepo;
    workspaceOfDoc: (docId: string) => Promise<string | null>;
    resolveActorName: (userId: string) => Promise<string | null>;
  };
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

  // workspace-activity S-005: built only when the `activity` block is provided. The repo is
  // pre-built (tests) or built from `db`; workspaceOfDoc + resolveActorName resolve the row's owning
  // workspace (C-008) + the actor name per-emit. Absent → version activity emit is a no-op.
  const activityDeps: ActivityEmitDeps | null =
    deps.activity != null
      ? {
          repo:
            deps.activity.repo ??
            (deps.db
              ? createActivityRepo(deps.db)
              : (() => {
                  throw new Error("versionsRoutes activity requires `activity.repo` or `db`");
                })()),
          workspaceOfDoc: deps.activity.workspaceOfDoc,
          resolveActorName: deps.activity.resolveActorName,
        }
      : null;

  /**
   * workspace-activity S-005 / AS-019 (C-005): best-effort post-commit `publish` emit. meta carries
   * `from` (prev version) → `to` (new version) plus `adds`/`dels` COMPUTED HERE by splitting the
   * diff lines (F-4) — the diff service yields only a total changeCount, so we count added vs
   * removed source lines ourselves between the previous content and the just-published content.
   * NEVER throws (emitActivity swallows + logs), so it can't block the publish (C-002). No-op when
   * the activity block is unwired or there's no previous version (the doc's very first publish has
   * no from/adds/dels baseline — still emits the publish with from=null).
   */
  async function emitPublish(
    docId: string,
    actorUserId: string,
    newVersion: number,
    previousVersion: number | null,
    prevContent: string,
    newContent: string,
  ): Promise<void> {
    if (!activityDeps) return;
    // F-4: split the diff lines ourselves — added vs removed — since the diff service only totals.
    const { lines } = computeLineDiff(prevContent, newContent);
    const adds = lines.filter((l) => l.type === "added").length;
    const dels = lines.filter((l) => l.type === "removed").length;
    await emitActivity(
      {
        type: "publish",
        actorUserId,
        docId,
        meta: { from: previousVersion, to: newVersion, adds, dels },
      },
      activityDeps,
    );
  }

  /**
   * workspace-activity S-005 / AS-020 (C-005 / F-3): best-effort post-commit `restore` emit. A
   * restore reuses the version-append path but logs ONE `restore` event and NO `publish` event —
   * the route calls THIS instead of emitPublish on the restore path. meta carries `restored` (the
   * version that was restored) and `as` (the new version number it became). Never throws.
   */
  async function emitRestore(
    docId: string,
    actorUserId: string,
    restored: number,
    asVersion: number,
  ): Promise<void> {
    if (!activityDeps) return;
    await emitActivity(
      { type: "restore", actorUserId, docId, meta: { restored, as: asVersion } },
      activityDeps,
    );
  }

  /**
   * workspace-activity S-005 / AS-021 (C-005 / F-5): best-effort `detached` emit. Actor is the
   * System actor (null userId, name "System"); meta carries the `count` of annotations re-anchor
   * could not place. Invoked from the re-anchor summary sink (where the count exists) — NOT the
   * publish route, which has already returned. Never throws.
   */
  async function emitDetached(docId: string, count: number): Promise<void> {
    if (!activityDeps) return;
    await emitActivity(
      { type: "detached", actorUserId: null, actorName: SYSTEM_ACTOR_NAME, docId, meta: { count } },
      activityDeps,
    );
  }

  /**
   * Resolve :slug → a visible DocLookup or throw 404 (existence-hiding, C-006).
   * Used by EVERY route: missing doc OR no view-access both collapse to 404 here,
   * BEFORE any role check — so a write to an invisible doc is 404, not 403.
   */
  async function loadVisibleDoc(slug: string, userId: string): Promise<DocLookup> {
    const doc = await lookupRepo.findDocBySlug(slug);
    const viewer: Viewer = { kind: "user", userId };
    // S-001 / C-001: the single authoritative gate, NOT the permissive canViewDoc stub.
    const allowed = doc !== null && (await deps.resolveAccess(doc.id, viewer)).canView;
    return enforceReadAccess({ doc, allowed });
  }

  /**
   * C-012: FIRE re-anchor for a newly-created version WITHOUT awaiting it — re-anchor runs
   * off the publish path, so it never gates the response and a rejection can't break a
   * successful publish. Skipped for a doc's FIRST version (`previousVersion === null`): there
   * is no prior content whose annotations could need re-anchoring.
   */
  function fireReanchor(
    docId: string,
    version: number,
    previousVersion: number | null,
    content: string,
    kind: "html" | "markdown" | "image",
  ): void {
    if (!deps.reanchorOnNewVersion || previousVersion === null) return;
    void Promise.resolve(
      deps.reanchorOnNewVersion({
        docId,
        version,
        content,
        kind,
        // workspace-activity S-005 / AS-021 / F-5: the re-anchor summary callback hands us the
        // detached count (only known there); emit the System `detached` event from this sink. Its
        // own rejection is swallowed below — a lost emit is acceptable (C-002).
        onDetached: (count) => {
          if (count > 0) void emitDetached(docId, count);
        },
      }),
    ).catch(() => {
      // Swallowed by design (C-012): re-anchor is best-effort and must not surface into the
      // request. The concrete impl logs / alerts on its own (the >25%-detached summary).
    });
  }

  /** Gate an editor-only write on the caller's doc-scoped role → 403 if too low. */
  async function requireEditor(docId: string, userId: string): Promise<void> {
    const role = await deps.resolveDocRole(docId, userId);
    // No doc-scoped role → least privilege (viewer); the capability check fails → 403.
    requireCapability({ userId, role: role ?? "viewer" }, "edit");
  }

  /**
   * doc-access-routing S-005 / C-007: resolve the optional viewer for the DOC-ADDRESSED
   * reads — `null` resolver or no cookie → an anonymous viewer (anon-capable, C-004). These
   * routes never throw UnauthenticatedError, so a no-access doc returns the SAME 404 whether
   * the caller is signed in or not (existence-hiding, AS-025).
   */
  async function resolveViewer(request: Request): Promise<Viewer> {
    if (!deps.resolveViewerSession) return { kind: "anon" };
    const session = await deps.resolveViewerSession(request);
    return session ? { kind: "user", userId: session.userId } : { kind: "anon" };
  }

  /**
   * Doc-scoped read gate (no workspace/session middleware): resolve :slug → a visible
   * DocLookup or throw 404 (existence-hiding, AS-025) using the single `resolveAccess`,
   * for the OPTIONAL (possibly anon) viewer. Mirrors loadVisibleDoc but for the anon path.
   */
  async function loadVisibleDocForViewer(slug: string, viewer: Viewer): Promise<DocLookup> {
    const doc = await lookupRepo.findDocBySlug(slug);
    const allowed = doc !== null && (await deps.resolveAccess(doc.id, viewer)).canView;
    return enforceReadAccess({ doc, allowed });
  }

  return (
    apiEnvelope(new Elysia())
      // ── DOC-ADDRESSED version reads (S-005) — session OPTIONAL, anon-capable, gated only
      // by resolveAccess. Mounted as SIBLINGS OUTSIDE the session/workspace group below so a
      // missing session never 401s (C-004). The slug is globally unique, so the doc link
      // alone addresses these (C-007). Writes stay workspace-scoped (need workspace context).
      // ── GET /api/docs/:slug/versions — S-005 / AS-024 (history via the doc link) ──
      .get("/api/docs/:slug/versions", async ({ params, request, query }) => {
        const viewer = await resolveViewer(request);
        const doc = await loadVisibleDocForViewer(params.slug, viewer); // 404 if missing/no-access
        const page = paginationQuery().parse(query) as PaginationParams;
        const all = await listVersionHistory(doc.id, versionRepo);
        const total = all.length;
        const start = (page.page - 1) * page.limit;
        const items = all.slice(start, start + page.limit);
        return paginate(items, { page: page.page, limit: page.limit, total });
      })

      // ── GET /api/docs/:slug/diff?from=&to= — S-005 / AS-024 (diff via the doc link) ──
      .get("/api/docs/:slug/diff", async ({ params, request, query }) => {
        const parsed = diffQuerySchema.safeParse(query);
        if (!parsed.success) {
          throw new ValidationError("from and to must be positive integers", {
            field: parsed.error.issues[0]?.path.map(String).join(".") ?? "from",
          });
        }
        const { from, to } = parsed.data;
        const viewer = await resolveViewer(request);
        const doc = await loadVisibleDocForViewer(params.slug, viewer); // 404 if missing/no-access
        const a = await lookupRepo.getVersionContent(doc.id, from);
        const b = await lookupRepo.getVersionContent(doc.id, to);
        if (!a) throw new NotFoundError(`Version ${from} not found`);
        if (!b) throw new NotFoundError(`Version ${to} not found`);
        // C-007 / AS-026: each side's renderTarget is the per-version content reference
        // `/v/<versionId>` (the version ROW id), which createLoadContent resolves to THAT
        // version's sandboxed content — never the current version.
        return compareVersions({
          kind: doc.kind,
          a: { version: from, content: a.content, contentHash: a.contentHash, renderTarget: `/v/${a.id}` },
          b: { version: to, content: b.content, contentHash: b.contentHash, renderTarget: `/v/${b.id}` },
        });
      })

      // ── WORKSPACE-SCOPED routes (S-001..S-004) — session + workspace gated (writes need
      // workspace context). Grouped so the gates apply only here, not to the doc reads above.
      .group("", (gated) =>
        gated
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
            // workspace-activity S-005 / AS-019 (C-005): log the publish. Read the previous
            // version's content (if any) to compute adds/dels by splitting the diff (F-4). The doc's
            // FIRST version has no previous → from=null, no baseline (empty prevContent). Best-effort.
            const prev =
              result.previousVersion === null
                ? null
                : await lookupRepo.getVersionContent(doc.id, result.previousVersion);
            await emitPublish(
              doc.id,
              actor.userId,
              result.version,
              result.previousVersion,
              prev?.content ?? "",
              content,
            );
            // C-012: re-anchor the doc's annotations onto the new content (fire-and-forget).
            // Pass RAW content + kind — the job renders markdown→HTML before the matcher.
            fireReanchor(doc.id, result.version, result.previousVersion, content, doc.kind);
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
          const doc = await loadVisibleDoc(params.slug, actor.userId); // viewer+ via resolveAccess
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
          // workspace-activity S-005 / AS-020 (C-005 / F-3): a restore logs ONE `restore` event and
          // NO `publish` — emitPublish is NOT called on this path (suppression is structural: only
          // the publish route calls it). meta.restored = the version restored; meta.as = the new
          // version number it became. Best-effort post-commit.
          await emitRestore(doc.id, actor.userId, target, result.version);
          // C-012: a restore append-copies version `target`'s content as the new current
          // version → re-anchor annotations against THAT content (fire-and-forget). Read the
          // restored content back (cheap) so the route stays decoupled from version.ts.
          const restored = await lookupRepo.getVersionContent(doc.id, target);
          fireReanchor(doc.id, result.version, result.previousVersion, restored?.content ?? "", doc.kind);
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
          // C-007 / AS-013: each side's renderTarget is the per-version content reference —
          // the served `/v/:versionId` surface keyed on the version's ROW id (a.id / b.id),
          // which createLoadContent resolves to THAT version's sandboxed content. Building it
          // from the version NUMBER (or doc id) would point at a path no route serves and lose
          // the per-version guarantee — so the side-by-side renders v_from ≠ v_to, never current.
          return compareVersions({
            kind: doc.kind,
            a: {
              version: from,
              content: a.content,
              contentHash: a.contentHash,
              renderTarget: `/v/${a.id}`,
            },
            b: {
              version: to,
              content: b.content,
              contentHash: b.contentHash,
              renderTarget: `/v/${b.id}`,
            },
          });
        },
      )
      )
  );
}
