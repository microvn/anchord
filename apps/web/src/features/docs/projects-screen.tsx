import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useActiveWorkspace } from "../workspaces/active-workspace";
import { queryKeys } from "../workspaces/query-keys";
import { unwrapEnvelope } from "../workspaces/use-bootstrap";
import { toApiError } from "../../lib/api-error";
import { useWorkspaceDocs } from "./use-docs";
import { createProject } from "./client";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/icon";
import { Skeleton } from "../../components/skeleton";
import { EmptyState } from "../../components/empty-state";
import { ErrorState } from "../../components/error-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";

// `/w/:id/projects` — the Projects browser, 1:1 with Anchord-Design's ProjectsScreen
// (browser.jsx). page-head (Workspace eyebrow + Fraunces title + New-project) · a proj-grid
// of proj-cards (folder glyph · name · Default pin · doc-count stat) + a dashed "New project"
// tile. Wired to GET …/projects (active projects, with per-project doc counts derived from
// useWorkspaceDocs) and POST …/projects (create). Opening a project routes to its filtered
// doc browse (deferred to a per-project route; for now it navigates to All-docs).

export function ProjectsScreen() {
  const { workspace } = useActiveWorkspace();
  const navigate = useNavigate();
  const query = useWorkspaceDocs(workspace.id);
  const [dialogOpen, setDialogOpen] = useState(false);

  const projects = query.data?.projects ?? [];

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
        <div className="ml-auto flex flex-none items-center gap-2">
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
        <div
          data-testid="proj-grid"
          className="grid grid-cols-1 gap-[14px] sm:grid-cols-2 lg:grid-cols-3"
        >
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              data-testid={`proj-card-${p.id}`}
              onClick={() => navigate(`/w/${workspace.id}/docs`)}
              className="flex flex-col rounded-[11px] border border-line bg-surface p-4 text-left transition-[border-color,box-shadow,transform] duration-100 hover:-translate-y-px hover:border-subtle hover:shadow-[0_8px_24px_rgba(0,0,0,0.28)]"
            >
              <div className="flex items-center gap-[10px]">
                <span className="grid size-8 flex-none place-items-center rounded-sm bg-accent-soft text-accent-ink">
                  <Icon name="folder" size={17} />
                </span>
                <span className="text-[15px] font-semibold text-ink">{p.name}</span>
                {p.isDefault && (
                  <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">
                    <Icon name="pin" size={11} />
                    Default
                  </span>
                )}
              </div>
              <div className="mt-[14px] text-[13px] tabular-nums text-muted">
                {p.docCount ?? 0} {p.docCount === 1 ? "doc" : "docs"}
              </div>
            </button>
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
        await createProject(workspaceId, trimmed),
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
