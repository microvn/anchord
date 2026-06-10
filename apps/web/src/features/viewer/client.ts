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

export interface ViewerDocResponse {
  doc: {
    title: string;
    kind: ViewerDocKind;
    version: number;
    status: string;
    generalAccess: string;
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
