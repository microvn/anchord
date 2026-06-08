// HTTP route mount for the annotation-core cluster (stories S-001..S-007).
//
// INTEGRATION GLUE: wires the already-built, already-unit-tested annotation
// services (src/annotation/*.ts) onto Elysia routes per the annotation-core
// `## API` contract, composing the api-core HTTP layer (envelope + auth gate +
// Zod validation + pagination + existence-hiding). No new annotation behaviour
// lives here — handlers resolve the parent doc, gate access, resolve the
// caller's DOC-SCOPED role server-side, call the service, and shape the response.
//
// Contract (annotation-core ## API):
//   POST  /api/docs/:slug/annotations      → S-001/S-002 (comment role) 201 { annotationId }
//   GET   /api/docs/:slug/annotations      → S-001 (viewer+) 200 { items, pagination }
//   POST  /api/annotations/:id/comments    → S-003/S-007 (session OR guest) 201 { commentId }
//   PATCH /api/annotations/:id/resolution  → S-004 (commenter+) 200 { status }
//   POST  /api/docs/:slug/suggestions      → S-006 (commenter+) 201 { suggestionId }
//   PATCH /api/suggestions/:id             → S-006 (owner) 200 { status } | 409 stale
//
// EXISTENCE-HIDING (C-006/AS-021): for every route a missing doc OR a doc the
// caller cannot view collapses to 404 via enforceReadAccess — BEFORE any role /
// capability check. 403 is reserved for a VISIBLE doc whose role is too low.
//
// SERVER RE-AUTHORIZATION (C-009/AS-020): the caller's role is resolved SERVER-side
// via resolveDocRole(docId,userId) and passed to the service as sessionRole. A
// forged role/body field never reaches the service — withValidation strips unknown
// keys and identity comes from requireSession's actor, never the client.

import { Elysia } from "elysia";
import { z } from "zod";
import { apiEnvelope } from "../http/envelope";
import { requireSession, type SessionResolver, type Actor } from "../http/auth-gate";
import { withValidation } from "../http/validate";
import { ValidationError, ForbiddenError, NotFoundError, ConflictError, UnauthenticatedError } from "../http/errors";
import { enforceReadAccess } from "../http/access-result";
import { paginationQuery, paginate, type PaginationParams } from "../http/pagination";
import { canViewDoc, type AccessDeps, type Viewer, type GeneralAccessLevel } from "../sharing/access";
import { type Role } from "../sharing/roles";
import {
  createAnnotation,
  listAnnotations,
  type Anchor,
  type AnnotationType,
  type AnnotationRepo,
} from "../annotation/annotation";
import { pointRegion, boxRegion, imageRegionAnchor, type ImageRegion } from "../annotation/image-region";
import { addReply, type CommentRepo } from "../annotation/reply";
import { createGuestComment, type GuestCommentRepo } from "../annotation/guest";
import { setResolution, type ResolutionRepo } from "../annotation/resolve";
import { createSuggestion, decideSuggestion, type SuggestionRepo } from "../annotation/suggestion";
import {
  createAnnotationRepo,
  createCommentRepo,
  createGuestCommentRepo,
  createResolutionRepo,
  createSuggestionRepo,
} from "../annotation/repo";
import { createDocLookupRepo, type DocLookupRepo, type ResolveDocRole } from "./versions";
import { and, desc, eq } from "drizzle-orm";
import { annotations as annotationsTable, docs as docsTable, docVersions } from "../db/schema";
import type { DB } from "../db/client";

/**
 * Look up the parent doc of an annotation / suggestion id — needed by the `:id`
 * routes (comments / resolution / suggestion decide) so the SAME existence-hiding
 * access gate the `:slug` routes use can run against the parent doc. Returns null
 * when the id does not exist (collapses to 404, indistinguishable from no-access).
 */
export interface AnnotationLookupRepo {
  /** docId + generalAccess for an annotation id, or null if it doesn't exist. */
  findAnnotationDoc(
    annotationId: string,
  ): Promise<{ docId: string; generalAccess: GeneralAccessLevel } | null>;
  /** docId + generalAccess for a suggestion id, or null if it doesn't exist. */
  findSuggestionDoc(
    suggestionId: string,
  ): Promise<{ docId: string; generalAccess: GeneralAccessLevel } | null>;
  /** Current (highest) version content HTML for a doc — for the C-011 stale check. */
  getCurrentVersionContent(docId: string): Promise<string | null>;
}

/**
 * Concrete Drizzle-backed AnnotationLookupRepo — thin read glue.
 */
