import { useApiQuery, peelEnvelope, type EdenResult } from "../../lib/use-api-query";
import { queryKeys } from "./query-keys";
import { fetchBootstrap, fetchMembers } from "./client";
import type { Bootstrap, MembersDirectory } from "./types";

// `useApiQuery` already peels the success-envelope for every read it runs (see peelEnvelope), so a
// read-thunk just returns treaty's raw result. `unwrapEnvelope` is the IMPERATIVE counterpart — for
// mutations / one-shot calls that DON'T go through useApiQuery (publish, invite-accept, rename,
// move/copy, …) and still need the payload at `.data` peeled off the envelope. Same peel rule,
// shared via peelEnvelope, so the two never drift.
export function unwrapEnvelope<T>(result: EdenResult<unknown>): EdenResult<T> {
  if (result.error) return { data: null, error: result.error };
  return { data: (peelEnvelope(result.data) ?? null) as T | null, error: null };
}

/**
 * S-001 (AS-001/AS-006): the bootstrap read — who I am + every workspace I belong to + the
 * active one. Workspace-AGNOSTIC, so it uses the un-scoped `bootstrap` key (GAP-001). Every
 * screen reads the switcher list from here; switching workspace does NOT refetch it.
 */
export function useBootstrap() {
  return useApiQuery<Bootstrap>(queryKeys.bootstrap(), () => fetchBootstrap());
}

/**
 * S-003 (AS-007): the member directory + pending invites for a workspace. Keyed by
 * `workspaceId` (GAP-001) so switching workspace reads a disjoint cache slice — no other
 * workspace's members ever flash in. Admin-only on the backend (a non-admin's request 403s).
 */
export function useMembers(workspaceId: string) {
  return useApiQuery<MembersDirectory>(queryKeys.members(workspaceId), () =>
    fetchMembers(workspaceId),
  );
}
