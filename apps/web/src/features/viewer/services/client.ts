import { api } from "@/lib/api";
import type { EdenResult } from "@/lib/api/use-api-query";
import {
  fetchAllAnnotationPages,
  type AnnotationsPage,
} from "@/features/viewer/services/paginate-annotations";

// Typed request thunk for the in-app viewer's doc read (doc-access-routing S-002/S-003):
//   GET /api/docs/:slug   (doc-addressed, NO workspace in the path — C-002/C-007)
// → { doc: { title, kind, version, status, generalAccess }, content }
//     - kind=markdown → `content` is sanitized app-theme HTML (server-side dompurify +
//       data-block-id injection); the viewer renders it in the app origin (C-001).
//     - kind=html|image → `content` is { contentUrl: "/v/:id" }, a reference to the
//       sandboxed content the viewer loads in an isolated iframe (C-001/C-008).
//   404 → a missing slug OR a doc the caller cannot view, indistinguishable (C-002,
//     existence-hiding). The screen turns that into a not-found state, never an empty render.
//
// Same rationale as features/docs/client.ts: the backend mounts this route CONDITIONALLY,
// so the exported `App` treaty type can't statically widen to include it. We reach it via
// the SAME runtime treaty client and annotate the return ourselves. Component tests MOCK
// this module, so the cast is never exercised under test.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const treaty = api as any;

export type ViewerDocKind = "markdown" | "html" | "image";

/** The session's effective role on THIS doc (most-permissive of membership + per-doc share).
 *  Drives the compose affordance gate (C-004): only `commenter`+ may comment; `viewer` is
 *  read-only. The server is the source of truth + re-authorizes every write (C-001) — this is a
 *  UI hint, not a security boundary. Absent (older payload) → treated as comment-capable so the
 *  read-side viewer tests that don't carry a role keep their compose-agnostic behavior. */
export type EffectiveRole = "viewer" | "commenter" | "editor" | "owner";

export function canComment(role: EffectiveRole | undefined): boolean {
  // Only an explicit viewer role is read-only; anything else (incl. an absent/unknown role) may
  // compose. The server re-authorizes the write regardless (C-001), so an over-permissive hint
  // surfaces as the AS-013 refused-write rollback, never a silent forged annotation.
  return role !== "viewer";
}

export interface ViewerDocResponse {
  doc: {
    title: string;
    kind: ViewerDocKind;
    version: number;
    status: string;
    generalAccess: string;
    /** the caller's effective role on this doc (C-004 compose gate); optional on older payloads. */
    effectiveRole?: EffectiveRole;
    /** S-005 (C-007): true when this session is a logged-out GUEST commenting via anyone-with-link
     *  + guest-commenting-enabled. The FE only CONSUMES this — the toggle that enables guest
     *  commenting is owned by sharing-permissions. Drives the composer's GuestNameField + the
     *  name-required gate + the guest attribution badge (C-010). Absent → a logged-in member. */
    guest?: boolean;
    /** doc-access-routing S-003/AS-030: the doc's OWN workspace (project → workspace), or `null`
     *  when the doc has no project (C-011). The doc-scoped public viewer has no :workspaceId URL
     *  param, so a signed-in member sources it from HERE to open the workspace-addressed Share
     *  dialog + Version history (C-007). A signed-in member with a non-null workspaceId sees those
     *  panels; an anon or a null workspaceId → panels hidden. Absent/null (older payload or
     *  project-less doc) → treated as no workspace → panels hidden. */
    workspaceId?: string | null;
  };
  /** markdown → sanitized HTML string; html/image → a { contentUrl } sandbox reference. */
  content: string | { contentUrl: string };
}

/** GET /api/docs/:slug — the access-gated, anon-capable doc read for the in-app viewer.
 *  doc-access-routing S-002/S-003 (C-002/C-004): addressed by slug alone (no workspace in the
 *  path), session optional. A no-access OR missing doc → 404 (existence-hiding), NEVER a 401, so
 *  the global session-expiry bounce can't fire on it. */
export function fetchViewerDoc(slug: string): Promise<EdenResult<ViewerDocResponse>> {
  return treaty.api.docs({ slug }).get() as Promise<EdenResult<ViewerDocResponse>>;
}

// --- Annotations read (S-003) -------------------------------------------------------------
// GET /api/w/:workspaceId/docs/:slug/annotations (GAP-001: the path is workspace-scoped). The
// response is the api-core paginated envelope `{ items, pagination }`. Each item carries its
// text-range anchor + status + isOrphaned flag + a flat comment thread. The viewer pairs each
// anchored item to an in-text highlight (annotation-marks) and lists it as a rail thread; an
// isOrphaned item is shown in the detached section instead, never highlighted (C-004).

