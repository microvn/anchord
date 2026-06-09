import { useApiQuery, type EdenResult } from "../../lib/use-api-query";
import { queryKeys } from "./query-keys";
import { fetchBootstrap, fetchMembers } from "./client";
import type { Bootstrap, MembersDirectory } from "./types";

// Anchord's own /api/* routes return the unified SuccessEnvelope { success, data, … }
// (apps/backend/src/http/envelope.ts), so treaty's `data` slot holds the ENVELOPE, and the
// real payload is one level down at `.data`. `unwrapEnvelope` peels that one layer so screens
// read the payload directly; useApiQuery still owns the error normalization + expiry bounce.
export function unwrapEnvelope<T>(result: EdenResult<unknown>): EdenResult<T> {
  if (result.error) return { data: null, error: result.error };
  const body = result.data as { data?: unknown } | null;
  // An enveloped success carries the payload at `.data`; tolerate a raw body defensively.
  const payload = body && typeof body === "object" && "data" in body ? body.data : body;
  return { data: (payload ?? null) as T | null, error: null };
}

/**
 * S-001 (AS-001/AS-006): the bootstrap read — who I am + every workspace I belong to + the
 * active one. Workspace-AGNOSTIC, so it uses the un-scoped `bootstrap` key (GAP-001). Every
 * screen reads the switcher list from here; switching workspace does NOT refetch it.
 */
export function useBootstrap() {
  return useApiQuery<Bootstrap>(queryKeys.bootstrap(), async () =>
    unwrapEnvelope<Bootstrap>(await fetchBootstrap()),
  );
}

/**
 * S-003 (AS-007): the member directory + pending invites for a workspace. Keyed by
 * `workspaceId` (GAP-001) so switching workspace reads a disjoint cache slice — no other
 * workspace's members ever flash in. Admin-only on the backend (a non-admin's request 403s).
 */
export function useMembers(workspaceId: string) {
  return useApiQuery<MembersDirectory>(queryKeys.members(workspaceId), async () =>
    unwrapEnvelope<MembersDirectory>(await fetchMembers(workspaceId)),
  );
}
