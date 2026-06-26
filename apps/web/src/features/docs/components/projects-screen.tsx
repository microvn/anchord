import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useActiveWorkspace } from "@/features/workspaces/components/active-workspace";
import { queryKeys } from "@/features/workspaces/lib/query-keys";
import { unwrapEnvelope } from "@/features/workspaces/hooks/use-bootstrap";
import { toApiError } from "@/lib/api/api-error";
import { useProjectsBrowse, BROWSE_PAGE_SIZE } from "@/features/docs/hooks/use-docs";
import { createProject } from "@/features/docs/services/client";
import type { ProjectVisibility } from "@/features/docs/types";
import { ProjectCardMoreMenu } from "./project-more-menu";
import { ProjectVisibilityBadge } from "./project-visibility-badge";
import { Pagination } from "@/components/pagination";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/icon";
import { Skeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { usePageMeta } from "@/hooks/use-page-meta";

// `/w/:id/projects` — the Projects browser, 1:1 with Anchord-Design's ProjectsScreen
// (browser.jsx). page-head (Workspace eyebrow + Fraunces title + New-project) · a proj-grid
// of proj-cards (folder glyph · name · Default pin · doc-count stat) + a dashed "New project"
// tile. Wired to GET …/projects (active projects, with per-project doc counts derived from
// useWorkspaceDocs) and POST …/projects (create). Opening a project routes to its OWN doc browse
// `/w/:workspaceId/projects/:id` (workspace-project-browse S-001), not the All-docs union.

export function ProjectsScreen() {
  usePageMeta("Projects");
  const { workspace } = useActiveWorkspace();
  const navigate = useNavigate();
  const [dialogOpen, setDialogOpen] = useState(false);
  // S-002 / AS-005: "Show archived" broadens the browse to include archived projects (so they
  // can be unarchived). Off by default → archived projects are hidden (AS-004).
  const [showArchived, setShowArchived] = useState(false);
  const query = useProjectsBrowse(workspace.id, showArchived);

  const projects = query.data ?? [];
  // S-008: numbered pagination over the COMPLETE access-filtered projects list (page size 20,
  // C-007). The list is membership-gated server-side, so its length is the accessible total; the
  // page is sliced client-side and the control hides for a single page (AS-024 / AS-023 analogue).
  const [page, setPage] = useState(1);
  const totalPages = Math.ceil(projects.length / BROWSE_PAGE_SIZE);
  useEffect(() => {
    if (page > totalPages && totalPages >= 1) setPage(totalPages);
  }, [page, totalPages]);
  // Toggling "Show archived" broadens/narrows the set → back to page 1.
  useEffect(() => {
    setPage(1);
  }, [showArchived]);
  const safePage = Math.min(page, Math.max(1, totalPages));
  const pageProjects = projects.slice(
    (safePage - 1) * BROWSE_PAGE_SIZE,
    safePage * BROWSE_PAGE_SIZE,
  );

  return (
    <section className="mx-auto max-w-[1100px] px-6 py-8" data-testid="projects-screen">
      <div className="mb-[22px] flex items-end gap-4">
        <div>
          <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.12em] text-subtle">
            Workspace
          </div>
          <h1 className="font-serif text-[30px] font-medium leading-[1.05] tracking-[-0.02em] text-ink">
            Projects
          </h1>
        </div>
        <div className="ml-auto flex flex-none items-center gap-3">
          <label className="flex cursor-pointer select-none items-center gap-2 text-[12.5px] text-muted">
            <Checkbox
              data-testid="show-archived-toggle"
              checked={showArchived}
              onCheckedChange={(v) => setShowArchived(v === true)}
            />
            Show archived
          </label>
          <Button
            type="button"
            variant="secondary"
            data-testid="new-project-button"
            onClick={() => setDialogOpen(true)}
          >
            <Icon name="plus" size={16} />
            New project
          </Button>
        </div>
      </div>

      {query.isPending ? (
        <Skeleton rows={4} />
      ) : query.isError ? (
        <ErrorState message={query.error?.message} onRetry={() => void query.refetch()} />
      ) : projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="Projects group related docs — specs, plans, reports. Create your first to organize them."
          action={
            <Button type="button" data-testid="empty-new-project" onClick={() => setDialogOpen(true)}>
              <Icon name="plus" size={16} />
              Create your first project
            </Button>
          }
        />
      ) : (
        <>
        <div
          data-testid="proj-grid"
          className="grid grid-cols-1 gap-[14px] sm:grid-cols-2 lg:grid-cols-3"
        >
          {pageProjects.map((p) => (
            <div
              key={p.id}
              data-testid={`proj-card-${p.id}`}
              className={`group relative flex flex-col rounded-[11px] border border-line bg-surface p-4 transition-[border-color,box-shadow,transform] duration-100 hover:-translate-y-px hover:border-subtle hover:shadow-[0_8px_24px_rgba(0,0,0,0.28)] ${
                p.archived ? "opacity-70" : ""
              }`}
            >
              {/* Whole-card navigation lives on this absolute overlay so the ⋯ menu (a real
                  button) can sit above it without nesting buttons. z-10 lifts the overlay ABOVE
                  the relative content rows so a click anywhere on the card hits it (not just the
                  padding gaps); cursor-pointer because Tailwind v4 no longer sets it on <button>.
                  The ⋯ menu is raised to z-20 (below) so it stays clickable above this overlay. */}
              <button
                type="button"
                aria-label={`Open ${p.name}`}
                data-testid={`proj-open-${p.id}`}
                onClick={() => navigate(`/w/${workspace.id}/projects/${p.id}`)}
                className="absolute inset-0 z-10 cursor-pointer rounded-[11px]"
              />
              {/* items-stretch + aspect-square: the folder glyph's height tracks the right column
                  (title row + badges row), so icon height == title+visibility height. */}
              <div className="relative flex items-stretch gap-[10px]">
                <span className="relative grid aspect-square flex-none place-items-center self-stretch rounded-sm bg-accent-soft text-accent-ink">
                  <Icon name="folder" size={17} />
                  {/* Default project → a pin badge on the folder icon (not a row-2 pill), so it
                      reads distinctly from the visibility pill. sr-only label keeps it accessible. */}
                  {p.isDefault && (
                    <TooltipProvider delayDuration={150}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            data-testid={`proj-default-${p.id}`}
                            className="absolute -bottom-1 -right-1 z-20 grid size-[15px] cursor-default place-items-center rounded-full bg-accent text-on-accent ring-2 ring-surface"
                          >
                            <Icon name="pin" size={9} />
                            <span className="sr-only">Default</span>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top">Default project</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </span>
                <div className="flex min-w-0 flex-1 flex-col justify-center gap-[6px]">
                  {/* Row 1 — title + the ⋯ menu (top-right). */}
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-[18px] text-ink">
                      {p.name}
                    </span>
                    {/* z-20 keeps the ⋯ menu above the z-10 nav overlay so it stays clickable. */}
                    <span className="relative z-20 -my-1 inline-flex flex-none">
                      <ProjectCardMoreMenu project={p} workspaceId={workspace.id} />
                    </span>
                  </div>
                  {/* Row 2 — visibility + Default (+ Archived) badges, below the title. */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {p.archived && (
                      <span
                        data-testid={`proj-archived-${p.id}`}
                        className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-subtle"
                      >
                        Archived
                      </span>
                    )}
                    {/* project-visibility-fe AS-001: Private/Public pill. The Default marker moved to
                        a pin badge on the folder icon (above), so row 2 carries only the visibility
                        pill (+ Archived) — no two look-alike pills. */}
                    {p.visibility && (
                      <ProjectVisibilityBadge visibility={p.visibility} projectId={p.id} />
                    )}
                  </div>
                </div>
              </div>
              <div className="relative mt-[14px] text-[13px] tabular-nums text-muted">
                {p.docCount ?? 0} {p.docCount === 1 ? "doc" : "docs"}
              </div>
            </div>
          ))}
          <button
            type="button"
            data-testid="new-project-tile"
            onClick={() => setDialogOpen(true)}
            className="flex min-h-[110px] flex-col items-center justify-center rounded-[11px] border border-dashed border-line text-muted transition-colors hover:border-accent hover:text-accent-ink"
          >
            <Icon name="plus" size={18} />
            <span className="mt-1.5 text-[13px] font-semibold">New project</span>
          </button>
        </div>
        <Pagination page={safePage} totalPages={totalPages} onPageChange={setPage} />
        </>
      )}

      <NewProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        workspaceId={workspace.id}
      />
    </section>
  );
}

function NewProjectDialog({
  open,
  onOpenChange,
  workspaceId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  // project-visibility-fe S-005 / C-001 / AS-018: the create-time Public/Private choice. Default
  // Public (backward-compatible — the prior create-always-public behaviour is preserved); the control
  // only COLLECTS the user's pick and sends it verbatim, never derives access.
  const [visibility, setVisibility] = useState<ProjectVisibility>("public");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Project name is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = unwrapEnvelope<{ id: string; name: string }>(
        await createProject(workspaceId, trimmed, visibility),
      );
      if (res.error) {
        setError(toApiError(res.error).message);
        setSubmitting(false);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.docs(workspaceId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects(workspaceId) });
      toast.success(`Created project “${trimmed}”`);
      setName("");
      setVisibility("public");
      setSubmitting(false);
      onOpenChange(false);
    } catch (thrown) {
      setError(toApiError(thrown).message);
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          setName("");
          setVisibility("public");
          setError(null);
        }
      }}
    >
      <DialogContent data-testid="new-project-dialog" className="border-line bg-surface sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="font-serif text-[19px] font-medium text-ink">
            New project
          </DialogTitle>
          <DialogDescription className="text-[13px] text-muted">
            Projects group related docs in this workspace.
          </DialogDescription>
        </DialogHeader>
        <div>
          <label htmlFor="project-name" className="mb-1.5 block text-[12px] font-medium text-muted">
            Name
          </label>
          <input
            id="project-name"
            data-testid="project-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. render-publish"
            className="min-h-[40px] w-full rounded-md border border-line bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent"
          />
          {error && (
            <p role="alert" data-testid="project-name-error" className="mt-1 text-[12px] text-error">
              {error}
            </p>
          )}
        </div>
        {/* project-visibility-fe S-005 / AS-018/AS-019 / C-001: a two-button segmented control —
            collects the create-time visibility choice (default Public). Private = owner-only shell
            (new docs in it are private); Public = visible to the workspace. The hint mirrors the
            project-visibility carve-out copy without re-deriving it. */}
        <div>
          <span className="mb-1.5 block text-[12px] font-medium text-muted">Visibility</span>
          <div
            role="radiogroup"
            aria-label="Project visibility"
            className="inline-flex rounded-md border border-line p-0.5"
          >
            {(["public", "private"] as const).map((v) => {
              const selected = visibility === v;
              return (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-testid={`new-project-visibility-${v}`}
                  onClick={() => setVisibility(v)}
                  className={`inline-flex items-center gap-1.5 rounded-[5px] px-3 py-1 text-[12.5px] font-medium transition-colors ${
                    selected
                      ? "bg-accent-soft text-accent-ink"
                      : "text-muted hover:text-ink"
                  }`}
                >
                  <Icon name={v === "public" ? "members" : "shield"} size={13} />
                  {v === "public" ? "Public" : "Private"}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[12px] text-subtle">
            {visibility === "public"
              ? "Visible to everyone in this workspace."
              : "Only you — new docs in it stay private until shared."}
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="create-project-button"
            disabled={submitting}
            onClick={() => void onCreate()}
          >
            {submitting ? "Creating…" : "Create project"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
