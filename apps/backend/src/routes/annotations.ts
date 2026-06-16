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
import {
  requireSession,
  requireWorkspaceMember,
  type SessionResolver,
  type WorkspaceRoleResolver,
  type Actor,
} from "../http/auth-gate";
import { withValidation } from "../http/validate";
import { ValidationError, ForbiddenError, NotFoundError, ConflictError, UnauthenticatedError, RateLimitedError } from "../http/errors";
import { enforceReadAccess } from "../http/access-result";
import { paginationQuery, paginate, type PaginationParams } from "../http/pagination";
import { type Viewer, type GeneralAccessLevel } from "../sharing/access";
import { type AccessResult } from "../sharing/resolve-access";
import { type Role } from "../sharing/roles";
import {
  createAnnotation,
  listAnnotations,
  type Anchor,
  type AnnotationType,
  type AnnotationRepo,
} from "../annotation/annotation";
import { pointRegion, boxRegion, imageRegionAnchor, type ImageRegion } from "../annotation/image-region";
import { addReply, addComment, type CommentRepo } from "../annotation/reply";
import { createGuestComment, type GuestCommentRepo } from "../annotation/guest";
import { setResolution, type ResolutionRepo } from "../annotation/resolve";
import { deleteAnnotation, restoreAnnotation, type DeleteRepo, type RestoreRepo } from "../annotation/delete";
import { createSuggestion, decideSuggestion, type SuggestionRepo } from "../annotation/suggestion";
import {
  createAnnotationRepo,
  createCommentRepo,
  createGuestCommentRepo,
  createResolutionRepo,
  createDeleteRepo,
  createSuggestionRepo,
} from "../annotation/repo";
import { createDocLookupRepo, type DocLookupRepo, type ResolveDocRole } from "./versions";
import { notifyOnReply, type MailEnqueuer, type NotifyRepo } from "../notify/notify";
import { createNotifyRepo } from "../notify/repo";
import { and, desc, eq, sql } from "drizzle-orm";
import { annotations as annotationsTable, docs as docsTable, docVersions, docMembers, user } from "../db/schema";
import type { DB } from "../db/client";

/**
 * Look up the parent doc of an annotation / suggestion id — needed by the `:id`
 * routes (comments / resolution / suggestion decide) so the SAME existence-hiding
 * access gate the `:slug` routes use can run against the parent doc. Returns null
 * when the id does not exist (collapses to 404, indistinguishable from no-access).
 */
export interface AnnotationLookupRepo {
  /**
   * docId + generalAccess + the annotation's durable creator (`authorId`, null for a guest)
   * for an annotation id, or null if it doesn't exist. The `authorId` (annotation-actions
   * S-004 / C-006) lets the delete route gate delete-OWN without a second read, alongside the
   * existing parent-doc fields that drive existence-hiding.
   */
  findAnnotationDoc(
    annotationId: string,
  ): Promise<{ docId: string; generalAccess: GeneralAccessLevel; authorId: string | null; deletedAt?: Date | null } | null>;
  /** docId + generalAccess for a suggestion id, or null if it doesn't exist. The `deletedAt`
   *  (S-005 / C-007) lets the resolution route refuse a terminal (deleted) annotation. */
  findSuggestionDoc(
    suggestionId: string,
  ): Promise<{ docId: string; generalAccess: GeneralAccessLevel; deletedAt?: Date | null } | null>;
  /** Current (highest) version content HTML for a doc — for the C-011 stale check. */
  getCurrentVersionContent(docId: string): Promise<string | null>;
}

/**
 * Concrete Drizzle-backed AnnotationLookupRepo — thin read glue.
 */
