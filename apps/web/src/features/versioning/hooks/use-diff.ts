import { useApiQuery } from "@/lib/api/use-api-query";
import { getDiff, type DiffResponse } from "@/features/versioning/services/client";

// S-003 (AS-007/008/009/011): read the two-level diff between two picked versions through the ONE
// shared data-fetching entry point (useApiQuery), so the failure surface stays centralized like
// every other read. The query key carries BOTH `from` and `to`, so changing either picker swaps the
// key and re-fetches the diff (AS-009). `enabled` gates the fetch on the overlay being open and on a
// real from/to pair. A failed/refused read sets `isError` (AS-011 / C-007: an explicit error state,
// never a blank/half diff).
// doc-access-routing S-005 / AS-024: the diff read is DOC-ADDRESSED (slug-only) and anon-capable,
// so the hook keys off slug + from + to — no workspaceId. Changing either picker swaps the key and
// re-fetches (AS-009).
export function useDiff(slug: string, from: number, to: number, enabled: boolean) {
  return useApiQuery<DiffResponse>(
    ["version-diff", slug, from, to],
    () => getDiff(slug, from, to),
    { enabled: enabled && from > 0 && to > 0 },
  );
}
