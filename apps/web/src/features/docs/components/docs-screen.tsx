import { useState } from "react";
import { useActiveWorkspace } from "@/features/workspaces/components/active-workspace";
import { useWorkspaceDocs } from "@/features/docs/hooks/use-docs";
import { DocCard } from "./doc-card";
import { DocList } from "./doc-list";
import { NewDocButton } from "./new-doc-dialog";
import { Icon } from "@/components/icon";
import { Skeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { NoResultsState } from "@/components/no-results-state";
import type { DocRow } from "@/features/docs/types";

// `/w/:id/docs` — the All-docs browser, 1:1 with Anchord-Design's ProjectBrowser
// (browser.jsx). page-head (Workspace eyebrow + Fraunces title + New-doc) · a browse-bar
// (filter chips + result count + grid/list toggle) · a DocGrid of DocCards or a DocList.
// Wired to the REAL data: useWorkspaceDocs = the union of access-filtered docs across the
// workspace's projects (no workspace-wide list endpoint exists). 3→2→1 cols via the grid
// utilities. Loading=Skeleton, error=ErrorState (retry), empty=EmptyState, a filter that
// matches nothing=NoResultsState (distinct from empty — C-007).

type Filter = "all" | "shared" | "detached";
type View = "grid" | "list";

export function DocsScreen() {
  const { workspace } = useActiveWorkspace();
  const query = useWorkspaceDocs(workspace.id);
  const [filter, setFilter] = useState<Filter>("all");
  const [view, setView] = useState<View>("grid");

  const allDocs = query.data?.docs ?? [];
  const projects = query.data?.projects ?? [];

  // Shared / Has-detached depend on per-doc access + detached-anchor counts that no mounted
  // endpoint returns yet, so those filters resolve to 0 today (NoResultsState). The chips are
  // rendered 1:1 with the design; "All" is the live filter.
  const filtered = applyFilter(allDocs, filter);

  const filters: { id: Filter; label: string; n: number }[] = [
    { id: "all", label: "All", n: allDocs.length },
    { id: "shared", label: "Shared", n: 0 },
    { id: "detached", label: "Has detached", n: 0 },
  ];

  return (
    <section className="mx-auto max-w-[1100px] px-6 py-8" data-testid="docs-screen">
      <div className="mb-[22px] flex items-end gap-4">
        <div>
          <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.12em] text-subtle">
            Workspace
          </div>
          <h1 className="font-serif text-[30px] font-medium leading-[1.05] tracking-[-0.02em] text-ink">
            All docs
          </h1>
        </div>
        <div className="ml-auto flex flex-none items-center gap-2">
          <NewDocButton />
        </div>
      </div>

      {query.isPending ? (
        <Skeleton rows={5} />
      ) : query.isError ? (
        <ErrorState message={query.error?.message} onRetry={() => void query.refetch()} />
      ) : allDocs.length === 0 ? (
        <EmptyState
          title="No docs yet"
          description="Docs arrive when you publish from the CLI or MCP. Start one here to get going."
          action={<NewDocButton />}
        />
      ) : (
        <>
          <div className="mb-[18px] flex flex-wrap items-center gap-3">
            <div
              className="flex gap-0.5 rounded-md border border-line bg-sunken p-0.5"
              data-testid="docs-filters"
            >
              {filters.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  data-testid={`filter-${f.id}`}
                  onClick={() => setFilter(f.id)}
                  className={`inline-flex h-7 items-center gap-1.5 rounded-sm px-[11px] text-[13px] font-medium transition-colors ${
                    filter === f.id
                      ? "bg-surface text-accent-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
                      : "text-muted hover:text-ink"
                  }`}
                >
                  {f.label}
                  <span
                    className={`font-mono text-[10px] ${filter === f.id ? "text-accent" : "text-subtle"}`}
                  >
                    {f.n}
                  </span>
                </button>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-[10px]">
              <span
                className="text-[13px] tabular-nums text-subtle"
                data-testid="docs-result-count"
              >
                {filtered.length} {filtered.length === 1 ? "doc" : "docs"}
              </span>
              <div className="flex gap-0.5 rounded-md border border-line bg-sunken p-0.5">
                <ViewButton active={view === "grid"} onClick={() => setView("grid")} icon="grid" label="Grid view" testid="view-grid" />
                <ViewButton active={view === "list"} onClick={() => setView("list")} icon="list" label="List view" testid="view-list" />
              </div>
            </div>
          </div>

          {filtered.length === 0 ? (
            <NoResultsState query={labelFor(filter)} onClear={() => setFilter("all")} />
          ) : view === "grid" ? (
            <div
              data-testid="doc-grid"
              className="grid grid-cols-1 gap-[14px] sm:grid-cols-2 lg:grid-cols-3"
            >
              {filtered.map((d) => (
                <DocCard key={d.id} doc={d} workspaceId={workspace.id} projects={projects} />
              ))}
            </div>
          ) : (
            <DocList docs={filtered} workspaceId={workspace.id} projects={projects} />
          )}
        </>
      )}
    </section>
  );
}

function ViewButton({
  active,
  onClick,
  icon,
  label,
  testid,
}: {
  active: boolean;
  onClick: () => void;
  icon: string;
  label: string;
  testid: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      data-testid={testid}
      onClick={onClick}
      className={`grid size-7 place-items-center rounded-sm transition-colors ${
        active ? "bg-surface text-accent-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-subtle hover:text-ink"
      }`}
    >
      <Icon name={icon} size={15} />
    </button>
  );
}

function applyFilter(docs: DocRow[], filter: Filter): DocRow[] {
  if (filter === "all") return docs;
  // shared / detached require fields no endpoint returns yet → no docs match (honest 0).
  return [];
}

function labelFor(filter: Filter): string {
  return filter === "shared" ? "shared" : filter === "detached" ? "has detached" : "all";
}
