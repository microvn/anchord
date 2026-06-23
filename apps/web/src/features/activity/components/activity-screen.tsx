import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { NoResultsState } from "@/components/no-results-state";
import { Pagination } from "@/components/pagination";
import { ActivityFeed } from "@/features/activity/components/activity-feed";
import { ActivityFilterSegment } from "@/features/activity/components/activity-filter-segment";
import { useActivity } from "@/features/activity/hooks/use-activity";
import type { ActivityCategory } from "@/features/activity/types";

// `/w/:id/activity` — the workspace activity feed screen (workspace-activity S-001 + S-003).
//
// THE WRAPPER (export contract / ## Linked Fields): this does the WORKSPACE-SCOPED fetch
// (useActivity) and passes the resulting rows/loading/error down to the presentational
// <ActivityFeed/> — which is rows-as-props so the personal "Your actions" feed (2b) reuses it with
// a different fetch. The screen owns page state (server-side paging, one server page = one feed
// page); day-grouping happens inside ActivityFeed in the viewer's timezone (C-007).
//
// S-003: the screen also owns the active category. <ActivityFilterSegment/> renders All / Comments /
// Versions / Sharing / People with the server's per-category counts (over the viewer's visible set,
// AS-012); selecting one re-fetches the feed narrowed to that category (AS-011). When a NON-"all"
// filter returns zero rows, the <NoResultsState/> with a Clear control is shown — Clear returns to
// All (AS-013).

export function ActivityScreen() {
  const { workspaceId = "" } = useParams<{ workspaceId: string }>();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [category, setCategory] = useState<ActivityCategory>("all");
  const query = useActivity(workspaceId, page, category);

  const rows = query.data?.items ?? [];
  const counts = query.data?.counts;
  const totalPages = query.data?.pagination?.totalPages ?? 0;

  // Switching the filter resets to page 1 so a deep page from one category never strands the next.
  function changeCategory(next: ActivityCategory) {
    setCategory(next);
    setPage(1);
  }

  // AS-013: a NON-"all" filter that matched nothing visible shows the no-results state (distinct from
  // the empty-feed state, which ActivityFeed renders for "all" with zero rows).
  const showNoResults = !query.isLoading && !query.isError && category !== "all" && rows.length === 0;

  return (
    <section className="mx-auto max-w-[1100px] px-6 py-8" data-testid="activity-screen">
      <div className="mb-[22px]">
        <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.12em] text-subtle">
          Workspace
        </div>
        <h1 className="font-serif text-[30px] font-medium leading-[1.05] tracking-[-0.02em] text-ink">
          Activity
        </h1>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <ActivityFilterSegment active={category} counts={counts} onChange={changeCategory} />
      </div>

      {showNoResults ? (
        <div className="rounded-[11px] border border-line bg-surface">
          <NoResultsState
            query={category}
            onClear={() => changeCategory("all")}
            description="No activity in this category yet. Clear the filter to see everything."
          />
        </div>
      ) : (
        <ActivityFeed
          rows={rows}
          loading={query.isLoading}
          error={query.isError ? (query.error?.message ?? null) : null}
          onRetry={() => void query.refetch()}
          onOpen={(event) => navigate(`/w/${workspaceId}/activity/${event.id}`)}
        />
      )}

      {!query.isLoading && !query.isError && !showNoResults && (
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
      )}
    </section>
  );
}
