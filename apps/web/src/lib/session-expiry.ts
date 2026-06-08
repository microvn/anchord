// S-002 / AS-008: a single channel between "a request came back UNAUTHENTICATED" (detected
// in the QueryClient's cache-level onError, which lives OUTSIDE the React tree) and "route
// the user back to /signin" (which must happen via React Router, INSIDE the tree).
//
// The QueryCache onError can't call useNavigate, so the centralized detector publishes one
// signal here and a small in-tree listener (SessionExpiryListener) consumes it. Keeping the
// detection in ONE place is the point of C-002: every screen's failure flows through the
// shared QueryClient, so expiry handling is centralized, not per-screen.

type Listener = () => void;

const listeners = new Set<Listener>();

/** Fire once when any request is rejected as unauthenticated. Idempotent per call. */
export function notifySessionExpired(): void {
  for (const listener of listeners) listener();
}

/** Subscribe an in-tree handler; returns an unsubscribe for cleanup. */
export function onSessionExpired(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
