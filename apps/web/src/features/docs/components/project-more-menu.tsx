import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { archiveProject, unarchiveProject, deleteProject } from "@/features/docs/client";
import { RenameProjectDialog } from "./rename-project-dialog";
import { queryKeys } from "@/features/workspaces/query-keys";
import { unwrapEnvelope } from "@/features/workspaces/use-bootstrap";
import { toApiError } from "@/lib/api/api-error";
import { Icon } from "@/components/icon";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ProjectRow } from "@/features/docs/types";

// ProjectCardMoreMenu (workspace-project-ui S-002) — a ⋯ on each proj-card → Rename · Archive
// (or Unarchive when archived) · Delete. Delete is HIDDEN entirely on the default project
// (C-002) and, when shown, opens ConfirmDialog so the mutation only fires on explicit confirm
// (C-001). A non-empty delete that the backend refuses surfaces the returned reason (toast) and
// leaves the project (AS-007). All mutations invalidate the projects + docs caches so the browse
// reflects the change.

export function ProjectCardMoreMenu({
  project,
  workspaceId,
}: {
  project: ProjectRow;
  workspaceId: string;
}) {
  const queryClient = useQueryClient();
  const [renameOpen, setRenameOpen] = useState(false);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: queryKeys.projects(workspaceId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.docs(workspaceId) });
  }

  async function onArchive() {
    try {
      const res = unwrapEnvelope(await archiveProject(workspaceId, project.id));
      if (res.error) {
        toast.error(toApiError(res.error).message);
        return;
      }
      await refresh();
      toast.success(`Archived “${project.name}”`);
    } catch (thrown) {
      toast.error(toApiError(thrown).message);
    }
  }

  async function onUnarchive() {
    try {
      const res = unwrapEnvelope(await unarchiveProject(workspaceId, project.id));
      if (res.error) {
        toast.error(toApiError(res.error).message);
        return;
      }
      await refresh();
      toast.success(`Unarchived “${project.name}”`);
    } catch (thrown) {
      toast.error(toApiError(thrown).message);
    }
  }

  async function onDelete() {
    try {
      // The backend refuses a non-empty (or default) project with a 409 envelope — surface its
      // reason and leave the project (AS-007 / C-002). Only a clean delete removes it.
      const res = unwrapEnvelope(await deleteProject(workspaceId, project.id));
      if (res.error) {
        toast.error(toApiError(res.error).message);
        return;
      }
      await refresh();
      toast.success(`Deleted “${project.name}”`);
    } catch (thrown) {
      toast.error(toApiError(thrown).message);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid={`proj-more-${project.id}`}
            aria-label="Project actions"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            className="grid size-7 flex-none place-items-center rounded-md text-subtle hover:bg-elev hover:text-ink"
          >
            <Icon name="more" size={16} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="border-line bg-surface">
          <DropdownMenuItem
            data-testid="proj-more-rename"
            onSelect={(e) => {
              e.preventDefault();
              setRenameOpen(true);
            }}
          >
            <Icon name="pencil" size={15} />
            Rename…
          </DropdownMenuItem>
          {project.archived ? (
            <DropdownMenuItem
              data-testid="proj-more-unarchive"
              onSelect={(e) => {
                e.preventDefault();
                void onUnarchive();
              }}
            >
              <Icon name="folder" size={15} />
              Unarchive
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              data-testid="proj-more-archive"
              onSelect={(e) => {
                e.preventDefault();
                void onArchive();
              }}
            >
              <Icon name="inbox" size={15} />
              Archive
            </DropdownMenuItem>
          )}
          {/* C-002: the default project has NO Delete control. */}
          {!project.isDefault && (
            <>
              <DropdownMenuSeparator />
              <ConfirmDialog
                trigger={
                  <DropdownMenuItem
                    variant="destructive"
                    data-testid="proj-more-delete"
                    // Keep the menu item from closing the menu before the dialog opens.
                    onSelect={(e) => e.preventDefault()}
                  >
                    <Icon name="trash" size={15} />
                    Delete…
                  </DropdownMenuItem>
                }
                title={`Delete “${project.name}”?`}
                description="This permanently removes the project. A project that still has docs can't be deleted."
                confirmLabel="Delete project"
                confirmTestId="proj-delete-confirm"
                onConfirm={() => void onDelete()}
              />
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {renameOpen && (
        <RenameProjectDialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          workspaceId={workspaceId}
          project={project}
        />
      )}
    </>
  );
}
