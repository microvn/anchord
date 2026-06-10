import { Link, useParams, useSearchParams } from "react-router-dom";
import { useSearch, useProjects } from "./use-docs";
import { SearchScopeControl } from "./search-scope-control";
import { FormatBadge } from "./doc-bits";
import { Skeleton } from "../../components/skeleton";
import { ErrorState } from "../../components/error-state";
import { NoResultsState } from "../../components/no-results-state";

// `/w/:id/search?q=` — search results (workspace-project S-005), 1:1 with Anchord-Design's
// SearchResults (browser.jsx). A search head (Fraunces "Results for …" + the "searched
// titles, content, and comments across docs you can access" sub) · a result-list of rows
// (format glyph · title · "in {matchSource}" tag · project crumb). Wired to GET …/search?q=
// (access-filtered, existence-hiding — C-003). No-results uses NoResultsState (distinct from
// the empty data state — C-007). The backend returns no snippet, so rows show the matchSource.

export function SearchScreen() {
  const { workspaceId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  // Scope lives in the `projectId` query param (S-004): present → scoped to that project,
  // absent → whole-workspace. Arriving from a project context (a `projectId` in the URL)
  // defaults the scope to that project; otherwise it defaults to whole-workspace (AS-010/AS-011).
  const scope = params.get("projectId") ?? undefined;
  const query = useSearch(workspaceId, q, scope);
  const results = query.data ?? [];
  const { data: projects } = useProjects(workspaceId);

  function setScope(projectId: string | undefined) {
    const next = new URLSearchParams(params);
    if (projectId) next.set("projectId", projectId);
    else next.delete("projectId");
    setParams(next);
  }

  return (
    <section className="mx-auto max-w-[1100px] px-6 py-8" data-testid="search-screen">
      <div className="mb-[18px]">
        <h1 className="font-serif text-[30px] font-medium tracking-[-0.02em] text-ink">
          Results for <em className="not-italic text-accent-ink">“{q}”</em>
        </h1>
        <p className="mt-1 text-[13px] text-muted">
          Searched titles, content, and comments across docs you can access.
        </p>
        <div className="mt-3">
          <SearchScopeControl projects={projects ?? []} value={scope} onChange={setScope} />
        </div>
      </div>

      {!q.trim() ? (
        <p className="text-[13px] text-muted" data-testid="search-empty-query">
          Type a query in the header search to find docs.
        </p>
      ) : query.isPending ? (
        <Skeleton rows={4} />
      ) : query.isError ? (
        <ErrorState message={query.error?.message} onRetry={() => void query.refetch()} />
      ) : results.length === 0 ? (
        <NoResultsState
          query={q}
          onClear={() => setParams({})}
          description="Try a different term, or clear the search."
        />
      ) : (
        <>
          <div className="mb-[10px] text-[13px] tabular-nums text-subtle" data-testid="search-count">
            {results.length} {results.length === 1 ? "result" : "results"}
          </div>
          <div
            data-testid="result-list"
            className="overflow-hidden rounded-[11px] border border-line bg-surface"
          >
            {results.map((r) => (
              <Link
                key={r.docId}
                to={`/d/${r.slug}`}
                data-testid={`result-row-${r.slug}`}
                className="flex gap-[13px] border-b border-line px-4 py-[14px] text-inherit no-underline last:border-b-0 hover:bg-elev"
              >
                <FormatBadge kind={r.kind} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-[9px]">
                    <span className="truncate text-[13.5px] font-semibold text-ink">{r.title}</span>
                    <span className="rounded border border-line bg-elev px-[5px] py-px font-mono text-[9.5px] uppercase tracking-[0.06em] text-muted">
                      in {r.matchSource}
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
