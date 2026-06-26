import { toast } from "sonner";
import { toApiError } from "@/lib/api/api-error";
import { useToggleProjectVisibility } from "@/features/docs/hooks/use-project-visibility";
import { Icon } from "@/components/icon";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { ProjectRow } from "@/features/docs/types";

// project-visibility-fe S-001 / AS-002 / AS-004 / AS-005 / C-003. The ⋯-menu visibility toggle.
// Rendered by ProjectCardMoreMenu ONLY where the list row's `canToggleVisibility` is true (AS-003 /
// C-003) — this component does not re-check the gate. Choosing it opens a ConfirmDialog that
// DISCLOSES the change touches only docs created afterward (existing shared docs keep their sharing,
// AS-004 / C-008) BEFORE the user commits; confirming fires the optimistic mutation (the hook owns
// the optimistic write, the authoritative-refetch reconcile, and the rollback-on-reject). The menu
// item is disabled while a toggle is in flight so two toggles can't race (AS-002); a rejected toggle
// rolls the badge back and surfaces a toast (AS-005).
export function ProjectVisibilityToggle({
  project,
  workspaceId,
}: {
  project: ProjectRow;
  workspaceId: string;
}) {
  const toggle = useToggleProjectVisibility(workspaceId);
  const next = project.visibility === "public" ? "private" : "public";
  const label = next === "private" ? "Make private" : "Make public";

  function onConfirm() {
    toggle.mutate(
      { projectId: project.id, next },
      { onError: (err) => toast.error(toApiError(err).message) },
    );
  }

  return (
    <ConfirmDialog
      trigger={
        <DropdownMenuItem
          data-testid={`proj-more-visibility-${project.id}`}
          disabled={toggle.isPending}
          // Keep the menu item from closing the menu before the confirm dialog opens.
          onSelect={(e) => e.preventDefault()}
        >
          <Icon name={next === "public" ? "members" : "shield"} size={15} />
          {label}
        </DropdownMenuItem>
      }
      title={`${label}?`}
      description="This changes only docs created afterward. Existing shared docs keep their current sharing."
      confirmLabel={label}
      confirmTestId={`proj-visibility-confirm-${project.id}`}
      onConfirm={onConfirm}
    />
  );
}
