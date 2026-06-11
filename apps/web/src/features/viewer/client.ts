import { api } from "../../lib/api";
import type { EdenResult } from "../../lib/use-api-query";

// Typed request thunk for the in-app viewer's doc read (render-publish S-005):
//   GET /api/w/:workspaceId/docs/:slug
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
  };
  /** markdown → sanitized HTML string; html/image → a { contentUrl } sandbox reference. */
  content: string | { contentUrl: string };
}

/** GET /api/w/:workspaceId/docs/:slug — the access-gated doc read for the in-app viewer. */
export function fetchViewerDoc(
  workspaceId: string,
  slug: string,
): Promise<EdenResult<ViewerDocResponse>> {
  return treaty.api.w({ workspaceId }).docs({ slug }).get() as Promise<
    EdenResult<ViewerDocResponse>
  >;
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

export interface ViewerAnnotation {
  id: string;
  type: string;
  anchor: AnnotationAnchor;
  status: "unresolved" | "resolved";
  isOrphaned: boolean;
  comments: AnnotationComment[];
}

export interface ListAnnotationsResponse {
  items: ViewerAnnotation[];
  pagination?: { page: number; limit: number; total: number };
}

/** GET …/docs/:slug/annotations — read the doc's annotations for the viewer (S-003). */
export function listAnnotations(
  workspaceId: string,
  slug: string,
): Promise<EdenResult<ListAnnotationsResponse>> {
  return treaty.api
    .w({ workspaceId })
    .docs({ slug })
    .annotations.get() as Promise<EdenResult<ListAnnotationsResponse>>;
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

export interface CreateAnnotationBody {
  type: string;
  anchor: CreateAnchor;
}

export interface CreateAnnotationResult {
  annotationId: string;
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

/** POST …/docs/:slug/annotations — create a block-anchored annotation (S-001). */
export function createAnnotation(
  workspaceId: string,
  slug: string,
  body: CreateAnnotationBody,
): Promise<EdenResult<CreateAnnotationResult>> {
  return treaty.api
    .w({ workspaceId })
    .docs({ slug })
    .annotations.post(body) as Promise<EdenResult<CreateAnnotationResult>>;
}

/** POST …/docs/:slug/annotations/:id/comments — attach a comment to an annotation (S-001). */
export function addComment(
  workspaceId: string,
  slug: string,
  annotationId: string,
  body: AddCommentBody,
): Promise<EdenResult<AddCommentResult>> {
  return treaty.api
    .w({ workspaceId })
    .docs({ slug })
    .annotations({ annotationId })
    .comments.post(body) as Promise<EdenResult<AddCommentResult>>;
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

/** PATCH …/annotations/:id/resolution — toggle an annotation's resolved status (S-004). */
export function setResolution(
  workspaceId: string,
  annotationId: string,
  body: SetResolutionBody,
): Promise<EdenResult<SetResolutionResult>> {
  return treaty.api
    .w({ workspaceId })
    .annotations({ id: annotationId })
    .resolution.patch(body) as Promise<EdenResult<SetResolutionResult>>;
}