export interface AnnotationComment {
  id: string;
  parentId: string | null;
  /** session author name OR a guest's self-entered name (one or the other is present). */
  authorName?: string;
  guestName?: string;
  body: string;
  createdAt: string;
}

export interface AnnotationAnchor {
  blockId: string;
  textSnippet: string;
  offset: number;
  length: number;
  segments?: { blockId: string; textSnippet: string; offset: number; length: number }[];
}

/** annotation-core-ui-types-modes S-002 (C-002): a suggestion's lifecycle, distinct from the
 *  thread `status`. A redline rides `type=suggestion` + `suggestion.kind=delete`. `stale` means the
 *  pinned `from` span drifted out of the current version → rendered muted/dashed, never a confident
 *  strike, and not acceptable (AS-007). */
export type SuggestionStatus = "pending" | "accepted" | "rejected" | "stale";

/** The suggestion payload served on the annotation read (Linked Fields). A redline is `kind:delete`
 *  (no `to`); a replace suggestion carries `to`. The viewer reads `kind` to render the redline strike
 *  and `from` for the struck quote. */
export type SuggestionPayload =
  | { kind: "delete"; from: string; againstVersion: number }
  | { kind: "replace"; from: string; to: string; againstVersion: number };

export interface ViewerAnnotation {
  id: string;
  type: string;
  anchor: AnnotationAnchor;
  status: "unresolved" | "resolved";
  isOrphaned: boolean;
  comments: AnnotationComment[];
  /** S-003/S-004 (Linked Fields / AS-027): the label-preset id on a SIGNAL annotation
   *  (comment/like/label). `looks-good` is the built-in Like preset (S-003); the rest are the review
   *  labels (S-004). Served on the GET list so the rail renders the label line (👍 "Looks good") from
   *  a real read. Mutually exclusive with `suggestion` (a redline carries no label). Absent on a plain
   *  comment / redline / suggest. */
  label?: string;
  /** S-002 (Linked Fields): the suggestion payload for a `type=suggestion` annotation (redline =
   *  `kind:delete`). Absent on ordinary comment/like/label annotations. */
  suggestion?: SuggestionPayload;
  /** S-002 (C-002/AS-007): the suggestion's lifecycle status, served on read so the rail renders
   *  accepted/rejected/stale at read time. Absent on non-suggestion annotations. */
  suggestionStatus?: SuggestionStatus;
  /** annotation-actions-ui S-001 (C-001): the DURABLE creator id, served on every annotation in the
   *  list read (`annotation-actions`:S-001). The FE compares it to the current session user id to
   *  decide own-vs-others — the basis for the no-self-approve gate (S-002) and delete-own (S-003).
   *  `null` = guest-created (no durable creator), which matches NO signed-in user, so a guest
   *  annotation is never marked own. This is NOT the root-comment author — it is a dedicated field. */
  authorId?: string | null;
}

/** The viewer's annotation-list payload. Re-exported from the paging helper so existing call sites
 *  (`import { ListAnnotationsResponse } from ".../services/client"`) are unchanged. */
export type ListAnnotationsResponse = AnnotationsPage;

/** GET /api/docs/:slug/annotations — read the doc's annotations for the viewer.
 *  doc-access-routing S-003: doc-addressed (slug only, no workspace path — C-007), anon-capable.
 *  The viewer tags this read `meta.viewerRead` so a no-access reply can never bounce to /signin
 *  (AS-014). NOTE: the doc-scoped annotation READ backend route is owned by S-004; until it lands
 *  this read returns no-access for an anon, which the viewer surfaces in place (no bounce).
 *
 *  annotation-core-ui S-003 / AS-021 / C-008: reads the COMPLETE active set, never a capped first
 *  page. The endpoint paginates (default 20, cap 100), so a doc with >1 read-page's worth of
 *  annotations would otherwise lose its tail from BOTH the rail list and the in-text highlights.
 *  The paging loop (fetchAllAnnotationPages) requests the max page size and follows `pagination.
 *  hasNext`, accumulating every page, so the returned `items` are the full set and the rail total
 *  equals the dashboard's annotation count. The loop is its own module so a service-level test can
 *  exercise it without the process-global `mock.module` shadow on THIS file. */
export function listAnnotations(slug: string): Promise<EdenResult<ListAnnotationsResponse>> {
  return fetchAllAnnotationPages((page, limit) =>
    treaty.api
      .docs({ slug })
      .annotations.get({ query: { page: String(page), limit: String(limit) } }),
  );
}

