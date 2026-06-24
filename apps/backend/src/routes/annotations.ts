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
import { readAdmissionCookie } from "../sharing/capability-cookie";
import { can, type Role } from "../sharing/roles";
import {
  createAnnotation,
  createAnnotationWithComment,
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
import {
  dismissAnnotation,
  reattachAnnotation,
  type DismissReattachRepo,
} from "../annotation/dismiss-reattach";
import { reanchorAnnotation } from "../annotation/reanchor";
import { renderForAnchoring } from "../render/markdown";
import { createSuggestion, decideSuggestion, type SuggestionRepo } from "../annotation/suggestion";
import {
  createAnnotationRepo,
  createCommentRepo,
  createGuestCommentRepo,
  createResolutionRepo,
  createDeleteRepo,
  createDismissReattachRepo,
  createSuggestionRepo,
} from "../annotation/repo";
import { createDocLookupRepo, type DocLookupRepo, type ResolveDocRole } from "./versions";
import { notifyOnThreadActivity, notifyOnNewFeedback, notifyOnSuggestionDecided, notifyOnResolved, type MailEnqueuer, type NotifyRepo } from "../notify/notify";
import { createNotifyRepo } from "../notify/repo";
import { emitActivity, type ActivityEmitDeps } from "../activity/emit";
import { createActivityRepo, type ActivityRepo } from "../activity/repo";
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
   *  (S-005 / C-007) lets the resolution route refuse a terminal (deleted) annotation. The
   *  `authorId` (S-003 / C-004) is the proposal's durable creator (null for a guest) — the
   *  decide route gates owner-no-self-approve on creator user-id === acting user-id. */
  findSuggestionDoc(
    suggestionId: string,
  ): Promise<{ docId: string; generalAccess: GeneralAccessLevel; authorId: string | null; deletedAt?: Date | null } | null>;
  /** Current (highest) version content as RENDERED HTML for a doc — for the C-011 stale check
   *  and reattach/anchor validation. Markdown docs are rendered to HTML here (renderForAnchoring)
   *  so block-ids exist before the matcher runs; html docs pass through unchanged. */
  getCurrentVersionContent(docId: string): Promise<string | null>;
  /** annotation-create-version-pin S-001 / C-001: the doc's CURRENT version NUMBER (max version in
   *  doc_versions), or null when the doc has no version yet. A light read for the optimistic create
   *  gate (compare the caller's `expectedVersion` against this); the content is not needed, only the
   *  number. Distinct from getCurrentVersionContent (which renders HTML for the placement matcher). */
  getCurrentVersion(docId: string): Promise<number | null>;
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
          // S-003/C-004: the durable creator, so the decide route can refuse owner self-approve.
          authorId: annotationsTable.authorId,
          // S-005/C-007: surfaced (not filtered) so the resolution route can refuse a deleted one.
          deletedAt: annotationsTable.deletedAt,
        })
        .from(annotationsTable)
        .innerJoin(docsTable, eq(docsTable.id, annotationsTable.docId))
        .where(and(eq(annotationsTable.id, suggestionId), eq(annotationsTable.type, "suggestion")));
      return row ? { ...row, authorId: row.authorId ?? null, deletedAt: row.deletedAt ?? null } : null;
    },
    async getCurrentVersionContent(docId) {
      const [row] = await db
        .select({ content: docVersions.content, kind: docsTable.kind })
        .from(docVersions)
        .innerJoin(docsTable, eq(docsTable.id, docVersions.docId))
        .where(eq(docVersions.docId, docId))
        .orderBy(desc(docVersions.version))
        .limit(1);
      if (!row) return null;
      // Render markdown→HTML so the matcher sees block-ids (markdown source has none); html
      // passes through unchanged. Without this, reattach/anchor validation 400s on markdown docs.
      return renderForAnchoring(row.content, row.kind);
    },
    async getCurrentVersion(docId) {
      // S-001 / C-001: the max version number for the doc (the light optimistic-create gate). No
      // content rendering — just the number the viewer pinned against.
      const [row] = await db
        .select({ version: docVersions.version })
        .from(docVersions)
        .where(eq(docVersions.docId, docId))
        .orderBy(desc(docVersions.version))
        .limit(1);
      return row?.version ?? null;
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
  /** annotation-core S-008 / C-013: the dismiss + re-attach write port (built from `db` if omitted). */
  dismissReattachRepo?: DismissReattachRepo;
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
    /** notifications-email S-007: APP_URL so the reply email carries an absolute deep-link (C-013). */
    appUrl?: string;
  };
  /**
   * workspace-activity S-001 (C-002 / C-005 / C-008): emit a workspace activity row after a
   * SUCCESSFUL comment / reply / resolve on an annotation. Best-effort POST-COMMIT — a logging
   * failure NEVER blocks or rolls back the comment/resolve (emitActivity swallows + logs).
   * Provide a pre-built ActivityRepo (tests) — else one is built from `db` — plus the seams that
   * resolve the row's owning workspace from the DOC (C-008 cross-workspace isolation) and the
   * actor's display name (the session carries only userId). OMIT the whole block to leave activity
   * logging off (a comment/resolve still succeeds; no activity row) — keeps existing route tests
   * that don't exercise activity unchanged.
   */
  activity?: {
    repo?: ActivityRepo;
    /** The doc's OWN workspace (project → workspace) — anchors the row's workspaceId (C-008). */
    workspaceOfDoc: (docId: string) => Promise<string | null>;
    /** Resolve an account user's display name (user.name) for actorName. */
    resolveActorName: (userId: string) => Promise<string | null>;
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

/** C-018: the optional initial comment carried on the unified create. Body+name are sanitized
 *  SERVER-side in the service (C-008), not here. A member sends only `body`; a guest adds a name. */
const firstCommentSchema = z.object({
  body: z.string(),
  guestName: z.string().optional(),
});

/** S-006 (AS-014) / C-018: the optional suggestion payload — `from` pinned span, `to` omitted for a
 *  delete-kind redline, `againstVersion` for the stale pin. Subsumes the standalone suggestion-create. */
const createSuggestionPayloadSchema = z.object({
  from: z.string(),
  to: z.string().optional(),
  againstVersion: z.number().int().positive(),
});

const createAnnotationSchema = z
  .object({
    type: z.enum(["range", "multi_range", "block", "doc"]).optional(),
    anchor: z.union([textAnchorSchema, imageAnchorSchema]),
    // S-009 / C-015 (AS-027): an optional label-preset id; validated against the preset set
    // SERVER-side in createAnnotation (AS-028), not here, so a foreign id is a clean domain refusal.
    label: z.string().optional(),
    // C-018: the optional FIRST comment, persisted ATOMICALLY with the annotation (one tx). A
    // commentless create (future pure highlight) omits it.
    comment: firstCommentSchema.optional(),
    // S-006 / C-018: the optional suggestion payload — creating a suggestion now rides this unified
    // create (the standalone POST …/suggestions is subsumed). Mutually exclusive with a label
    // (AS-029, refused below + re-checked in the service).
    suggestion: createSuggestionPayloadSchema.optional(),
    // annotation-create-version-pin S-001 / C-001: an OPTIONAL optimistic-concurrency token — the doc
    // version the client composed the anchor against. PRESENT + ≠ current → the create is refused with
    // NO write (409, carrying the current version, AS-002/C-002). ABSENT → no version check (back-compat,
    // AS-003). The gate runs in the handler BEFORE the atomic write, so a refusal is atomic-preserving.
    expectedVersion: z.number().int().optional(),
  })
  .refine((b) => !(b.label != null && b.suggestion != null), {
    message: "a label annotation and a suggestion are mutually exclusive",
    path: ["label"],
  });

const replySchema = z.object({
  body: z.string(),
  parentId: z.string().optional(),
  guestName: z.string().optional(),
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
 * S-008 / AS-024: re-attach body — the fresh range the caller selected in the current version.
 * A text anchor (the only kind that re-anchors); the placement against the current content is
 * validated in the handler (a non-matching anchor → 400).
 */
const reattachSchema = z.object({
  anchor: textAnchorSchema,
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
  // S-008/C-013: dismiss + re-attach a detached annotation.
  const dismissReattachRepo =
    deps.dismissReattachRepo ?? (deps.db ? createDismissReattachRepo(deps.db) : need("dismissReattachRepo"));
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
          // S-007: forwarded so the reply email (high-signal) carries the absolute deep-link.
          appUrl: deps.notify.appUrl,
        }
      : null;

  // workspace-activity S-001: built only when the `activity` block is provided. The repo is
  // pre-built (tests) or built from `db`; the workspaceOfDoc + resolveActorName seams resolve the
  // row's owning workspace (C-008) + the actor name per-emit. Absent → activity emit is a no-op.
  const activityDeps: ActivityEmitDeps | null =
    deps.activity != null
      ? {
          repo: deps.activity.repo ?? (deps.db ? createActivityRepo(deps.db) : need("activity.repo")),
          workspaceOfDoc: deps.activity.workspaceOfDoc,
          resolveActorName: deps.activity.resolveActorName,
        }
      : null;

  /**
   * workspace-activity S-001 (C-002 / C-005) — best-effort post-commit activity emit for a
   * comment/reply/resolve on an annotation. Resolves the row's owning workspace from the DOC
   * (C-008) and the actor's display name (the session carries only userId). A guest actor (null
   * userId) carries "System" unless the caller passes a guest name. NEVER throws (emitActivity
   * swallows + logs), so an activity failure can't block the comment/resolve (AS-006). No-op when
   * the activity block is unwired.
   */
  async function dispatchActivity(input: {
    type: "comment" | "reply" | "resolve";
    docId: string;
    actorUserId: string | null;
    actorName?: string | null;
    annotationId: string;
    commentId?: string | null;
    summary?: string | null;
    target?: string | null;
    /** the comment text → meta.body, rendered as the row's preview line (prototype .act-preview). */
    body?: string | null;
    /** the annotated text the comment anchors to → meta.quote (prototype .act-quote). */
    quote?: string | null;
  }) {
    if (!activityDeps) return;
    // Trim the preview text so a long comment never bloats the feed row (the FE also clamps to 2
    // lines); plain text only (F-12 — rendered escaped, never as HTML).
    const clip = (s: string | null | undefined, n: number) =>
      s && s.trim() ? s.trim().slice(0, n) : undefined;
    const meta: Record<string, unknown> = {};
    const body = clip(input.body, 280);
    const quote = clip(input.quote, 200);
    if (body) meta.body = body;
    if (quote) meta.quote = quote;
    // comment/reply open a thread (the prototype's "Open"/"N replies" chip); resolve closes it.
    if (input.type === "resolve") meta.thread = "resolved";
    else meta.thread = "open";
    await emitActivity(
      {
        type: input.type,
        actorUserId: input.actorUserId,
        actorName: input.actorName ?? null,
        docId: input.docId,
        annotationId: input.annotationId,
        commentId: input.commentId ?? null,
        summary: input.summary ?? null,
        target: input.target ?? null,
        meta: Object.keys(meta).length ? meta : undefined,
      },
      activityDeps,
    );
  }

  /**
   * notifications-email S-002 — best-effort post-commit notify on THREAD ACTIVITY (a comment OR
   * reply on an EXISTING annotation). Notifies the thread participants ∪ doc owner, minus the
   * actor (C-002), minus any candidate without CURRENT doc access (C-003), emitting
   * `thread_activity` (C-004) — NOT the legacy `reply` type, and NOT new_feedback (a brand-new
   * annotation uses dispatchNewFeedbackNotify instead, so a top-level comment on an existing
   * annotation routes here — the trigger-drift fix, AS-004). The access-filter is built HERE from
   * the REAL `resolveAccess` (the seam) keyed on this doc — a participant whose access was revoked
   * is dropped before any channel. Never throws (notifyOnThreadActivity swallows + logs), so a
   * notify failure can't 500 the comment. No-op when the notify block is unwired.
   */
  async function dispatchThreadActivityNotify(
    docId: string,
    annotationId: string,
    actorUserId: string | null,
    // S-006 (AS-027/AS-028): the just-inserted triggering comment id — stored on the in-app row
    // so the panel can join the commenter's name + a body excerpt.
    commentId: string | null,
  ) {
    if (!notifyDeps) return;
    await notifyOnThreadActivity(
      { annotationId, actorUserId, commentId },
      {
        ...notifyDeps,
        type: "thread_activity",
        // C-003 seam: hit the real resolver against this doc — a participant without current
        // access (e.g. membership revoked) is dropped before any channel fires.
        accessFilter: async (userId) =>
          (await deps.resolveAccess(docId, { kind: "user", userId })).canView,
      },
    );
  }

  /**
   * notifications-email S-001 — best-effort post-commit notify on NEW FEEDBACK (a brand-new
   * annotation). Notifies the doc owner + every active editor, minus the actor (C-002), minus
   * any candidate without CURRENT doc access (C-003). The access-filter is built HERE from the
   * REAL `resolveAccess` (the seam, AS-002) keyed on this doc — a revoked editor gets dropped.
   * Never throws (notifyOnNewFeedback swallows + logs), so a notify failure can't 500 the create.
   * No-op when the notify block is unwired.
   */
  async function dispatchNewFeedbackNotify(
    docId: string,
    annotationId: string,
    actorUserId: string | null,
    // S-006 (AS-027/AS-028): the create's opening comment id (null when the create had no comment)
    // — stored on the in-app row to back the panel's actor name + body excerpt.
    commentId: string | null,
  ) {
    if (!notifyDeps) return;
    await notifyOnNewFeedback(
      { annotationId, actorUserId, commentId },
      {
        ...notifyDeps,
        type: "new_feedback",
        // C-003 seam: hit the real resolver against this doc — a candidate without current
        // access (e.g. an editor whose membership was revoked) is dropped before any channel.
        accessFilter: async (userId) =>
          (await deps.resolveAccess(docId, { kind: "user", userId })).canView,
      },
    );
  }

  /**
   * notifications-email S-003 — best-effort post-commit notify on SUGGESTION DECIDED (an owner
   * accepted or rejected a proposal). Notifies the proposal's durable AUTHOR, minus the actor
   * (C-002 self-exclusion — owner deciding their own proposal notifies no one), minus the author
   * if they lost doc access (C-003). Emits `suggestion_decided` (high-signal → in-app + email,
   * C-006); the deep-link points at the suggestion's own annotation id. A guest-authored proposal
   * (null author) is a clean no-op. The access-filter is built HERE from the REAL `resolveAccess`
   * (the seam) keyed on this doc. Never throws (notifyOnSuggestionDecided swallows + logs), so a
   * notify failure can't 500 the decide. No-op when the notify block is unwired.
   */
  async function dispatchSuggestionDecidedNotify(
    docId: string,
    suggestionId: string,
    authorId: string | null,
    actorUserId: string | null,
  ) {
    if (!notifyDeps) return;
    await notifyOnSuggestionDecided(
      { annotationId: suggestionId, authorId, actorUserId },
      {
        ...notifyDeps,
        type: "suggestion_decided",
        // C-003 seam: hit the real resolver against this doc — an author who lost access is dropped.
        accessFilter: async (userId) =>
          (await deps.resolveAccess(docId, { kind: "user", userId })).canView,
      },
    );
  }

  /**
   * notifications-email S-004 — best-effort post-commit notify on RESOLVED/REOPENED (someone
   * resolved or reopened an annotation). Notifies the annotation's durable CREATOR, minus the
   * acting resolver (C-002 self-exclusion — resolving your OWN annotation notifies no one), minus
   * the creator if they lost doc access (C-003). IN-APP ONLY — `resolved` is LOW-SIGNAL (C-006),
   * so NO email is enqueued (this is the crux of AS-008). Reopen is IDENTICAL (same `resolved`
   * type, same creator recipient). A guest-created annotation (null creator) is a clean no-op. The
   * access-filter is built HERE from the REAL `resolveAccess` (the seam) keyed on this doc. Never
   * throws (notifyOnResolved swallows + logs), so a notify failure can't 500 the resolve. No-op
   * when the notify block is unwired.
   */
  async function dispatchResolvedNotify(
    docId: string,
    annotationId: string,
    creatorId: string | null,
    actorUserId: string | null,
  ) {
    if (!notifyDeps) return;
    await notifyOnResolved(
      { annotationId, creatorId, actorUserId },
      {
        ...notifyDeps,
        // C-006: `resolved` is forced low-signal in notifyOnResolved regardless of this — set for
        // clarity. No email ever fires for this event.
        type: "resolved",
        // C-003 seam: hit the real resolver against this doc — a creator who lost access is dropped.
        accessFilter: async (userId) =>
          (await deps.resolveAccess(docId, { kind: "user", userId })).canView,
      },
    );
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
   * annotation-create-version-pin S-001 / C-001 / C-002: the LIGHT optimistic-concurrency gate
   * shared by BOTH create entry points (session + guest), so the version check is identity-agnostic
   * (AS-004) and lives in ONE place. When `expectedVersion` is PRESENT and ≠ the doc's CURRENT
   * version → throw a 409 ConflictError carrying the current version, so NOTHING is written (it runs
   * BEFORE createAnnotationWithComment — atomicity preserved, C-018). When ABSENT → no-op (back-compat,
   * AS-003). NOT the in-transaction hard pin of mcp-patch-document:C-003 — create mutates no doc
   * content, so this read-compare is best-effort (a benign race re-anchors at the next publish).
   */
  async function gateExpectedVersion(docId: string, expectedVersion: number | undefined): Promise<void> {
    if (expectedVersion === undefined) return; // AS-003: omitted → no check.
    const currentVersion = await annotationLookupRepo.getCurrentVersion(docId);
    if (currentVersion !== null && currentVersion !== expectedVersion) {
      // AS-002 / C-002: refuse with NO write; carry the current version so the client can re-read.
      throw new ConflictError("Document has changed — re-read before annotating", {
        details: { currentVersion },
      });
    }
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

  /**
   * capability-share-link S-002 / C-006: build the anon `Viewer`, carrying the raw admission
   * cookie value (if the request presents one) so the single resolveAccess gate can validate
   * it against the doc's current capability token and admit at the cookie's link role on
   * THIS anon-reachable endpoint (read AND write). A signed-in caller never needs it (their
   * role is the session); a guest with no cookie carries undefined → the gate's existing
   * slug admit applies, unchanged.
   */
  function anonViewer(request: Request): Viewer {
    return { kind: "anon", admissionCookie: readAdmissionCookie(request) };
  }

  // ── handlers (extracted so the route tree below reads as a contract) ──

  async function createAnnotationHandler({ params, actor, validBody, set }: any) {
    const body = validBody as z.infer<typeof createAnnotationSchema>;
    const viewer: Viewer = { kind: "user", userId: actor.userId };
    const doc = await loadVisibleDocBySlug(params.slug, viewer); // 404 if missing/hidden
    const sessionRole = await docRole(doc.id, actor.userId); // server re-auth (AS-020)
    // S-001 / C-001: optimistic version gate — a stale `expectedVersion` 409s BEFORE the atomic
    // write, so neither the annotation nor its first comment is persisted (AS-002 atomic-preserving).
    await gateExpectedVersion(doc.id, body.expectedVersion);
    // C-018: annotation + first comment (+ optional suggestion) in ONE atomic write.
    const result = await createAnnotationWithComment(
      {
        docId: doc.id,
        anchor: toAnchor(body.anchor),
        viewer,
        sessionRole,
        type: ("region" in body.anchor ? "block" : body.type ?? "range") as AnnotationType,
        label: body.label, // S-009: validated ∈ preset set in the service (AS-028).
        comment: body.comment,
        suggestion: body.suggestion, // S-006 (AS-014): subsumed suggestion-create.
        // S-001/C-005 (AS-001): the durable creator — the session actor (this mount is
        // session-required, so an actor always exists).
        authorId: actor.userId,
      },
      annotationRepo,
    );
    if (!result.created) {
      // Empty body / missing guest name / unknown label / label+suggestion → bad request (AS-004/028/029).
      if (result.reason === "invalid_label") throw new ValidationError("Unknown label", { field: "label" });
      if (result.reason === "label_and_suggestion") {
        throw new ValidationError("a label annotation and a suggestion are mutually exclusive", { field: "label" });
      }
      if (result.reason === "empty_body") throw new ValidationError("body must not be empty", { field: "body" });
      if (result.reason === "empty_name") throw new ValidationError("guestName is required", { field: "guestName" });
      throw new ForbiddenError(); // viewer/forged role → 403 (AS-020)
    }
    // notifications-email S-001 / C-004: a brand-new annotation is NEW FEEDBACK, not thread
    // activity — notify the doc owner + every editor (minus the actor, minus no-access), NOT
    // the reply path (which had only the creator as participant here → was a no-op anyway).
    await dispatchNewFeedbackNotify(doc.id, result.id, actor.userId, result.commentId ?? null);
    // workspace-activity S-001 (C-005): a new annotation carrying a first comment IS a `comment`
    // event — log it best-effort (only when the create actually carried a comment).
    if (result.commentId != null) {
      await dispatchActivity({
        type: "comment",
        docId: doc.id,
        actorUserId: actor.userId,
        annotationId: result.id,
        commentId: result.commentId,
        summary: "commented on",
        target: doc.title,
        body: body.comment?.body ?? null,
        quote: body.anchor && "textSnippet" in body.anchor ? body.anchor.textSnippet : null,
      });
    }
    set.status = 201;
    return { annotationId: result.id, ...(result.commentId != null ? { commentId: result.commentId } : {}) };
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
    // notifications-email S-004 (AS-008): a settled resolve/reopen notifies the annotation's
    // durable CREATOR (found.authorId; null for a guest → no recipient), minus the acting resolver
    // (self-exclusion). IN-APP ONLY (resolved is low-signal). Best-effort post-commit; reopen fires
    // identically (same event type). Fires only past the ok gate (no notify on a forbidden toggle).
    await dispatchResolvedNotify(parent.docId, params.id, found!.authorId, actor.userId);
    // workspace-activity S-001 (C-005): a RESOLVE logs a `resolve` event. A reopen is not one of
    // the twelve types, so emit only when the toggle settled to resolved. Best-effort post-commit.
    if (result.ok && result.status === "resolved") {
      await dispatchActivity({
        type: "resolve",
        docId: parent.docId,
        actorUserId: actor.userId,
        annotationId: params.id,
        summary: "resolved a comment",
      });
    }
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
    const found = await annotationLookupRepo.findSuggestionDoc(params.id);
    const parent = await enforceParentAccess(found, viewer);
    // Owner-only: deciding a suggestion is a manage-class action (AS-015).
    const sessionRole = await docRole(parent.docId, actor.userId);
    if (sessionRole !== "owner") throw new ForbiddenError();
    const currentHtml = (await annotationLookupRepo.getCurrentVersionContent(parent.docId)) ?? "";
    const result = await decideSuggestion(
      {
        suggestionId: params.id,
        decision,
        currentVersionContentHtml: currentHtml,
        // S-003/C-004 (AS-005/AS-007): the self-approve gate keys on the SESSION actor's id
        // (server-resolved, never the body) vs the proposal's persisted creator.
        actorUserId: actor.userId,
        authorId: found!.authorId, // bound to the resolved suggestion (found non-null past the 404 gate).
      },
      suggestionRepo,
    );
    // S-003/C-004 (AS-005): the owner authored this proposal → no self-approve. Distinct from the
    // not_found (deleted/no-access) case, so it surfaces as a 403, not a 404.
    if (!result.ok && result.reason === "self_approve") throw new ForbiddenError();
    if (!result.ok) throw new NotFoundError(); // suggestion vanished / deleted (terminal)
    // AS-022: a drifted `from` came back `stale` on accept → 409 CONFLICT.
    if (result.status === "stale") {
      throw new ConflictError("Suggestion is stale: the target text has changed", {
        details: { status: "stale" },
      });
    }
    // notifications-email S-003 (AS-006/AS-007): a SETTLED decision (accepted or rejected) is
    // suggestion_decided → notify the proposal's author (minus the deciding actor — self-exclusion,
    // C-002), best-effort post-commit. The actor is the session owner; the author is the proposal's
    // durable creator (found.authorId; null for a guest → no recipient). A stale outcome (above)
    // already returned, so this fires only on a real accept/reject.
    await dispatchSuggestionDecidedNotify(parent.docId, params.id, found!.authorId, actor.userId);
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

  /**
   * annotation-core S-008 / C-013 (AS-023): DISMISS a detached annotation (soft) — it leaves the
   * doc's active list but is kept, not hard-deleted. Mounted in the SESSION-REQUIRED, workspace-
   * scoped group (the `actor` is always present), so a viewer is the only refusal: commenter+ may
   * dismiss (AS-025). The SAME existence-hiding gate every annotation route uses runs on the
   * resolved parent doc (404 on missing/no-access), then the caller's doc-scoped role gates the
   * comment-permission check in the service.
   */
  async function dismissHandler({ params, actor }: any) {
    const viewer: Viewer = { kind: "user", userId: actor.userId };
    const found = await annotationLookupRepo.findAnnotationDoc(params.id);
    const parent = await enforceParentAccess(found, viewer); // 404 on missing/no-access
    const sessionRole = await docRole(parent.docId, actor.userId); // server re-auth
    const result = await dismissAnnotation({ annotationId: params.id, sessionRole }, dismissReattachRepo);
    if (!result.ok) throw new ForbiddenError(); // viewer → 403 (AS-025)
    return { dismissed: true };
  }

  /**
   * annotation-core S-008 / C-013 (AS-024): RE-ATTACH a detached annotation onto a range the
   * caller selected in the CURRENT version — clears `is_orphaned` and sets the fresh anchor, so
   * it returns anchored. Session-required + existence-hiding 404 + comment-permission gate (a
   * viewer → 403, AS-025) exactly like dismiss. PLUS an anchor-placement check: the submitted
   * anchor must match a block/snippet in the current version content (resolved via
   * getCurrentVersionContent + the re-anchor matcher) — a non-matching anchor → 400 (the range
   * isn't in the current version). The viewer refusal runs BEFORE the anchor check so a viewer's
   * 403 never leaks whether their anchor would have placed (AS-025: unchanged).
   */
  async function reattachHandler({ params, actor, validBody }: any) {
    const body = validBody as z.infer<typeof reattachSchema>;
    const viewer: Viewer = { kind: "user", userId: actor.userId };
    const found = await annotationLookupRepo.findAnnotationDoc(params.id);
    const parent = await enforceParentAccess(found, viewer); // 404 on missing/no-access
    const sessionRole = await docRole(parent.docId, actor.userId); // server re-auth
    // The current version content the submitted range must place against (AS-024). Empty when the
    // doc has no version content → no anchor can place → anchor_mismatch (the route 400s).
    const currentHtml = (await annotationLookupRepo.getCurrentVersionContent(parent.docId)) ?? "";
    const anchorPlaces = (anchor: Anchor) =>
      reanchorAnnotation(anchor, currentHtml).status === "carried";
    const result = await reattachAnnotation(
      { annotationId: params.id, anchor: body.anchor as Anchor, sessionRole },
      anchorPlaces,
      dismissReattachRepo,
    );
    if (!result.ok && result.reason === "anchor_mismatch") {
      throw new ValidationError("The selected range doesn't match the current version", { field: "anchor" });
    }
    if (!result.ok) throw new ForbiddenError(); // viewer → 403 (AS-025)
    return { isOrphaned: false };
  }

  // S-003 reply (session) OR S-007 guest (no session). The guest path requires a name and
  // is authorized purely by the doc's link role (commenter+ on anyone_with_link — no
  // separate guest toggle, Google-Docs model); the service sanitizes body+name (C-008).
  async function commentHandler({ params, request, validBody, set }: any) {
    const body = validBody as z.infer<typeof replySchema>;
    const actor: Actor | null = await deps.resolveSession(request.headers);
    const viewer: Viewer = actor ? { kind: "user", userId: actor.userId } : anonViewer(request);
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
      // S-002: comment/reply persisted on an EXISTING annotation → notify thread participants ∪
      // owner (best-effort, post-commit) as `thread_activity` (C-004 — covers BOTH the reply and
      // the top-level-comment branch above; the top-level case no longer drifts onto new_feedback,
      // AS-004). The actor is the session user; they never notify themselves (notifyOnThreadActivity).
      await dispatchThreadActivityNotify(parent.docId, params.id, actor.userId, result.id);
      // workspace-activity S-001 (C-005): a reply (parentId present) logs `reply`; a top-level
      // comment on an existing annotation logs `comment`. Best-effort post-commit.
      await dispatchActivity({
        type: body.parentId ? "reply" : "comment",
        docId: parent.docId,
        actorUserId: actor.userId,
        annotationId: params.id,
        commentId: result.id,
        summary: body.parentId ? "replied to a comment" : "commented",
        body: body.body,
      });
      set.status = 201;
      return { commentId: result.id };
    }

    // ── ANON (guest) write path ──────────────────────────────────────────────
    // AS-017 (reply gate): an anon may write (reply OR create) ONLY when the effective LINK
    // ROLE is commenter+ — the SAME gate the create path applies via writeRole + can. The
    // guest-commenting toggle that USED to gate this path was removed (commit 41d9f32); without
    // this check a viewer-level anyone_with_link guest could reply (read-only link → write). The
    // link role IS the grant (Google-Docs model): a viewer-level link is REFUSED here (403) BEFORE
    // any write — no rate-limit work, no name check, no comment persisted.
    const access = await deps.resolveAccess(parent.docId, viewer);
    const linkRole = await writeRole(parent.docId, viewer, access);
    if (!can(linkRole, "comment")) {
      throw new ForbiddenError();
    }
    // C-008 (AS-022): rate-limit the anonymous write surface per IP + per doc BEFORE any
    // work (and before notify) so a flood is refused (429) and can't amplify mail — the
    // SAME limiter gates the thread-activity-notification dispatch below (a refused write never
    // reaches dispatchThreadActivityNotify because we throw here first).
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

    // No guest-commenting toggle (Google-Docs model, sharing reversal 2026-06-20): the anon
    // reply reached this path on an anyone_with_link + commenter+ doc — the link role IS the
    // grant. The service only validates the name + body now.
    const result = await createGuestComment(
      {
        annotationId: params.id,
        guestName: body.guestName ?? "",
        body: body.body,
      },
      guestCommentRepo,
    );
    if (!result.created) {
      if (result.reason === "empty_name") throw new ValidationError("guestName is required", { field: "guestName" });
      throw new ValidationError("body must not be empty", { field: "body" });
    }
    // S-002 (C-011, AS-023): a GUEST comment on an existing annotation still notifies
    // account-holder participants + owner as `thread_activity`; the guest has no account, so the
    // actor is null → the guest is never a recipient (excluded automatically — and never IN the
    // participant set, since the repo lists account-holder author_ids only).
    await dispatchThreadActivityNotify(parent.docId, params.id, null, result.id);
    // workspace-activity S-001 (C-005, guest): a guest has no account (actorUserId null) — carry
    // the guest's supplied display name as the PLAIN-TEXT actorName (F-12). reply vs comment by
    // parentId. Best-effort post-commit.
    await dispatchActivity({
      type: body.parentId ? "reply" : "comment",
      docId: parent.docId,
      actorUserId: null,
      actorName: body.guestName ?? null,
      annotationId: params.id,
      commentId: result.id,
      summary: body.parentId ? "replied to a comment" : "commented",
      body: body.body,
    });
    set.status = 201;
    return { commentId: result.id };
  }

  // ── doc-access-routing S-004: DOC-ADDRESSED, SESSION-OPTIONAL handlers ──────
  //
  // These are the routes the slug-only viewer (S-003) calls: no workspace in the path,
  // no requireSession / requireWorkspaceMember gate. Each resolves the session itself
  // (anon → guest), gates the parent doc with the single resolveAccess (existence-hiding
  // 404), and resolves the WRITE role server-side — for a user via resolveDocRole, for an
  // anon via the access result's link role (C-005: an anon may write on an
  // anyone_with_link doc whose link role is commenter+ — the link role IS the grant, no
  // separate guest-commenting toggle, Google-Docs model).

  /** The effective write-role for a viewer on a doc: a user's doc role, or an anon's
   *  link role from the access decision (null → viewer, least privilege). */
  async function writeRole(docId: string, viewer: Viewer, access: AccessResult): Promise<Role> {
    if (viewer.kind === "user") return docRole(docId, viewer.userId);
    return access.role ?? "viewer";
  }

  async function docCreateAnnotationHandler({ params, request, validBody, set }: any) {
    const body = validBody as z.infer<typeof createAnnotationSchema>;
    const actor: Actor | null = await deps.resolveSession(request.headers);
    const viewer: Viewer = actor ? { kind: "user", userId: actor.userId } : anonViewer(request);
    const found = await lookupRepo.findDocBySlug(params.slug);
    const access = found ? await deps.resolveAccess(found.id, viewer) : { role: null, canView: false };
    const doc = enforceReadAccess({ doc: found, allowed: found !== null && access.canView }); // 404 if missing/hidden
    const sessionRole = await writeRole(doc.id, viewer, access); // server re-auth (AS-017/AS-020)

    // S-001 / C-001 (AS-004): the optimistic version gate runs HERE — identity-agnostic, BEFORE the
    // guest-name guards and the atomic write — so a guest's stale create is refused the same way a
    // member's is, with NO annotation/comment written and the current version returned (409, C-002).
    await gateExpectedVersion(doc.id, body.expectedVersion);

    // C-018: a GUEST (no session) create carrying a comment must clear the SAME guest guards the
    // standalone guest-comment path enforced before the comment rode the create — the rate-limit
    // (C-008/AS-022) and the member-name impersonation guard (C-009/AS-023). These run BEFORE the
    // atomic write so a refused guard never persists a row. There is NO guest-commenting toggle
    // (Google-Docs model, sharing reversal 2026-06-20): the anon write was already authorized by the
    // doc's LINK ROLE (writeRole(anon) → the link role; commenter+ passes the create's role gate).
    if (!actor && body.comment != null) {
      // C-008 (AS-022): throttle the anon write surface per IP + per doc BEFORE any work.
      const limit = await rateLimitComment(`${clientIp(request)}:${doc.id}`);
      if (!limit.allowed) {
        throw new RateLimitedError("Too many comments — slow down and try again shortly");
      }
      // C-009 (AS-023): a guest whose typed name collides with an ACTIVE member's display name on
      // this doc is rejected, so the guest cannot read AS that member (the guest marker — author_id
      // null — is already non-spoofable; this stops the NAME spoof). Guest-only (member identity is
      // the session, never a typed name).
      const guestName = body.comment.guestName ?? "";
      if (guestName.trim().length > 0 && (await isActiveMemberName(doc.id, guestName))) {
        throw new ValidationError("That name belongs to a member of this doc; choose another", {
          field: "guestName",
        });
      }
    }

    // C-018: annotation + first comment (+ optional suggestion) in ONE atomic write — a comment
    // failure rolls the annotation back (no orphan). For a guest, authorId is NULL (AS-002: no
    // durable identity to own-gate against) and the body+name are sanitized in the service (C-008).
    const result = await createAnnotationWithComment(
      {
        docId: doc.id,
        anchor: toAnchor(body.anchor),
        viewer,
        sessionRole,
        type: ("region" in body.anchor ? "block" : body.type ?? "range") as AnnotationType,
        label: body.label, // S-009: validated ∈ preset set in the service (AS-028).
        comment: body.comment,
        suggestion: body.suggestion, // S-006 (AS-014): subsumed suggestion-create.
        // S-001/C-005 (AS-001/AS-002): the durable creator — the session actor's id, or NULL
        // for a guest (no account).
        authorId: actor?.userId ?? null,
      },
      annotationRepo,
    );
    if (!result.created) {
      if (result.reason === "invalid_label") throw new ValidationError("Unknown label", { field: "label" });
      if (result.reason === "label_and_suggestion") {
        throw new ValidationError("a label annotation and a suggestion are mutually exclusive", { field: "label" });
      }
      if (result.reason === "empty_body") throw new ValidationError("body must not be empty", { field: "body" });
      if (result.reason === "empty_name") throw new ValidationError("guestName is required", { field: "guestName" });
      throw new ForbiddenError(); // viewer/forged role → 403
    }
    // notifications-email S-001 / C-004 + C-011: a brand-new annotation is NEW FEEDBACK →
    // notify the doc owner + every editor, minus the actor, minus no-access. A GUEST create
    // (actor null) still notifies owner + editors and excludes nobody (the guest has no
    // account, so is never a recipient anyway).
    await dispatchNewFeedbackNotify(doc.id, result.id, actor?.userId ?? null, result.commentId ?? null);
    // workspace-activity S-001 (C-005): a new annotation carrying a first comment IS a `comment`
    // event. A GUEST create (actor null) carries the guest's supplied name as actorName (F-12).
    if (result.commentId != null) {
      await dispatchActivity({
        type: "comment",
        docId: doc.id,
        actorUserId: actor?.userId ?? null,
        actorName: actor ? null : body.comment?.guestName ?? null,
        annotationId: result.id,
        commentId: result.commentId,
        summary: "commented on",
        target: doc.title,
        body: body.comment?.body ?? null,
        quote: body.anchor && "textSnippet" in body.anchor ? body.anchor.textSnippet : null,
      });
    }
    set.status = 201;
    return { annotationId: result.id, ...(result.commentId != null ? { commentId: result.commentId } : {}) };
  }

  async function docListAnnotationsHandler({ params, request, query }: any) {
    const actor: Actor | null = await deps.resolveSession(request.headers);
    const viewer: Viewer = actor ? { kind: "user", userId: actor.userId } : anonViewer(request);
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
    const viewer: Viewer = actor ? { kind: "user", userId: actor.userId } : anonViewer(request);
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
    // notifications-email S-004 (AS-008): same as the workspace-scoped resolution handler — notify
    // the annotation's durable CREATOR (found.authorId), minus the acting resolver (self-exclusion).
    // IN-APP ONLY. The actor on this DOC-ADDRESSED route may be a guest (anon) → null actor, which
    // excludes nobody; a guest still can't be a recipient (the creator is the recipient, not the actor).
    await dispatchResolvedNotify(parent.docId, params.id, found!.authorId, actor?.userId ?? null);
    // workspace-activity S-001 (C-005): emit a `resolve` event only when the toggle settled to
    // resolved (a reopen is not one of the twelve types). A guest actor (null) carries "System"
    // unless a name is known. Best-effort post-commit.
    if (result.ok && result.status === "resolved") {
      await dispatchActivity({
        type: "resolve",
        docId: parent.docId,
        actorUserId: actor?.userId ?? null,
        annotationId: params.id,
        summary: "resolved a comment",
      });
    }
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
        // annotation-core S-008 / C-013: dismiss (AS-023, no body) + re-attach (AS-024, { anchor })
        // a detached annotation. Session-required (commenter+); the handler 403s a viewer (AS-025).
        .post("/api/w/:workspaceId/annotations/:id/dismiss", dismissHandler)
        .group("", (a) => a.use(withValidation(reattachSchema)).post("/api/w/:workspaceId/annotations/:id/reattach", reattachHandler))
        .group("", (a) => a.use(withValidation(createSuggestionSchema)).post("/api/w/:workspaceId/docs/:slug/suggestions", createSuggestionHandler))
        .group("", (a) => a.use(withValidation(decideSuggestionSchema)).patch("/api/w/:workspaceId/suggestions/:id", decideSuggestionHandler)),
    )
    .group("", (g) => g.use(withValidation(replySchema)).post("/api/w/:workspaceId/annotations/:id/comments", commentHandler))
    // doc-access-routing S-004: the DOC-ADDRESSED, session-OPTIONAL routes the slug-only
    // viewer (S-003) calls — gated by resolveAccess, NO requireWorkspaceMember. A guest may
    // write on an anyone_with_link doc whose link role is commenter+ (C-005, no separate
    // toggle); anon writes are rate-limited (C-008) and guest-name impersonation is rejected
    // (C-009) inside commentHandler.
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
