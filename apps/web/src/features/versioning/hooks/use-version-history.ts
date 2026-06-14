import { useApiQuery } from "@/lib/api/use-api-query";
import {
  getVersionHistory,
  type VersionHistoryResponse,
} from "@/features/versioning/services/client";

// S-001 (AS-001 / AS-004): read the version history for an open doc through the ONE shared
// data-fetching entry point (useApiQuery), so the failure surface + session-expiry bounce stay
// centralized like every other read. `enabled` gates the fetch on the panel being open — the
// history isn't loaded until the reader actually opens the panel. A failed read sets `isError`
// (AS-004: an explicit error state, never a misleading empty list).
export function useVersionHistory(
  workspaceId: string,
  slug: string,
  enabled: boolean,
) {
  return useApiQuery<VersionHistoryResponse>(
    ["version-history", workspaceId, slug],
    () => getVersionHistory(workspaceId, slug),
    { enabled },
  );
}
