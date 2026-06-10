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
