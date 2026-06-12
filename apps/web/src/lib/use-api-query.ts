import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { toApiError, type ApiError } from "./api-error";

// S-002 / C-002: the ONE shared data-fetching entry point. EVERY screen's read goes through
// `useApiQuery` instead of calling treaty + useQuery ad hoc, so the failure surface and the
// session-expiry bounce are centralized (not re-implemented per screen).
//
// The `call` is a thunk that performs a treaty request and resolves to treaty's
// `{ data, error }` shape. AS-006: identity rides the session cookie (the Eden client is
// built with `credentials: "include"`), so callers pass NO userId/identity in the body —
// this hook neither adds nor expects one. On any error we throw a normalized `ApiError`,
// which (a) makes react-query mark the query `isError` so the screen renders <ErrorState>,
// and (b) reaches the QueryClient's cache-level onError, which bounces an UNAUTHENTICATED
// response to /signin (AS-007, AS-008).

export type EdenResult<T> = { data: T | null; error: unknown };

// Anchord's /api/* routes return the unified SuccessEnvelope { success, data, timestamp, … }
// (apps/backend/src/http/envelope.ts), so treaty's `data` slot holds the ENVELOPE and the real
// payload sits one level down at `.data`. `peelEnvelope` strips that one layer so screens read the
// payload directly — done HERE, once, instead of every read-thunk remembering to call unwrapEnvelope
// (the bug class that left the viewer blank). Detection is marker-based: peel ONLY a body that
// carries both `success` and `data` (the envelope's fingerprint). A composed payload that is a plain
// array or `{ projects }` / `{ items }` object has no `success` key, so it passes through untouched —
// which is why use-docs' multi-call thunks, already unwrapping internally, are not double-peeled.
export function peelEnvelope(body: unknown): unknown {
  if (body && typeof body === "object" && "success" in body && "data" in body) {
    return (body as { data: unknown }).data;
  }
  return body;
}

export function useApiQuery<T>(
  queryKey: readonly unknown[],
  call: () => Promise<EdenResult<T>>,
  options?: { enabled?: boolean },
): UseQueryResult<T, ApiError> {
  return useQuery<T, ApiError>({
    queryKey,
    enabled: options?.enabled,
    queryFn: async () => {
      // A transport failure (backend unreachable) rejects here; toApiError normalizes it.
      let result: EdenResult<T>;
      try {
        result = await call();
      } catch (thrown) {
        throw toApiError(thrown);
      }
      if (result.error) {
        throw toApiError(result.error);
      }
      // A 2xx with a null body is still a successful empty response. Peel the success-envelope
      // (no-op on an already-flat payload) so callers never see `query.data.data`.
      return peelEnvelope(result.data) as T;
    },
    // Don't auto-retry an unauthenticated response — it can't succeed without a new session,
    // and the cache onError is already routing the user to sign-in. Other errors get ONE
    // retry; the user-facing Retry control (ErrorState) covers the rest.
    retry: (failureCount, error) => {
      if (error?.isUnauthenticated) return false;
      return failureCount < 1;
    },
  });
}
