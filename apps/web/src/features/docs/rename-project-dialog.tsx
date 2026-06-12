import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { renameProject } from "./client";
import { queryKeys } from "@/features/workspaces/query-keys";
import { unwrapEnvelope } from "@/features/workspaces/use-bootstrap";
import { toApiError } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ProjectRow } from "./types";

// RenameProjectDialog (workspace-project-ui S-002 / AS-003) — mirrors the create/rename Dialog
// pattern (create-workspace-dialog.tsx / rename-field.tsx): a name input + Save. On success it
// invalidates the projects + docs caches so the browse shows the new name immediately.

interface RenamedProject {
  id: string;
  name: string;
}

export function RenameProjectDialog({
  open,
  onOpenChange,
  workspaceId,
  project,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  project: ProjectRow;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Project name is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = unwrapEnvelope<RenamedProject>(
        await renameProject(workspaceId, project.id, trimmed),
      );
      if (res.error) {
        setError(toApiError(res.error).message);
        setBusy(false);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects(workspaceId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.docs(workspaceId) });
      toast.success(`Renamed to “${trimmed}”`);
      setBusy(false);
      onOpenChange(false);
    } catch (thrown) {
      setError(toApiError(thrown).message);
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          setName(project.name);
          setError(null);
        }
      }}
    >
      <DialogContent
        aria-label="Rename project"
        data-testid="rename-project-dialog"
        overlayClassName="bg-[var(--scrim)]"
        className="w-full max-w-[440px] gap-0 rounded-[11px] border border-line bg-surface p-0 shadow-[var(--shadow-modal)] sm:max-w-[440px]"
      >
        <form onSubmit={submit}>
          <DialogHeader className="gap-0 p-[18px] pb-0 text-left">
            <DialogTitle className="font-serif text-[21px] font-medium leading-[1.05] tracking-[-0.03em] text-ink">
              Rename project
            </DialogTitle>
            <DialogDescription className="mt-[3px] text-[12.5px] text-muted">
              Give this project a new name.
            </DialogDescription>
          </DialogHeader>

          <div className="px-[18px] py-4">
            <label
              htmlFor="rename-project-name"
              className="mb-1.5 block text-[12.5px] font-medium text-ink"
            >
              Name
            </label>
            <input
              id="rename-project-name"
              data-testid="rename-project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              className="h-9 w-full rounded-[8px] border border-line bg-surface px-[11px] text-[13.5px] text-ink outline-none placeholder:text-subtle focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
            />
            {error && (
              <p role="alert" data-testid="rename-project-error" className="mt-2 text-[12.5px] text-error">
                {error}
              </p>
            )}
          </div>

          <div className="flex justify-end gap-2 px-[18px] pb-[18px]">
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" data-testid="rename-project-submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