export function createAnnotationLookupRepo(db: DB): AnnotationLookupRepo {
  async function docFor(annotationId: string) {
    const [row] = await db
      .select({ docId: annotationsTable.docId, generalAccess: docsTable.generalAccess })
      .from(annotationsTable)
      .innerJoin(docsTable, eq(docsTable.id, annotationsTable.docId))
      .where(eq(annotationsTable.id, annotationId));
    return row ?? null;
  }

  return {
    async findAnnotationDoc(annotationId) {
      return docFor(annotationId);
    },
    async findSuggestionDoc(suggestionId) {
      const [row] = await db
        .select({ docId: annotationsTable.docId, generalAccess: docsTable.generalAccess })
        .from(annotationsTable)
        .innerJoin(docsTable, eq(docsTable.id, annotationsTable.docId))
        .where(and(eq(annotationsTable.id, suggestionId), eq(annotationsTable.type, "suggestion")));
      return row ?? null;
    },
    async getCurrentVersionContent(docId) {
      const [row] = await db
        .select({ content: docVersions.content })
        .from(docVersions)
        .where(eq(docVersions.docId, docId))
        .orderBy(desc(docVersions.version))
        .limit(1);
      return row?.content ?? null;
    },
  };
}

/**
 * GUEST-COMMENTING TOGGLE SEAM (sharing-permissions cluster).
 *
 * Whether a doc allows guest commenting (anyone-with-link sub-toggle) lives in the
 * share config (`share_links.guest_commenting`). The concrete resolver lands with
 * the sharing routes; until then this is an injectable PORT — a fake in tests, a
 * conservative real default wired in index.ts. Returning `false` means guest
 * commenting is off → a guest (no session) comment is rejected (400).
 */
export type LoadShareConfig = (docId: string) => Promise<{ guestCommentingEnabled: boolean }>;

export interface AnnotationsRoutesDeps {
  /** Drizzle handle — builds the concrete repos per request. */
  db?: DB;
  annotationRepo?: AnnotationRepo;
  commentRepo?: CommentRepo;
  guestCommentRepo?: GuestCommentRepo;
  resolutionRepo?: ResolutionRepo;
  suggestionRepo?: SuggestionRepo;
  lookupRepo?: DocLookupRepo;
  annotationLookupRepo?: AnnotationLookupRepo;
  /** Resolves the better-auth session → actor; gates session-only routes (401 if none). */
  resolveSession: SessionResolver;
  /** Doc-scoped effective-role resolver (the sharing seam — see ResolveDocRole). */
  resolveDocRole: ResolveDocRole;
  /** Access deps for `canViewDoc` (invite / workspace-membership ports). */
  accessDeps: AccessDeps;
  /** Guest-commenting toggle resolver (the sharing seam — see LoadShareConfig). */
  loadShareConfig: LoadShareConfig;
}

// ── Zod request schemas ────────────────────────────────────────────────────

const anchorSegmentSchema = z.object({
  blockId: z.string(),
  textSnippet: z.string(),
  offset: z.number().int(),
  length: z.number().int(),
});

/** Text-range anchor (S-001) — block-scoped snippet + offset/length (+ optional segments). */
const textAnchorSchema = z.object({
  blockId: z.string(),
  textSnippet: z.string(),
  offset: z.number().int(),
  length: z.number().int(),
  segments: z.array(anchorSegmentSchema).optional(),
});

/** Image-region anchor (S-002) — a point or box in normalized 0..1 coords. */
const regionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("point"), x: z.number(), y: z.number() }),
  z.object({ kind: z.literal("box"), x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
]);

const imageAnchorSchema = z.object({
  blockId: z.string(),
  region: regionSchema,
});

const createAnnotationSchema = z.object({
  type: z.enum(["range", "multi_range", "block", "doc"]).optional(),
  anchor: z.union([textAnchorSchema, imageAnchorSchema]),
});

const replySchema = z.object({
  body: z.string(),
  parentId: z.string().optional(),
  guestName: z.string().optional(),
  guestEmail: z.string().optional(),
});

const resolutionSchema = z.object({
  resolved: z.boolean(),
});

const createSuggestionSchema = z.object({
  anchor: textAnchorSchema,
  from: z.string(),
  to: z.string().optional(),
  againstVersion: z.number().int().positive(),
});

const decideSuggestionSchema = z.object({
  decision: z.enum(["accept", "reject"]),
});

/**
 * Build a storage Anchor from the validated request anchor. An image-region anchor
 * (carries `region`) goes through imageRegionAnchor so the SAME normalization backs
 * AS-007; a text anchor passes through verbatim (AS-003: block_id stored as chosen).
 */
function toAnchor(input: z.infer<typeof createAnnotationSchema>["anchor"]): Anchor {
  if ("region" in input) {
    return imageRegionAnchor(input.blockId, input.region as ImageRegion);
  }
  return input as Anchor;
}