// --- Annotation / comment WRITE (S-001 commenting) -----------------------------------------
// The write path: POST …/docs/:slug/annotations to create a block-anchored annotation, then
// POST …/annotations/:id/comments to attach the comment body. Both are workspace-scoped
// (GAP-001). Identity rides the session cookie (api.ts credentials:include) — the body carries
// NO userId. Every write is re-authorized server-side by the session role (C-001): a forged role
// hint cannot create an annotation; a revoked role comes back refused → the FE rolls back (C-011).

/** The text-range anchor sent on create (selection→anchor, G3). `segments` spans multi-block. */
export interface CreateAnchor {
  blockId: string;
  textSnippet: string;
  offset: number;
  length: number;
  segments?: { blockId: string; textSnippet: string; offset: number; length: number }[];
}

/** C-018: the OPTIONAL first comment carried on the unified create. A member sends only `body`; a
 *  guest adds its self-entered `guestName` (+ optional `guestEmail`). Body+name are sanitized
 *  SERVER-side (C-008). Omit for a commentless highlight. */
export interface CreateCommentPayload {
  body: string;
  guestName?: string;
  guestEmail?: string;
}

/** S-006 (AS-014) / C-018: the OPTIONAL suggestion payload — `from` is the pinned span; omit `to`
 *  for a delete-kind redline; `againstVersion` is the current doc version (the stale pin). Carrying
 *  this makes the created annotation a suggestion (the standalone suggestion-create is subsumed). */
export interface CreateSuggestionPayload {
  from: string;
  to?: string;
  againstVersion: number;
}

export interface CreateAnnotationBody {
  type: string;
  anchor: CreateAnchor;
  /** S-003/S-004 (C-003 / challenge #9): the ONE labeled-create path. A Like rides this same
   *  doc-scoped create as a plain comment annotation, just carrying `label="looks-good"`; a Label
   *  (S-004) carries the chosen preset id. The server validates `label` ∈ the preset set and refuses
   *  a forged id (annotation-core AS-028); it is mutually exclusive with a suggestion payload (AS-029).
   *  Omitted for a plain comment. */
  label?: string;
  /** C-018: the first comment, persisted ATOMICALLY with the annotation in ONE request — there is no
   *  longer a second addComment call on create (a failed write rolls back server-side, no orphan). */
  comment?: CreateCommentPayload;
  /** S-006 (AS-014) / C-018: a redline / replace suggestion rides this SAME create (subsumes the old
   *  workspace-scoped suggestion route). Mutually exclusive with `label`. */
  suggestion?: CreateSuggestionPayload;
}

export interface CreateAnnotationResult {
  annotationId: string;
  /** C-018: present when the create carried a `comment` — the id of the atomically-persisted first
   *  comment. Absent for a commentless highlight. */
  commentId?: string;
}

export interface AddCommentBody {
  body: string;
  parentId?: string;
  guestName?: string;
  guestEmail?: string;
}

export interface AddCommentResult {
  commentId: string;
}

// doc-access-routing S-003: the write paths drop the workspace segment to stay coherent with the
// slug-only viewer (no workspaceId in scope on the public route). The doc-scoped annotation WRITE
// backend routes (create / comment / resolve) are owned by S-004; these client thunks point at the
// doc-addressed paths so the viewer call-sites compile slug-only. Until S-004 lands, an anon write
// is refused server-side (the FE rolls back) — never a forged annotation.

/** POST /api/docs/:slug/annotations — create a block-anchored annotation (S-004 backend). */
export function createAnnotation(
  slug: string,
  body: CreateAnnotationBody,
): Promise<EdenResult<CreateAnnotationResult>> {
  return treaty.api
    .docs({ slug })
    .annotations.post(body) as Promise<EdenResult<CreateAnnotationResult>>;
}

/** POST /api/docs/:slug/annotations/:id/comments — attach a comment to an annotation (S-004). */
export function addComment(
  slug: string,
  annotationId: string,
  body: AddCommentBody,
): Promise<EdenResult<AddCommentResult>> {
  return treaty.api
    .docs({ slug })
    .annotations({ id: annotationId })
    .comments.post(body) as Promise<EdenResult<AddCommentResult>>;
}

