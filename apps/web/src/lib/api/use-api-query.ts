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
  // `refetchOnWindowFocus` opts a SINGLE query into focus-refetch — the global QueryClient default
  // is `false` (query-client.ts), so a screen passes `true` only where stale-on-return matters (the
  // viewer: an out-of-band MCP/agent patch bumps the doc version server-side with no push channel,
  // so refetching when the reviewer tabs back is the lightest way to surface it — still gated by the
  // 30s staleTime, so it never refetches more than once per 30s of focus churn).
  // `refetchInterval` opts a SINGLE query into background polling (notifications-email S-006: the
  // unread-count badge polls on a quiet cadence — there is no push channel for async review). The
  // global default is off, so a query polls only when it asks to.
  options?: {
    enabled?: boolean;
    meta?: Record<string, unknown>;
    refetchOnWindowFocus?: boolean;
    refetchInterval?: number;
    // Override the global 30s staleTime for a SINGLE query. `staleTime: 0` makes the data stale
    // immediately, so a query that toggles `enabled` (e.g. a modal's prefill read gated on `open`)
    // REFETCHES every time it re-enables — the modal always shows current server state on reopen,
    // never a 30s-cached snapshot from a previous open.
    staleTime?: number;
  },
): UseQueryResult<T, ApiError> {
  return useQuery<T, ApiError>({
    queryKey,
    enabled: options?.enabled,
    refetchOnWindowFocus: options?.refetchOnWindowFocus,
    refetchInterval: options?.refetchInterval,
    staleTime: options?.staleTime,
    // doc-access-routing S-003 / C-004: a query may carry `meta.viewerRead` so the shared
    // QueryCache onError (query-client.ts) can EXEMPT it from the global session-expiry bounce.
    // A doc-centric viewer read must never sign the user out / redirect to /signin (AS-014).
    meta: options?.meta,
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
