import { api } from "@/lib/api";
import type { EdenResult } from "@/lib/api/use-api-query";

// Typed request thunk for the workspace activity feed (workspace-activity S-001).
//
// Same rationale as features/docs/services/client.ts: the backend mounts this route
// CONDITIONALLY, so the exported `App` treaty type can't statically widen to include it. We reach
// it through the SAME runtime treaty client (dynamic path resolution) and annotate the return.
// Component tests MOCK this module, so the cast is never exercised under test.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const treaty = api as any;

/**
 * GET /api/w/:workspaceId/activity?page=&limit=&category= — the recent-first, paginated workspace
 * event feed (default 20 / cap 50, C-007). Returns `{ items, pagination, counts, category }` under
 * the envelope's `data`. `category` (S-003) narrows the feed to one segment; the per-category
 * `counts` are over the viewer's full visible set so every segment label shows its own count.
 */
export function fetchActivity(
  workspaceId: string,
  page?: number,
  limit?: number,
  category?: string,
): Promise<EdenResult<unknown>> {
  const q: Record<string, string> = {};
  if (page != null) q.page = String(page);
  if (limit != null) q.limit = String(limit);
  // "all" is the default — omit it so the URL stays clean and the server's fallback applies.
  if (category != null && category !== "all") q.category = category;
  const query = Object.keys(q).length ? { query: q } : undefined;
  return treaty.api.w({ workspaceId }).activity.get(query) as Promise<EdenResult<unknown>>;
}
