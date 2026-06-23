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
 * GET /api/w/:workspaceId/activity?page=&limit= — the recent-first, paginated workspace event feed
 * (default 20 / cap 50, C-007). Returns `{ items, pagination }` under the envelope's `data`.
 */
export function fetchActivity(
  workspaceId: string,
  page?: number,
  limit?: number,
): Promise<EdenResult<unknown>> {
  const q: Record<string, string> = {};
  if (page != null) q.page = String(page);
  if (limit != null) q.limit = String(limit);
  const query = Object.keys(q).length ? { query: q } : undefined;
  return treaty.api.w({ workspaceId }).activity.get(query) as Promise<EdenResult<unknown>>;
}
