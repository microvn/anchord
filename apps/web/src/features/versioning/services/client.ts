import { api } from "@/lib/api";
import type { EdenResult } from "@/lib/api/use-api-query";

// Typed request thunks for the versioning-diff backend (the producer is already built — workspace-
// scoped routes in apps/backend/src/routes/versions.ts; the backend spec's `## API` table showing
// un-scoped `/api/docs/:slug/…` is STALE, GAP-003). This story (S-001) adds only the HISTORY READ —
// `getVersionHistory` → GET /api/w/:ws/docs/:slug/versions. Restore (S-002) + diff (S-003/S-004) land
// in later stories on this same module.
//
// Same rationale as features/viewer/services/client.ts + features/sharing/services/client.ts: the
// backend mounts these routes CONDITIONALLY, so the exported `App` treaty type can't statically
// widen to include them. We reach them via the SAME runtime treaty client (`treaty as any`) and
// annotate the return ourselves. Component tests MOCK this module, so the cast is never exercised
// under test.
//
// Eden runtime path convention: static segments are property access, a `:param` segment is a
// function call carrying that param, and the verb (get) is the leaf call.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const treaty = api as any;

// These thunks return the RAW Eden `{ data, error }` (the body is the api-core paginated envelope
// `{ success, data: { items, pagination }, … }`). The call site reads it through `useApiQuery`,
// which peels the success envelope once (peelEnvelope) — so the hook receives the flat
// `{ items, pagination }` payload directly, the same convention the viewer's listAnnotations uses.

/** The publisher of a version. The backend enriches this server-side (decided 2026-06-14, now
 *  SHIPPED): `name` is resolved from the user record, falling back to "Unknown" when unknown; `id`
 *  may be null for a system/unknown publisher. The timeline shows `name` (+ initials avatar). */
export interface VersionPublisher {
  id: string | null;
  name: string;
}

/** One row of the version history timeline (backend versioning-diff:S-002). Newest-first. */
export interface VersionHistoryItem {
  /** the version number (1-based, monotonically increasing on every publish). */
  version: number;
  /** ISO timestamp of when this version was published. */
  createdAt: string;
  /** who published it (server-enriched name, GAP-001 SHIPPED). */
  publishedBy: VersionPublisher;
  /** true for the single highest/current version (C-002) — marked "Current", offers no Restore. */
  isCurrent: boolean;
}

/** The api-core paginated shape the history read returns once the success envelope is peeled. */
export interface VersionHistoryResponse {
  items: VersionHistoryItem[];
  pagination?: {
    page?: number;
    pageSize?: number;
    total?: number;
    [key: string]: unknown;
  };
}

/** GET /api/docs/:slug/versions — the DOC-ADDRESSED version history read (doc-access-routing
 *  S-005 / AS-024). The slug is globally unique, so the doc link alone addresses the history
 *  (C-007) — no workspace segment; the read is anon-capable (the viewer may be signed out on an
 *  anyone_with_link doc). Paginated, newest-first; v0 shows a single scrolling list (no load-more,
 *  GAP-005). RESTORE (a write) stays workspace-scoped below — only the READS are doc-scoped. */
export function getVersionHistory(slug: string): Promise<EdenResult<VersionHistoryResponse>> {
  return treaty.api.docs({ slug }).versions.get() as Promise<EdenResult<VersionHistoryResponse>>;
}

/** What a successful restore returns (201): the NEW current version number (the append-copy) and the
 *  version it copied from. Restore is ALWAYS append-copy — it never overwrites or deletes (C-001 /
 *  backend C-004). */
export interface RestoreResult {
  version: number;
  previousVersion: number;
}

/** POST /api/w/:workspaceId/docs/:slug/versions/:n/restore — append-copy version `n`'s content as a
 *  NEW current version (S-002 AS-005; backend versioning-diff:S-003). On 201 the older versions all
 *  stay; the call site refetches the history so the new current shows. A refused write (403/404/
 *  network) adds no version (AS-006). Same `treaty as any` reach + raw `{data,error}` return as the
 *  history read — the call site unwraps the api-core envelope. Eden runtime path: static segments are
 *  property access, the `:n` param is a function call, and the verb (post) is the leaf. */
export function restoreVersion(
  workspaceId: string,
  slug: string,
  n: number,
): Promise<EdenResult<RestoreResult>> {
  return treaty.api
    .w({ workspaceId })
    .docs({ slug })
    .versions({ n })
    .restore.post() as Promise<EdenResult<RestoreResult>>;
}

/** One line of the source line-diff (backend versioning-diff:S-004). `added`/`removed` lines carry
 *  the diff styling (added teal, removed red+strikethrough — C-004); `context` lines are unchanged. */
export interface DiffLine {
  type: "added" | "removed" | "context";
  text: string;
}

/** What GET …/diff returns once the success envelope is peeled. `mode:"text"` carries the line-diff
 *  + change count; `mode:"image"` carries only the renderPair (no line-diff — S-004 owns that branch).
 *  `renderPair` is `[urlA, urlB]` where EACH url is a per-version content reference (`/v/<versionId>`)
 *  the existing `/v/:id` route serves — fed straight to the Rendered tab's two iframes (AS-008). */
export interface DiffResponse {
  mode: "text" | "image";
  /** true when the two versions are byte-identical — S-004 owns the "No differences" branch. */
  identical?: boolean;
  /** the +adds/−removed change count shown in the header (AS-007 / C-004). */
  changeCount?: number;
  /** the source line-diff rows (text mode only). */
  lines?: DiffLine[];
  /** per-version content refs for the Rendered tab's before|after iframes. */
  renderPair: [string, string];
}

/** GET /api/docs/:slug/diff?from=&to= — the DOC-ADDRESSED two-level diff read (doc-access-routing
 *  S-005 / AS-024). Like the history read it carries only the slug (C-007) and is anon-capable; the
 *  backend parses `from`/`to` off the query string, so they ride the leaf `.get({ query })` per the
 *  Eden convention. Same `treaty as any` reach + raw `{data,error}` return as the other thunks — the
 *  call site unwraps the api-core envelope. A refused read (bad version refs / not found) surfaces as
 *  `{error}` → the overlay shows an explicit error state, never a blank/half diff (AS-011 / C-007). */
export function getDiff(slug: string, from: number, to: number): Promise<EdenResult<DiffResponse>> {
  return treaty.api.docs({ slug }).diff.get({ query: { from, to } }) as Promise<
    EdenResult<DiffResponse>
  >;
}