export function createAnnotationLookupRepo(db: DB): AnnotationLookupRepo {
  async function docFor(annotationId: string) {
    const [row] = await db
      .select({
        docId: annotationsTable.docId,
        generalAccess: docsTable.generalAccess,
        // S-004/C-006: the durable creator, so the delete route can gate delete-own.
        authorId: annotationsTable.authorId,
        // S-005/C-007: the tombstone, so resolution refuses a deleted (terminal) annotation
        // and restore can find + clear it. NOT filtered out here — the lookup sees deleted rows.
        deletedAt: annotationsTable.deletedAt,
      })
      .from(annotationsTable)
      .innerJoin(docsTable, eq(docsTable.id, annotationsTable.docId))
      .where(eq(annotationsTable.id, annotationId));
    return row ? { ...row, authorId: row.authorId ?? null, deletedAt: row.deletedAt ?? null } : null;
  }

  return {
    async findAnnotationDoc(annotationId) {
      return docFor(annotationId);
    },
    async findSuggestionDoc(suggestionId) {
      const [row] = await db
        .select({
          docId: annotationsTable.docId,
          generalAccess: docsTable.generalAccess,
          // S-005/C-007: surfaced (not filtered) so the resolution route can refuse a deleted one.
          deletedAt: annotationsTable.deletedAt,
        })
        .from(annotationsTable)
        .innerJoin(docsTable, eq(docsTable.id, annotationsTable.docId))
        .where(and(eq(annotationsTable.id, suggestionId), eq(annotationsTable.type, "suggestion")));
      return row ? { ...row, deletedAt: row.deletedAt ?? null } : null;
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
 * doc-access-routing S-004 / C-009: concrete `isActiveMemberName(docId, name)` — true when
 * `name` (case/space-insensitive) matches an ACTIVE doc-member's display name OR the doc
 * owner's display name. A guest comment whose typed name collides is rejected so it can't
 * read as the member (the non-spoofable guest marker — author_id null — is enforced
 * separately by createGuestComment). Thin read glue; the comparison normalizes both sides.
 */
export function createIsActiveMemberName(db: DB): IsActiveMemberName {
  return async (docId, name) => {
    const needle = name.trim().toLowerCase();
    if (needle.length === 0) return false;
    const norm = (col: unknown) => sql`lower(trim(${col})) = ${needle}`;
    // Active invited members bound to an account.
    const [m] = await db
      .select({ id: docMembers.id })
      .from(docMembers)
      .innerJoin(user, eq(user.id, docMembers.userId))
      .where(and(eq(docMembers.docId, docId), eq(docMembers.status, "active"), norm(user.name)))
      .limit(1);
    if (m) return true;
    // The doc owner (AS-023 uses the owner's display name).
    const [o] = await db
      .select({ id: user.id })
      .from(docsTable)
      .innerJoin(user, eq(user.id, docsTable.ownerId))
      .where(and(eq(docsTable.id, docId), norm(user.name)))
      .limit(1);
    return Boolean(o);
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

/**
 * doc-access-routing S-004 / C-008: per-IP + per-doc rate limiter for the ANONYMOUS
 * comment write surface. Keyed on a string the route builds from the caller IP and the
 * parent doc id, so a flood from one source on one doc is throttled independently. Returns
 * `{ allowed: false }` once the window is exceeded → the route refuses the write (429) AND
 * skips the reply-notification dispatch (no per-comment mail flood). The concrete limiter
 * (a token bucket / fixed window) lands in index.ts; a fake in tests. An allow-all default
 * keeps existing route tests that don't exercise the limit unchanged.
 */
export type CommentRateLimiter = (key: string) => Promise<{ allowed: boolean }>;

/**
 * doc-access-routing S-004 / C-009: "is `name` the display name of an ACTIVE member on this
 * doc". A GUEST comment whose typed name collides with a real member's display name is
 * rejected so the guest cannot read as the member (the guest marker is already non-spoofable
 * server-side; this stops the NAME from impersonating). The concrete resolver (a
 * doc_members ⋈ user.name lookup) lands in index.ts; a fake in tests. A never-collides
 * default keeps existing tests unchanged.
 */
export type IsActiveMemberName = (docId: string, name: string) => Promise<boolean>;

export interface AnnotationsRoutesDeps {
  /** Drizzle handle — builds the concrete repos per request. */
  db?: DB;
  annotationRepo?: AnnotationRepo;
  commentRepo?: CommentRepo;
  guestCommentRepo?: GuestCommentRepo;
  resolutionRepo?: ResolutionRepo;
  /** annotation-actions S-004 / C-006: the soft-delete write port (built from `db` if omitted). */
  deleteRepo?: DeleteRepo;
  /** annotation-actions S-005 / C-007: the restore (clear-tombstone) write port (built from `db` if omitted). */
  restoreRepo?: RestoreRepo;
  suggestionRepo?: SuggestionRepo;
  lookupRepo?: DocLookupRepo;
  annotationLookupRepo?: AnnotationLookupRepo;
  /** Resolves the better-auth session → actor; gates session-only routes (401 if none). */
  resolveSession: SessionResolver;
  /** workspaces S-006: resolves the caller's role in :workspaceId for the path-scoped gate. */
  resolveWorkspaceRole: WorkspaceRoleResolver;
  /** Doc-scoped effective-role resolver (used for write-class capability checks). */
  resolveDocRole: ResolveDocRole;
  /**
   * doc-access-routing S-001 / C-001: the SINGLE authoritative read gate. Every
   * doc-centric READ on this cluster (annotation list, and the parent-doc gate for
   * comment/resolve/suggest) flows through this — replacing the permissive `canViewDoc`
   * stub that let any logged-in user pass (AS-007). `(docId, viewer) → { role, canView }`.
   */
  resolveAccess: (docId: string, viewer: Viewer) => Promise<AccessResult>;
  /** Guest-commenting toggle resolver (the sharing seam — see LoadShareConfig). */
  loadShareConfig: LoadShareConfig;
  /**
   * doc-access-routing S-004 / C-008 (AS-022): per-IP+per-doc rate limiter applied to the
   * ANONYMOUS comment write surface. OMIT to disable throttling (allow-all) — keeps the
   * older annotation route tests unchanged. When the limiter refuses, the write is 429'd
   * AND no reply-notification mail is dispatched (the same limiter gates both).
   */
  rateLimitComment?: CommentRateLimiter;
  /**
   * doc-access-routing S-004 / C-009 (AS-023): guest-name → active-member-name collision
   * check. OMIT to skip (never collides). Applied ONLY to guest (no-session) writes — a
   * member's identity is the session, never a typed name.
   */
  isActiveMemberName?: IsActiveMemberName;
  /**
   * workspace-project S-006 (AS-011 / C-004): notify-on-reply wiring. After a
   * SUCCESSFUL reply (session OR guest), the route dispatches a best-effort
   * notification to (thread participants ∪ doc owner) − replier, over in-app + email.
   * Provide a pre-built NotifyRepo (tests) — else one is built from `db` — plus a
   * MailEnqueuer (the shared MailQueue in prod, a fake in tests). OMIT the whole block
   * to leave notify off (a reply still succeeds; no notifications dispatched) — keeps
   * existing annotation route tests that don't exercise notify unchanged.
   */
  notify?: {
    repo?: NotifyRepo;
    mail: MailEnqueuer;
  };
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

const createAnnotationSchema = z
  .object({
    type: z.enum(["range", "multi_range", "block", "doc"]).optional(),
    anchor: z.union([textAnchorSchema, imageAnchorSchema]),
    // S-009 / C-015 (AS-027): an optional label-preset id; validated against the preset set
    // SERVER-side in createAnnotation (AS-028), not here, so a foreign id is a clean domain refusal.
    label: z.string().optional(),
    // S-009 / C-015 (AS-029): a label annotation and a suggestion are MUTUALLY EXCLUSIVE.
    // Suggestions have their own create endpoint; we DECLARE `suggestion` here only to REFUSE a
    // body carrying BOTH (the refine below). Without declaring it, strip semantics would silently
    // drop it and a label+suggestion body would wrongly succeed instead of being refused.
    suggestion: z.unknown().optional(),
  })
  .refine((b) => !(b.label != null && b.suggestion != null), {
    message: "a label annotation and a suggestion are mutually exclusive",
    path: ["label"],
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

const createSuggestionSchema = z
  .object({
    anchor: textAnchorSchema,
    from: z.string(),
    to: z.string().optional(),
    againstVersion: z.number().int().positive(),
    // S-009 / C-015 (AS-029): a suggestion cannot carry a label — declared only to REFUSE it
    // (the symmetric half of the mutual-exclusion guard on the annotation-create schema).
    label: z.unknown().optional(),
  })
  .refine((b) => b.label == null, {
    message: "a suggestion cannot carry a label",
    path: ["label"],
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
  const deleteRepo = deps.deleteRepo ?? (deps.db ? createDeleteRepo(deps.db) : need("deleteRepo"));
  // S-005/C-007: restore shares the createDeleteRepo factory (it exposes both set + clear).
  const restoreRepo = deps.restoreRepo ?? (deps.db ? createDeleteRepo(deps.db) : need("restoreRepo"));
  const suggestionRepo = deps.suggestionRepo ?? (deps.db ? createSuggestionRepo(deps.db) : need("suggestionRepo"));
  const lookupRepo = deps.lookupRepo ?? (deps.db ? createDocLookupRepo(deps.db) : need("lookupRepo"));
  const annotationLookupRepo =
    deps.annotationLookupRepo ?? (deps.db ? createAnnotationLookupRepo(deps.db) : need("annotationLookupRepo"));

  // S-004 seams (defaulted so older route tests that don't pass them stay green):
  //  - rateLimitComment: allow-all → no throttle (the concrete window lands in index.ts).
  //  - isActiveMemberName: never-collides → no impersonation guard fires.
  const rateLimitComment: CommentRateLimiter = deps.rateLimitComment ?? (async () => ({ allowed: true }));
  const isActiveMemberName: IsActiveMemberName = deps.isActiveMemberName ?? (async () => false);

  // S-006 notify-on-reply: built only when the `notify` block is provided. The repo is
  // pre-built (tests) or built from `db`; the mail enqueuer is the shared MailQueue
  // (prod) / a fake (tests). Absent → notify is a no-op (a reply still succeeds).
  const notifyDeps =
    deps.notify != null
      ? {
          repo: deps.notify.repo ?? (deps.db ? createNotifyRepo(deps.db) : need("notify.repo")),
          mail: deps.notify.mail,
        }
      : null;

  /**
   * Best-effort post-commit notify dispatch (AS-011 / C-004). Runs AFTER a reply has
   * persisted; never throws (notifyOnReply swallows + logs), so a notify failure can't
   * turn a successful reply into a 500. No-op when the notify block is unwired.
   */
  async function dispatchReplyNotify(annotationId: string, replierUserId: string | null) {
    if (!notifyDeps) return;
    await notifyOnReply({ annotationId, replierUserId }, notifyDeps);
  }

  /**
   * Resolve a doc by slug to a visible doc or throw 404 (existence-hiding, C-006).
   * doc-access-routing S-001 / C-001: the gate is the single authoritative
   * `resolveAccess` — NOT the permissive `canViewDoc` stub (which let any logged-in user
   * through). A missing doc OR a no-access decision both collapse to the same 404.
   */
  async function loadVisibleDocBySlug(slug: string, viewer: Viewer) {
    const doc = await lookupRepo.findDocBySlug(slug);
    const allowed = doc !== null && (await deps.resolveAccess(doc.id, viewer)).canView;
    return enforceReadAccess({ doc, allowed });
  }

  /**
   * Apply the single-gate read-access check to a parent doc resolved by an annotation /
   * suggestion id (S-001 / C-001 / AS-007: same authoritative `resolveAccess`).
   */
  async function enforceParentAccess(
    parent: { docId: string; generalAccess: GeneralAccessLevel } | null,
    viewer: Viewer,
  ) {
    const allowed = parent !== null && (await deps.resolveAccess(parent.docId, viewer)).canView;
    return enforceReadAccess({ doc: parent, allowed });
  }

  /** The caller's effective doc-scoped role (null → least privilege, viewer). */
  async function docRole(docId: string, userId: string): Promise<Role> {
    return (await deps.resolveDocRole(docId, userId)) ?? "viewer";
  }

  /**
   * Best-effort client IP for the anon rate-limit key (C-008). Prefers the first
   * `x-forwarded-for` hop (the real client behind a reverse proxy), falling back to
   * `x-real-ip`, then a literal "unknown" so a missing header still rate-limits per-doc
   * (degrading to a per-doc bucket rather than no limit at all).
   */
  function clientIp(request: Request): string {
    const fwd = request.headers.get("x-forwarded-for");
    if (fwd) return fwd.split(",")[0]!.trim();
    return request.headers.get("x-real-ip")?.trim() || "unknown";
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
        label: body.label, // S-009: validated ∈ preset set in the service (AS-028).
        // S-001/C-005 (AS-001): the durable creator — the session actor (this mount is
        // session-required, so an actor always exists).
        authorId: actor.userId,
      },
      annotationRepo,
    );
    if (!result.created) {
      // S-009/AS-028: an unknown/forged label is a bad request, not a permission failure.
      if (result.reason === "invalid_label") throw new ValidationError("Unknown label", { field: "label" });
      throw new ForbiddenError(); // viewer/forged role → 403 (AS-020)
    }
    set.status = 201;
    return { annotationId: result.id };
  }

  async function listAnnotationsHandler({ params, actor, query }: any) {
    const viewer: Viewer = { kind: "user", userId: actor.userId };
    // S-001 / AS-007: the single resolveAccess gate decides the read here too — a
    // logged-in non-member of a restricted doc 404s exactly like the doc read (no thread
    // leak), NOT the old "any logged-in user passes". loadVisibleDocBySlug throws 404 on
    // deny; reaching this line means canView is true.
    const doc = await loadVisibleDocBySlug(params.slug, viewer);
    const page = paginationQuery().parse(query) as PaginationParams;
    const result = await listAnnotations({ docId: doc.id, canView: true }, annotationRepo);
    const all = result.allowed ? result.annotations : [];
    const total = all.length;
    const start = (page.page - 1) * page.limit;
    return paginate(all.slice(start, start + page.limit), { page: page.page, limit: page.limit, total });
  }

  async function resolutionHandler({ params, actor, validBody }: any) {
    const { resolved } = validBody as z.infer<typeof resolutionSchema>;
    const viewer: Viewer = { kind: "user", userId: actor.userId };
    const found = await annotationLookupRepo.findAnnotationDoc(params.id);
    const parent = await enforceParentAccess(found, viewer);
    const sessionRole = await docRole(parent.docId, actor.userId);
    // S-006/AS-026/C-016: if this annotation is a suggestion, its lifecycle decides whether a
    // reopen is the owner-only decision-reset path or the ordinary commenter+ toggle. null for
    // an ordinary annotation (getSuggestion filters on type="suggestion").
    const sug = await suggestionRepo.getSuggestion(params.id);
    const result = await setResolution(
      // S-005/C-007 (AS-015): a soft-deleted annotation is terminal — refuse resolve/reopen.
      // S-002/C-003 (AS-003): `isProposal` is suggestion PRESENCE — a proposal (in ANY state,
      // incl. pending) is owner-only to close/resolve/reopen; a remark stays commenter+.
      { annotationId: params.id, resolved, sessionRole, suggestionStatus: sug?.status, isProposal: sug != null, deleted: found!.deletedAt != null },
      resolutionRepo,
    );
    // S-005/C-007: a deleted (terminal) annotation reads as gone → 404 (existence-hiding).
    if (!result.ok && result.reason === "not_found") throw new NotFoundError();
    if (!result.ok) throw new ForbiddenError(); // viewer / non-owner proposal close → 403 (AS-003/AS-010/AS-026)
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
        // S-001/C-005 (AS-001): the durable creator — the session actor (session-required mount).
        authorId: actor.userId,
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
    const parent = await enforceParentAccess(await annotationLookupRepo.findSuggestionDoc(params.id), viewer);
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

  /**
   * annotation-actions S-004 / C-006: DELETE an annotation (soft) — own (the author) or
   * owner-moderation. Mounted on a DOC-ADDRESSED, session-OPTIONAL route so the slug-only
   * viewer can call it, but delete is SESSION-REQUIRED: an anon/guest is refused (401) BEFORE
   * any own/owner check (AS-012). Then the SAME existence-hiding gate every annotation route
   * uses runs on the resolved parent doc (404 on missing/no-access, AS-013), the annotation
   * is bound to THAT parent doc, the caller's doc-scoped role + the annotation's author_id are
   * resolved, and delete.ts decides own/owner. Reads still showing the deleted row is fine for
   * now — the read-exclusion + terminal guards + restore are S-005.
   */
  async function deleteAnnotationHandler({ params, request }: any) {
    // AS-012 / C-006: session-required — refuse an unauthenticated/guest request BEFORE any
    // own/owner check. A guest has no durable identity and is not the owner.
    const actor: Actor | null = await deps.resolveSession(request.headers);
    if (!actor) throw new UnauthenticatedError("Sign in to delete an annotation");
    const viewer: Viewer = { kind: "user", userId: actor.userId };
    // AS-013: existence-hiding on the resolved PARENT doc — a missing id OR a no-access doc
    // both collapse to the same 404 (never a 403 leak). The lookup binds the annotation to
    // THAT doc (docId + the durable author_id), so the role/own check below runs against the
    // resolved parent, never a cross-doc id.
    const found = await annotationLookupRepo.findAnnotationDoc(params.id);
    const parent = await enforceParentAccess(found, viewer);
    const sessionRole = await docRole(parent.docId, actor.userId);
    const result = await deleteAnnotation(
      {
        annotationId: params.id,
        actorUserId: actor.userId,
        sessionRole,
        authorId: found!.authorId, // bound to the resolved annotation (found is non-null past the 404 gate).
      },
      deleteRepo,
    );
    if (!result.ok) throw new ForbiddenError(); // viewer / non-owner-non-author → 403 (AS-010/AS-011)
    return { deleted: true };
  }

  /**
   * annotation-actions S-005 / C-007: RESTORE a soft-deleted annotation (clear the tombstone) —
   * the durable undo backing the FE optimistic-undo toast. SAME shape as delete: session-REQUIRED
   * (anon/guest → 401 before any authz, AS-012-family), existence-hiding 404 on a missing/no-access
   * parent doc, then author-OR-owner authz (AS-016, C-006 family). The lookup (findAnnotationDoc)
   * does NOT filter deleted rows, so a tombstoned annotation is found + clearable; the 404 is
   * ACCESS-based (can you see the doc), never deleted-based. Idempotent: restoring an already-active
   * annotation is a harmless no-op.
   */
  async function restoreAnnotationHandler({ params, request }: any) {
    const actor: Actor | null = await deps.resolveSession(request.headers);
    if (!actor) throw new UnauthenticatedError("Sign in to restore an annotation");
    const viewer: Viewer = { kind: "user", userId: actor.userId };
    const found = await annotationLookupRepo.findAnnotationDoc(params.id);
    const parent = await enforceParentAccess(found, viewer);
    const sessionRole = await docRole(parent.docId, actor.userId);
    const result = await restoreAnnotation(
      {
        annotationId: params.id,
        actorUserId: actor.userId,
        sessionRole,
        authorId: found!.authorId, // bound to the resolved annotation (found non-null past the 404 gate).
      },
      restoreRepo,
    );
    if (!result.ok) throw new ForbiddenError(); // viewer / non-owner-non-author → 403 (AS-016)
    return { restored: true };
  }

  // S-003 reply (session) OR S-007 guest (no session). The guest path requires a
  // name + the doc's guest-commenting toggle; the service sanitizes body+name (C-008).
  async function commentHandler({ params, request, validBody, set }: any) {
    const body = validBody as z.infer<typeof replySchema>;
    const actor: Actor | null = await deps.resolveSession(request.headers);
    const viewer: Viewer = actor ? { kind: "user", userId: actor.userId } : { kind: "anon" };
    // Existence-hiding on the parent doc applies to BOTH the session AND guest path.
    const parent = await enforceParentAccess(await annotationLookupRepo.findAnnotationDoc(params.id), viewer);

    if (actor) {
      const sessionRole = await docRole(parent.docId, actor.userId);
      // parentId PRESENT → it's a reply (flatten to root, may parent_not_found).
      // parentId ABSENT  → it's a TOP-LEVEL comment (no parent, no thread lookup).
      const result = body.parentId
        ? await addReply(
            {
              annotationId: params.id,
              parentCommentId: body.parentId,
              body: body.body,
              author: { kind: "user", userId: actor.userId },
              sessionRole,
            },
            commentRepo,
          )
        : await addComment(
            {
              annotationId: params.id,
              body: body.body,
              author: { kind: "user", userId: actor.userId },
              sessionRole,
            },
            commentRepo,
          );
      if (!result.created) {
        if (result.reason === "forbidden") throw new ForbiddenError();
        if (result.reason === "empty_body") throw new ValidationError("body must not be empty", { field: "body" });
        throw new NotFoundError("Parent comment not found"); // parent_not_found (reply path only)
      }
      // S-006: reply persisted → notify others (best-effort, post-commit). The replier
      // is the session actor; they never notify themselves (handled in notifyOnReply).
      await dispatchReplyNotify(params.id, actor.userId);
      set.status = 201;
      return { commentId: result.id };
    }

    // ── ANON (guest) write path ──────────────────────────────────────────────
    // C-008 (AS-022): rate-limit the anonymous write surface per IP + per doc BEFORE any
    // work (and before notify) so a flood is refused (429) and can't amplify mail — the
    // SAME limiter gates the reply-notification dispatch below (a refused write never
    // reaches dispatchReplyNotify because we throw here first).
    const limit = await rateLimitComment(`${clientIp(request)}:${parent.docId}`);
    if (!limit.allowed) {
      throw new RateLimitedError("Too many comments — slow down and try again shortly");
    }

    // C-009 (AS-023): a guest whose typed name collides with an ACTIVE member's display name
    // on this doc is rejected, so the guest cannot read AS that member (the guest marker is
    // already non-spoofable server-side — author_id stays null; this stops the NAME spoof).
    // Member identity is the session, never a typed name, so this guard is guest-only.
    const guestName = body.guestName ?? "";
    if (guestName.trim().length > 0 && (await isActiveMemberName(parent.docId, guestName))) {
      throw new ValidationError("That name belongs to a member of this doc; choose another", {
        field: "guestName",
      });
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
    // S-006: a GUEST reply still notifies account-holder participants + owner; the guest
    // has no account, so replierUserId is null → the guest is excluded automatically.
    await dispatchReplyNotify(params.id, null);
    set.status = 201;
    return { commentId: result.id };
  }

  // ── doc-access-routing S-004: DOC-ADDRESSED, SESSION-OPTIONAL handlers ──────
  //
  // These are the routes the slug-only viewer (S-003) calls: no workspace in the path,
  // no requireSession / requireWorkspaceMember gate. Each resolves the session itself
  // (anon → guest), gates the parent doc with the single resolveAccess (existence-hiding
  // 404), and resolves the WRITE role server-side — for a user via resolveDocRole, for an
  // anon via the access result's link role (C-005: an anon may write only on an
  // anyone_with_link doc with guest commenting on, where the link role is commenter+).

  /** The effective write-role for a viewer on a doc: a user's doc role, or an anon's
   *  link role from the access decision (null → viewer, least privilege). */
  async function writeRole(docId: string, viewer: Viewer, access: AccessResult): Promise<Role> {
    if (viewer.kind === "user") return docRole(docId, viewer.userId);
    return access.role ?? "viewer";
  }

  async function docCreateAnnotationHandler({ params, request, validBody, set }: any) {
    const body = validBody as z.infer<typeof createAnnotationSchema>;
    const actor: Actor | null = await deps.resolveSession(request.headers);
    const viewer: Viewer = actor ? { kind: "user", userId: actor.userId } : { kind: "anon" };
    const found = await lookupRepo.findDocBySlug(params.slug);
    const access = found ? await deps.resolveAccess(found.id, viewer) : { role: null, canView: false };
    const doc = enforceReadAccess({ doc: found, allowed: found !== null && access.canView }); // 404 if missing/hidden
    const sessionRole = await writeRole(doc.id, viewer, access); // server re-auth (AS-017/AS-020)
    const result = await createAnnotation(
      {
        docId: doc.id,
        anchor: toAnchor(body.anchor),
        viewer,
        sessionRole,
        type: ("region" in body.anchor ? "block" : body.type ?? "range") as AnnotationType,
        label: body.label, // S-009: validated ∈ preset set in the service (AS-028).
        // S-001/C-005 (AS-001/AS-002): the durable creator — the session actor's id, or NULL
        // for a guest (no account). That null is exactly the guest case (AS-002): no durable
        // identity to own-gate against.
        authorId: actor?.userId ?? null,
      },
      annotationRepo,
    );
    if (!result.created) {
      if (result.reason === "invalid_label") throw new ValidationError("Unknown label", { field: "label" });
      throw new ForbiddenError(); // viewer/forged role → 403
    }
    set.status = 201;
    return { annotationId: result.id };
  }

  async function docListAnnotationsHandler({ params, request, query }: any) {
    const actor: Actor | null = await deps.resolveSession(request.headers);
    const viewer: Viewer = actor ? { kind: "user", userId: actor.userId } : { kind: "anon" };
    // AS-017 read: the single resolveAccess gate decides the doc-scoped list too — a denied
    // viewer 404s exactly like the doc read (no thread leak).
    const found = await lookupRepo.findDocBySlug(params.slug);
    const allowed = found !== null && (await deps.resolveAccess(found.id, viewer)).canView;
    const doc = enforceReadAccess({ doc: found, allowed });
    const page = paginationQuery().parse(query) as PaginationParams;
    const result = await listAnnotations({ docId: doc.id, canView: true }, annotationRepo);
    const all = result.allowed ? result.annotations : [];
    const total = all.length;
    const start = (page.page - 1) * page.limit;
    return paginate(all.slice(start, start + page.limit), { page: page.page, limit: page.limit, total });
  }

  async function docResolutionHandler({ params, request, validBody }: any) {
    const { resolved } = validBody as z.infer<typeof resolutionSchema>;
    const actor: Actor | null = await deps.resolveSession(request.headers);
    const viewer: Viewer = actor ? { kind: "user", userId: actor.userId } : { kind: "anon" };
    const found = await annotationLookupRepo.findAnnotationDoc(params.id);
    const access = found ? await deps.resolveAccess(found.docId, viewer) : { role: null, canView: false };
    const parent = enforceReadAccess({ doc: found, allowed: found !== null && access.canView });
    const sessionRole = await writeRole(parent.docId, viewer, access);
    // S-006/AS-026/C-016: suggestion lifecycle gates the owner-only decided-reopen reset.
    const sug = await suggestionRepo.getSuggestion(params.id);
    const result = await setResolution(
      // S-005/C-007 (AS-015): a soft-deleted annotation is terminal — refuse resolve/reopen.
      // S-002/C-003 (AS-003): `isProposal` is suggestion PRESENCE — a proposal (any state) is
      // owner-only to close/resolve/reopen; a remark stays commenter+.
      { annotationId: params.id, resolved, sessionRole, suggestionStatus: sug?.status, isProposal: sug != null, deleted: found!.deletedAt != null },
      resolutionRepo,
    );
    if (!result.ok && result.reason === "not_found") throw new NotFoundError(); // deleted → 404
    if (!result.ok) throw new ForbiddenError(); // viewer / non-owner proposal close → 403
    return { status: result.status };
  }

  // ONE enveloped Elysia for the whole cluster. The session-only routes live in a
  // `.group` that mounts requireSession (scoped to that group); the guest-capable
  // comment route is a sibling OUTSIDE that group so it carries no session gate.
  // (Composing two separately-enveloped plugins would double-wrap the response.)
  return apiEnvelope(new Elysia())
    .group("", (g) =>
      g
        .use(requireSession({ resolveSession: deps.resolveSession }))
        .use(requireWorkspaceMember({ resolveWorkspaceRole: deps.resolveWorkspaceRole }))
        .group("", (a) => a.use(withValidation(createAnnotationSchema)).post("/api/w/:workspaceId/docs/:slug/annotations", createAnnotationHandler))
        .get("/api/w/:workspaceId/docs/:slug/annotations", listAnnotationsHandler)
        .group("", (a) => a.use(withValidation(resolutionSchema)).patch("/api/w/:workspaceId/annotations/:id/resolution", resolutionHandler))
        .group("", (a) => a.use(withValidation(createSuggestionSchema)).post("/api/w/:workspaceId/docs/:slug/suggestions", createSuggestionHandler))
        .group("", (a) => a.use(withValidation(decideSuggestionSchema)).patch("/api/w/:workspaceId/suggestions/:id", decideSuggestionHandler)),
    )
    .group("", (g) => g.use(withValidation(replySchema)).post("/api/w/:workspaceId/annotations/:id/comments", commentHandler))
    // doc-access-routing S-004: the DOC-ADDRESSED, session-OPTIONAL routes the slug-only
    // viewer (S-003) calls — gated by resolveAccess, NO requireWorkspaceMember. A guest may
    // write on an anyone_with_link + guest-on doc (C-005); anon writes are rate-limited
    // (C-008) and guest-name impersonation is rejected (C-009) inside commentHandler.
    .group("", (a) => a.use(withValidation(createAnnotationSchema)).post("/api/docs/:slug/annotations", docCreateAnnotationHandler))
    .get("/api/docs/:slug/annotations", docListAnnotationsHandler)
    .group("", (a) => a.use(withValidation(replySchema)).post("/api/docs/:slug/annotations/:id/comments", commentHandler))
    .group("", (a) => a.use(withValidation(resolutionSchema)).patch("/api/docs/:slug/annotations/:id/resolution", docResolutionHandler))
    // annotation-actions S-004 / C-006: delete an annotation (soft). Mounted session-OPTIONAL
    // (doc-addressed) but the handler enforces session-REQUIRED before any authz (AS-012),
    // then existence-hiding 404 + parent-doc binding + own/owner gate (AS-013).
    .delete("/api/docs/:slug/annotations/:id", deleteAnnotationHandler)
    // annotation-actions S-005 / C-007 (AS-016): restore a soft-deleted annotation. Mounted
    // session-OPTIONAL (doc-addressed) but the handler enforces session-REQUIRED before authz,
    // then existence-hiding 404 + author/owner gate — the durable undo behind the FE toast.
    .post("/api/docs/:slug/annotations/:id/restore", restoreAnnotationHandler);
}