export function annotationsRoutes(deps: AnnotationsRoutesDeps) {
  const need = (name: string): never => {
    throw new Error(`annotationsRoutes requires \`${name}\` or \`db\``);
  };
  const annotationRepo = deps.annotationRepo ?? (deps.db ? createAnnotationRepo(deps.db) : need("annotationRepo"));
  const commentRepo = deps.commentRepo ?? (deps.db ? createCommentRepo(deps.db) : need("commentRepo"));
  const guestCommentRepo = deps.guestCommentRepo ?? (deps.db ? createGuestCommentRepo(deps.db) : need("guestCommentRepo"));
  const resolutionRepo = deps.resolutionRepo ?? (deps.db ? createResolutionRepo(deps.db) : need("resolutionRepo"));
  const suggestionRepo = deps.suggestionRepo ?? (deps.db ? createSuggestionRepo(deps.db) : need("suggestionRepo"));
  const lookupRepo = deps.lookupRepo ?? (deps.db ? createDocLookupRepo(deps.db) : need("lookupRepo"));
  const annotationLookupRepo =
    deps.annotationLookupRepo ?? (deps.db ? createAnnotationLookupRepo(deps.db) : need("annotationLookupRepo"));

  /** Resolve a doc by slug to a visible doc or throw 404 (existence-hiding, C-006). */
  async function loadVisibleDocBySlug(slug: string, viewer: Viewer) {
    const doc = await lookupRepo.findDocBySlug(slug);
    const allowed =
      doc !== null &&
      canViewDoc({ docId: doc.id, generalAccess: doc.generalAccess, viewer, deps: deps.accessDeps }).allowed;
    return enforceReadAccess({ doc, allowed });
  }

  /** Apply the read-access gate to a parent doc resolved by an annotation/suggestion id. */
  function enforceParentAccess(
    parent: { docId: string; generalAccess: GeneralAccessLevel } | null,
    viewer: Viewer,
  ) {
    const allowed =
      parent !== null &&
      canViewDoc({ docId: parent.docId, generalAccess: parent.generalAccess, viewer, deps: deps.accessDeps }).allowed;
    return enforceReadAccess({ doc: parent, allowed });
  }

  /** The caller's effective doc-scoped role (null → least privilege, viewer). */
  async function docRole(docId: string, userId: string): Promise<Role> {
    return (await deps.resolveDocRole(docId, userId)) ?? "viewer";
  }

  // ── handlers (extracted so the route tree below reads as a contract) ──

  async function createAnnotationHandler({ params, actor, validBody, set }: any) {
    const body = validBody as z.infer<typeof createAnnotationSchema>;
    const viewer: Viewer = { kind: "user", userId: actor.userId };
    const doc = await loadVisibleDocBySlug(params.slug, viewer); // 404 if missing/hidden
    const sessionRole = await docRole(doc.id, actor.userId); // server re-auth (AS-020)
    const result = await createAnnotation(
      {
        docId: doc.id,
        anchor: toAnchor(body.anchor),
        viewer,
        sessionRole,
        type: ("region" in body.anchor ? "block" : body.type ?? "range") as AnnotationType,
      },
      annotationRepo,
    );
    if (!result.created) throw new ForbiddenError(); // viewer/forged role → 403 (AS-020)
    set.status = 201;
    return { annotationId: result.id };
  }

  async function listAnnotationsHandler({ params, actor, query }: any) {
    const viewer: Viewer = { kind: "user", userId: actor.userId };
    const doc = await loadVisibleDocBySlug(params.slug, viewer); // 404 if no access (AS-021)
    const page = paginationQuery().parse(query) as PaginationParams;
    const result = await listAnnotations(
      { docId: doc.id, viewer, generalAccess: doc.generalAccess, deps: deps.accessDeps },
      annotationRepo,
    );
    const all = result.allowed ? result.annotations : [];
    const total = all.length;
    const start = (page.page - 1) * page.limit;
    return paginate(all.slice(start, start + page.limit), { page: page.page, limit: page.limit, total });
  }

  async function resolutionHandler({ params, actor, validBody }: any) {
    const { resolved } = validBody as z.infer<typeof resolutionSchema>;
    const viewer: Viewer = { kind: "user", userId: actor.userId };
    const parent = enforceParentAccess(await annotationLookupRepo.findAnnotationDoc(params.id), viewer);
    const sessionRole = await docRole(parent.docId, actor.userId);
    const result = await setResolution({ annotationId: params.id, resolved, sessionRole }, resolutionRepo);
    if (!result.ok) throw new ForbiddenError(); // viewer → 403 (AS-010)
    return { status: result.status };
  }

  async function createSuggestionHandler({ params, actor, validBody, set }: any) {
    const body = validBody as z.infer<typeof createSuggestionSchema>;
    const viewer: Viewer = { kind: "user", userId: actor.userId };
    const doc = await loadVisibleDocBySlug(params.slug, viewer);
    const sessionRole = await docRole(doc.id, actor.userId);
    const result = await createSuggestion(
      {
        docId: doc.id,
        anchor: body.anchor as Anchor,
        from: body.from,
        to: body.to,
        againstVersion: body.againstVersion,
        sessionRole,
      },
      suggestionRepo,
    );
    if (!result.created) throw new ForbiddenError(); // viewer → 403
    set.status = 201;
    return { suggestionId: result.id };
  }

  async function decideSuggestionHandler({ params, actor, validBody }: any) {
    const { decision } = validBody as z.infer<typeof decideSuggestionSchema>;
    const viewer: Viewer = { kind: "user", userId: actor.userId };
    const parent = enforceParentAccess(await annotationLookupRepo.findSuggestionDoc(params.id), viewer);
    // Owner-only: deciding a suggestion is a manage-class action (AS-015).
    const sessionRole = await docRole(parent.docId, actor.userId);
    if (sessionRole !== "owner") throw new ForbiddenError();
    const currentHtml = (await annotationLookupRepo.getCurrentVersionContent(parent.docId)) ?? "";
    const result = await decideSuggestion(
      { suggestionId: params.id, decision, currentVersionContentHtml: currentHtml },
      suggestionRepo,
    );
    if (!result.ok) throw new NotFoundError(); // suggestion vanished
    // AS-022: a drifted `from` came back `stale` on accept → 409 CONFLICT.
    if (result.status === "stale") {
      throw new ConflictError("Suggestion is stale: the target text has changed", {
        details: { status: "stale" },
      });
    }
    return { status: result.status };
  }

  // S-003 reply (session) OR S-007 guest (no session). The guest path requires a
  // name + the doc's guest-commenting toggle; the service sanitizes body+name (C-008).
  async function commentHandler({ params, request, validBody, set }: any) {
    const body = validBody as z.infer<typeof replySchema>;
    const actor: Actor | null = await deps.resolveSession(request.headers);
    const viewer: Viewer = actor ? { kind: "user", userId: actor.userId } : { kind: "anon" };
    // Existence-hiding on the parent doc applies to BOTH the session AND guest path.
    const parent = enforceParentAccess(await annotationLookupRepo.findAnnotationDoc(params.id), viewer);

    if (actor) {
      const sessionRole = await docRole(parent.docId, actor.userId);
      const result = await addReply(
        {
          annotationId: params.id,
          parentCommentId: body.parentId ?? params.id, // fall back to root if omitted
          body: body.body,
          author: { kind: "user", userId: actor.userId },
          sessionRole,
        },
        commentRepo,
      );
      if (!result.created) {
        if (result.reason === "forbidden") throw new ForbiddenError();
        if (result.reason === "empty_body") throw new ValidationError("body must not be empty", { field: "body" });
        throw new NotFoundError("Parent comment not found"); // parent_not_found
      }
      set.status = 201;
      return { commentId: result.id };
    }

    const { guestCommentingEnabled } = await deps.loadShareConfig(parent.docId);
    const result = await createGuestComment(
      {
        annotationId: params.id,
        guestName: body.guestName ?? "",
        email: body.guestEmail,
        body: body.body,
        guestCommentingEnabled,
      },
      guestCommentRepo,
    );
    if (!result.created) {
      // Guest commenting off + no session → the caller is unauthenticated for this action.
      if (result.reason === "guest_disabled") {
        throw new UnauthenticatedError("Guest commenting is not enabled; sign in to comment");
      }
      if (result.reason === "empty_name") throw new ValidationError("guestName is required", { field: "guestName" });
      throw new ValidationError("body must not be empty", { field: "body" });
    }
    set.status = 201;
    return { commentId: result.id };
  }

  // ONE enveloped Elysia for the whole cluster. The session-only routes live in a
  // `.group` that mounts requireSession (scoped to that group); the guest-capable
  // comment route is a sibling OUTSIDE that group so it carries no session gate.
  // (Composing two separately-enveloped plugins would double-wrap the response.)
  return apiEnvelope(new Elysia())
    .group("", (g) =>
      g
        .use(requireSession({ resolveSession: deps.resolveSession }))
        .group("", (a) => a.use(withValidation(createAnnotationSchema)).post("/api/docs/:slug/annotations", createAnnotationHandler))
        .get("/api/docs/:slug/annotations", listAnnotationsHandler)
        .group("", (a) => a.use(withValidation(resolutionSchema)).patch("/api/annotations/:id/resolution", resolutionHandler))
        .group("", (a) => a.use(withValidation(createSuggestionSchema)).post("/api/docs/:slug/suggestions", createSuggestionHandler))
        .group("", (a) => a.use(withValidation(decideSuggestionSchema)).patch("/api/suggestions/:id", decideSuggestionHandler)),
    )
    .group("", (g) => g.use(withValidation(replySchema)).post("/api/annotations/:id/comments", commentHandler));
}
