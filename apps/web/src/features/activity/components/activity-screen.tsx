import { useState } from "react";
import { useParams } from "react-router-dom";
import { Pagination } from "@/components/pagination";
import { ActivityFeed } from "@/features/activity/components/activity-feed";
import { useActivity } from "@/features/activity/hooks/use-activity";

// `/w/:id/activity` — the workspace activity feed screen (workspace-activity S-001).
//
// THE WRAPPER (export contract / ## Linked Fields): this does the WORKSPACE-SCOPED fetch
// (useActivity) and passes the resulting rows/loading/error down to the presentational
// <ActivityFeed/> — which is rows-as-props so the personal "Your actions" feed (2b) reuses it with
// a different fetch. The screen owns page state (server-side paging, one server page = one feed
// page); day-grouping happens inside ActivityFeed in the viewer's timezone (C-007).

export function ActivityScreen() {
  const { workspaceId = "" } = useParams<{ workspaceId: string }>();
  const [page, setPage] = useState(1);
  const query = useActivity(workspaceId, page);

  const rows = query.data?.items ?? [];
  const totalPages = query.data?.pagination?.totalPages ?? 0;

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

      <ActivityFeed
        rows={rows}
        loading={query.isLoading}
        error={query.isError ? (query.error?.message ?? null) : null}
        onRetry={() => void query.refetch()}
      />

      {!query.isLoading && !query.isError && (
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
      )}
    </section>
  );
}