// --- Delete + restore (annotation-actions-ui S-003) ----------------------------------------
// DELETE /api/docs/:slug/annotations/:id            → soft-delete (session-required, own/owner)
// POST   /api/docs/:slug/annotations/:id/restore    → clear the tombstone (session-required, own/owner)
// Both are DOC-ADDRESSED (slug only, no workspace segment — coherent with the slug-only viewer) and
// SESSION-REQUIRED: an anon/guest is refused (401) before any own/owner check, a viewer/non-owner-
// non-author is refused (403). A missing/no-access doc → 404 (existence-hiding). The FE affordance
// (the overflow Delete) is a CLIENT HINT — the backend re-authorizes every delete/restore by session
// role + the durable creator identity (annotation-actions S-004/S-005). A soft-deleted annotation is
// EXCLUDED from the annotations list read (S-005), so an optimistic remove stays consistent on a
// refetch; restore brings it back. Mirrors the annotation thunks' shape (Eden treaty, same envelope).

export interface DeleteAnnotationResult {
  deleted: true;
}

export interface RestoreAnnotationResult {
  restored: true;
}

/** DELETE /api/docs/:slug/annotations/:id — soft-delete an annotation (S-004 backend).
 *  The caller branches on the EdenResult: `error` present → refused/failed (roll the optimistic
 *  remove back + surface an error, C-005); `data` present → deleted (show the undo toast). */
export function deleteAnnotation(
  slug: string,
  annotationId: string,
): Promise<EdenResult<DeleteAnnotationResult>> {
  return treaty.api
    .docs({ slug })
    .annotations({ id: annotationId })
    .delete() as Promise<EdenResult<DeleteAnnotationResult>>;
}

/** POST /api/docs/:slug/annotations/:id/restore — clear a soft-delete tombstone (S-005 backend).
 *  Backs the undo toast: on undo within the window the caller calls this + re-adds the item. */
export function restoreAnnotation(
  slug: string,
  annotationId: string,
): Promise<EdenResult<RestoreAnnotationResult>> {
  return treaty.api
    .docs({ slug })
    .annotations({ id: annotationId })
    .restore.post() as Promise<EdenResult<RestoreAnnotationResult>>;
}

// --- Resolution toggle (S-004) -------------------------------------------------------------
// PATCH /api/w/:workspaceId/annotations/:id/resolution — resolve or reopen a thread. NOTE the
// path is workspace-scoped on the ANNOTATION id (NOT doc-scoped like create/comment) — it mirrors
// the backend route `PATCH …/annotations/:id/resolution`. The body is the toggle `{ resolved }`;
// the server re-authorizes by session role (commenter+, C-006/C-001) and returns the new `status`.
// Resolving is NOT author-only — there is no creator field; the role alone authorizes (AS-008).

export interface SetResolutionBody {
  /** true → resolve (status=resolved); false → reopen (status=unresolved). */
  resolved: boolean;
}

export interface SetResolutionResult {
  status: "unresolved" | "resolved";
}

/** PATCH /api/docs/:slug/annotations/:id/resolution — toggle resolved status (S-004 backend).
 *  S-002 (AS-008/C-002): the backend makes reopen of a DECIDED suggestion owner-only and resets its
 *  suggestion_status → pending; a non-owner reopen of a decided redline comes back 403 (the FE rolls
 *  the optimistic toggle back). Ordinary resolve/reopen stays commenter+. */
export function setResolution(
  slug: string,
  annotationId: string,
  body: SetResolutionBody,
): Promise<EdenResult<SetResolutionResult>> {
  return treaty.api
    .docs({ slug })
    .annotations({ id: annotationId })
    .resolution.patch(body) as Promise<EdenResult<SetResolutionResult>>;
}

// --- Redline: suggestion create + decide (S-002) -------------------------------------------
// A redline is a delete-kind suggestion (C-002). The suggestion routes are WORKSPACE-scoped only —
// there is NO doc-scoped suggestion route (verified backend annotations.ts):
//   POST  /api/w/:workspaceId/docs/:slug/suggestions  → create (commenter+); omit `to` → kind=delete
//   PATCH /api/w/:workspaceId/suggestions/:id          → decide (OWNER-only); { status } | 409 stale
// So the redline create/decide path requires a workspaceId. The slug-only public viewer sources it
// from the doc-read response (`doc.workspaceId`, the same field that feeds the member Share/Version
// panels) — reachable only for a signed-in member viewing a doc that has a workspace. An anon or a
// project-less doc has no workspaceId, so it cannot redline (the markup affordance is already member-
// gated by canCompose). REOPEN of a decided redline rides the doc-scoped resolution route above
// (the backend detects the decided suggestion and gates owner-only there).

/** A delete-kind redline: the `from` span to strike, pinned `againstVersion` (the current doc version
 *  — the backend uses it for the stale check). `to` is omitted so the backend sets kind=delete. */
