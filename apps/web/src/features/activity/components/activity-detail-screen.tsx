import { useParams } from "react-router-dom";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { Skeleton } from "@/components/skeleton";
import { ActivityDetailPage } from "@/features/activity/components/activity-detail-page";
import { useActivityEvent, useActivityRelated } from "@/features/activity/hooks/use-activity-detail";

// `/w/:id/activity/:eventId` — the activity event detail screen (workspace-activity S-004).
//
// THE WRAPPER (export contract / ## Linked Fields): does the workspace-scoped reads (the single
// event + "More on this doc" related) and passes them to the presentational <ActivityDetailPage/>,
// which is rows-as-props so 2b reuses it. A hidden/nonexistent event 404s (existence-hiding) → a
// "not found" empty state, NOT a forbidden error (AS-010). A transport error shows the retryable
// ErrorState.

export function ActivityDetailScreen() {
  const { workspaceId = "", eventId = "" } = useParams<{ workspaceId: string; eventId: string }>();
  const eventQuery = useActivityEvent(workspaceId, eventId);
  // Only fetch related once the event resolved (avoids a parallel 404 while the event is loading).
  const relatedQuery = useActivityRelated(workspaceId, eventId, eventQuery.isSuccess);

  const backHref = `/w/${workspaceId}/activity`;

  if (eventQuery.isLoading) {
    return (
      <section className="mx-auto max-w-[1100px] px-6 py-8">
        <div className="rounded-[11px] border border-line bg-surface px-2 py-2">
          <Skeleton rows={6} />
        </div>
      </section>
    );
  }

  if (eventQuery.isError) {
    const notFound = eventQuery.error?.status === 404 || eventQuery.error?.code === "NOT_FOUND";
    // AS-010: a hidden / nonexistent event is existence-hidden — render a plain not-found state, never
    // a "forbidden" that would reveal the event exists.
    if (notFound) {
      return (
        <section className="mx-auto max-w-[1100px] px-6 py-8">
          <div className="rounded-[11px] border border-line bg-surface">
            <EmptyState
              title="Event not found"
              description="This activity event doesn't exist or is no longer visible to you."
            />
          </div>
        </section>
      );
    }
    return (
      <section className="mx-auto max-w-[1100px] px-6 py-8">
        <div className="rounded-[11px] border border-line bg-surface">
          <ErrorState message={eventQuery.error?.message ?? null} onRetry={() => void eventQuery.refetch()} />
        </div>
      </section>
    );
  }

  if (!eventQuery.data) return null; // settled non-error reads always have data; this narrows the type

  return (
    <ActivityDetailPage
      event={eventQuery.data}
      related={relatedQuery.data ?? []}
      backHref={backHref}
    />
  );
}
