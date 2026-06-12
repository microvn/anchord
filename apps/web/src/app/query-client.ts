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
      onError: (error) => {
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