export interface CreateRedlineBody {
  anchor: CreateAnchor;
  /** the exact text span proposed for deletion (the selected quote). */
  from: string;
  /** the version the `from` span was captured against (the doc read's `version`). */
  againstVersion: number;
}

export interface CreateRedlineResult {
  suggestionId: string;
}

/** POST /api/w/:workspaceId/docs/:slug/suggestions — create a delete-kind redline (S-002 / AS-004).
 *  Omits `to` so the backend records kind=delete. Workspace-scoped (no doc-scoped suggestion route). */
export function createRedline(
  workspaceId: string,
  slug: string,
  body: CreateRedlineBody,
): Promise<EdenResult<CreateRedlineResult>> {
  return treaty.api
    .w({ workspaceId })
    .docs({ slug })
    .suggestions.post(body) as Promise<EdenResult<CreateRedlineResult>>;
}

/** accept → the proposal is accepted; reject → rejected. Either auto-resolves the thread (C-002). */
export interface DecideSuggestionBody {
  decision: "accept" | "reject";
}

export interface DecideSuggestionResult {
  /** the new suggestion status. `stale` (409) when the pinned span drifted on accept (AS-007). */
  status: SuggestionStatus;
}

/** PATCH /api/w/:workspaceId/suggestions/:id — owner accept/reject a redline (S-002 / AS-005/006).
 *  OWNER-only server-side. Returns the decided status; a 409 (stale) carries `details.status:"stale"`
 *  — an accept on a drifted redline does NOT apply it (AS-007). Workspace-scoped. */
export function decideSuggestion(
  workspaceId: string,
  suggestionId: string,
  body: DecideSuggestionBody,
): Promise<EdenResult<DecideSuggestionResult>> {
  return treaty.api
    .w({ workspaceId })
    .suggestions({ id: suggestionId })
    .patch(body) as Promise<EdenResult<DecideSuggestionResult>>;
}

// --- Detached management: dismiss + re-attach (S-004) --------------------------------------
// A detached (`isOrphaned`) annotation can be DISMISSED (it leaves the active list, kept not hard-
// deleted) or RE-ATTACHED to a range the user selects in the current version (clears isOrphaned, sets
// a fresh anchor). Both backend routes are WORKSPACE-scoped on the ANNOTATION id (NOT doc-scoped —
// mirrors decideSuggestion), verified against the S-008 backend (commit 5c584be):
//   POST /api/w/:workspaceId/annotations/:id/dismiss            → { dismissed: true }
//   POST /api/w/:workspaceId/annotations/:id/reattach { anchor } → { isOrphaned: false }
// Both are commenter+ server-side (a viewer is refused 403, annotation-core AS-025), 404 on no-access,
// and reattach is 400 when the new anchor doesn't place against the current version. The slug-only
// public viewer sources the workspaceId from the doc-read response (`doc.workspaceId`, member-only) —
// the SAME field that feeds the redline decide path; an anon / project-less doc has no workspaceId so
// the detached actions aren't offered. The FE affordance is a CLIENT HINT — the backend re-authorizes.

export interface DismissAnnotationResult {
  dismissed: true;
}

export interface ReattachAnnotationResult {
  isOrphaned: false;
}

/** POST /api/w/:workspaceId/annotations/:id/dismiss — dismiss a detached annotation (S-008 backend,
 *  AS-016). It leaves the active list (soft, kept not hard-deleted) → an optimistic remove from the
 *  cached list stays consistent on a refetch (the dismissed row is excluded from the active read). */
export function dismissAnnotation(
  workspaceId: string,
  annotationId: string,
): Promise<EdenResult<DismissAnnotationResult>> {
  return treaty.api
    .w({ workspaceId })
    .annotations({ id: annotationId })
    .dismiss.post() as Promise<EdenResult<DismissAnnotationResult>>;
}

/** POST /api/w/:workspaceId/annotations/:id/reattach — re-attach a detached annotation to a new range
 *  (S-008 backend, AS-017). The body carries the new anchor (the user's selection in the current
 *  version); the server validates it places against the current version (else 400) and clears
 *  isOrphaned. On success the annotation moves out of the detached section and reads as anchored. */
export function reattachAnnotation(
  workspaceId: string,
  annotationId: string,
  anchor: CreateAnchor,
): Promise<EdenResult<ReattachAnnotationResult>> {
  return treaty.api
    .w({ workspaceId })
    .annotations({ id: annotationId })
    .reattach.post({ anchor }) as Promise<EdenResult<ReattachAnnotationResult>>;
}
