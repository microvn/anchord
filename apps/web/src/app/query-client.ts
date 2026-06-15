import { QueryClient, QueryCache } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/api-error";
import { notifySessionExpired } from "@/lib/session-expiry";

// S-002 / C-002: the single QueryClient every screen shares. Its QueryCache-level onError is
// the ONE centralized place that reacts to a failed request's session state: an
// UNAUTHENTICATED response (mid-use expiry, AS-008) fires the session-expired signal, which
// the in-tree SessionExpiryListener turns into a sign-out + /signin redirect. The visible
// retryable error surface (AS-007) is owned by the consuming screen via useApiQuery's
// isError + <ErrorState> — this cache hook only handles the cross-cutting expiry bounce.
//
// Centralizing here (not in each screen) is what makes the behavior consistent: any query,
// anywhere, that comes back unauthenticated routes to sign-in the same way.
export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        // doc-access-routing S-003 / C-004: a doc-centric viewer READ (doc/annotation/version)
        // can NEVER fire the global sign-out bounce. The public `/d/:slug` viewer serves
        // signed-out visitors, and the backend already returns 404-not-401 for no-access — but
        // this is the FE guarantee: any query tagged `meta.viewerRead` is exempt, so even an
        // unexpected unauthenticated reply on a viewer read shows NoAccessView in place instead
        // of stranding an anon at /signin (AS-014).
        if (query.meta?.viewerRead) return;
        if (error instanceof ApiError && error.isUnauthenticated) {
          notifySessionExpired();
        }
      },
    }),
    defaultOptions: {
      queries: {
        // Sensible defaults so feature screens don't each re-tune them.
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // One quick retry for a transient error, then surface <ErrorState> promptly — the
        // user-facing Retry control owns further attempts. A short capped backoff keeps a
        // failing screen from sitting on a spinner for a full second (react-query's default).
        retryDelay: (attempt) => Math.min(150 * 2 ** attempt, 500),
      },
    },
  });
}
