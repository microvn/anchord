import { EmptyState } from "@/components/empty-state";

// `/w/:id/activity` — there is NO activity/notifications endpoint mounted on the backend
// (the bootstrap + the route files expose none), so this is an honest, clean empty state
// rather than faked rows. It gets the real feed when a notifications/activity slice ships.
export function ActivityScreen() {
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
      <div className="rounded-[11px] border border-line bg-surface">
        <EmptyState
          title="No activity yet"
          description="Comments, publishes and version changes across the workspace will appear here."
        />
      </div>
    </section>
  );
}
