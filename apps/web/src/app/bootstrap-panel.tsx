import { api } from "../lib/api";
import { useApiQuery } from "../lib/use-api-query";
import { ErrorState } from "../components/error-state";
import { EmptyState } from "../components/empty-state";

// S-002 representative consumer. web-core ships NO feature screen (those are the feature
// `-ui` specs), but AS-006/007/008 need ONE authenticated data call to exercise the shared
// layer. This is the minimal stand-in: it reads through `useApiQuery` (the one shared
// client path) and renders the shared <ErrorState>/<EmptyState> primitives. Real screens
// (ProjectBrowser etc.) replace this pattern; we are NOT building ProjectBrowser here.
//
// AS-006: the request carries identity via the session cookie (the Eden client's
// `credentials: "include"`) — the call sends NO userId/identity in the body. We point at a
// real typed route (`/health`) only so the Eden `App` type resolves end-to-end; the three
// scenarios are driven by the mocked client in tests.
export function BootstrapPanel() {
  const query = useApiQuery(["bootstrap"], () => api.health.get());

  if (query.isPending) {
    return (
      <p className="px-4 py-8 text-sm text-muted" data-testid="bootstrap-loading">
        Loading…
      </p>
    );
  }

  if (query.isError) {
    // AS-007: a failed request shows a retryable surface, never a blank/crash. Retry re-runs
    // the same query through the shared client.
    return (
      <ErrorState
        message={query.error?.message}
        onRetry={() => void query.refetch()}
        retrying={query.isRefetching}
      />
    );
  }

  if (query.data == null) {
    return <EmptyState title="Your workspace is ready" description="Nothing to show yet." />;
  }

  return (
    <section className="px-4 py-8" data-testid="bootstrap-ready">
      <h2 className="font-serif text-xl text-ink">Welcome</h2>
      <p className="mt-1 text-sm text-muted">Your workspace is ready.</p>
    </section>
  );
}
