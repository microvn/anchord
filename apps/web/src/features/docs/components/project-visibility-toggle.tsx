import { useState } from "react";
import { toast } from "sonner";
import { toApiError } from "@/lib/api/api-error";
import { useToggleProjectVisibility } from "@/features/docs/hooks/use-project-visibility";
import { Icon } from "@/components/icon";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { ProjectRow } from "@/features/docs/types";

// project-visibility-fe S-001 + project-visibility-cascade S-001 / AS-003 / C-001. The ⋯-menu
// visibility toggle. Rendered by ProjectCardMoreMenu ONLY where the list row's
// `canToggleVisibility` is true — this component does not re-check the gate.
//
// PRIVATE→PUBLIC: a single plain confirm (no cascade — C-001 limits the cascade to public→private).
// PUBLIC→PRIVATE: a TWO-OPTION dialog (project-visibility-cascade S-001):
//   1. "Make the project and all its docs private" (cascade) — sends `cascade: true`; carries an
//      IRREVERSIBILITY warning that revoking the docs' sharing cannot be undone (AS-003 / C-001).
//   2. "Only change the project (keep docs shared)" — the parent behaviour; sends no cascade flag
//      (project-visibility:AS-014 / C-008), so existing docs keep their sharing.
// The hook owns the optimistic write + rollback-on-reject; a rejected toggle surfaces a toast.
export function ProjectVisibilityToggle({
  project,
  workspaceId,
}: {
  project: ProjectRow;
  workspaceId: string;
}) {
  const toggle = useToggleProjectVisibility(workspaceId);
  const makingPrivate = project.visibility === "public";
  const next = makingPrivate ? "private" : "public";
  const label = makingPrivate ? "Make private" : "Make public";

  function run(cascade: boolean) {
    toggle.mutate(
      { projectId: project.id, next, cascade },
      { onError: (err) => toast.error(toApiError(err).message) },
    );
  }

  const menuItem = (
    <DropdownMenuItem
      data-testid={`proj-more-visibility-${project.id}`}
      disabled={toggle.isPending}
      // Keep the menu item from closing the menu before the dialog opens.
      onSelect={(e) => e.preventDefault()}
    >
      <Icon name={makingPrivate ? "shield" : "members"} size={15} />
      {label}
    </DropdownMenuItem>
  );

  // private→public: unchanged single confirm, no cascade option (C-001).
  if (!makingPrivate) {
    return (
      <ConfirmDialog
        trigger={menuItem}
        title={`${label}?`}
        description="This makes the project visible to the workspace. It changes only docs created afterward — existing docs keep their current sharing."
        confirmLabel={label}
        confirmTestId={`proj-visibility-confirm-${project.id}`}
        onConfirm={() => run(false)}
      />
    );
  }

  // public→private: the two-option dialog (project-visibility-cascade S-001 / AS-003).
  return <MakePrivateDialog project={project} trigger={menuItem} onChoose={run} />;
}

// The make-private TWO-OPTION dialog. Each option is its own action button: the cascade option
// shows an irreversibility warning (AS-003 / C-001); the keep-shared option is the parent behaviour.
function MakePrivateDialog({
  project,
  trigger,
  onChoose,
}: {
  project: ProjectRow;
  trigger: React.ReactNode;
  onChoose: (cascade: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  function choose(cascade: boolean) {
    setOpen(false);
    onChoose(cascade);
  }
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent
        overlayClassName="bg-[var(--scrim)]"
        className="w-full max-w-[480px] gap-0 rounded-[11px] border border-line bg-surface p-0 shadow-[var(--shadow-modal)] data-[size=default]:sm:max-w-[480px]"
      >
        <AlertDialogHeader className="block gap-0 p-[18px] pb-0 text-left sm:place-items-start sm:text-left">
          <AlertDialogTitle className="font-serif text-[21px] font-medium leading-[1.05] tracking-[-0.03em] text-ink">
            Make private?
          </AlertDialogTitle>
          <AlertDialogDescription className="sr-only">
            Choose whether to also make every doc in this project private (cannot be undone) or to
            change only the project and keep existing docs shared.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-2 p-[18px] pt-3">
          {/* Option 1 — cascade. Carries the irreversibility warning (AS-003 / C-001). */}
          <button
            type="button"
            data-testid={`proj-visibility-cascade-${project.id}`}
            onClick={() => choose(true)}
            className="flex flex-col gap-1 rounded-[9px] border border-line p-3 text-left hover:border-ink/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <span className="text-[13px] font-medium text-ink">
              Make the project and all its docs private
            </span>
            <span
              data-testid={`proj-visibility-cascade-warning-${project.id}`}
              className="text-[12px] text-[var(--red,#f1655d)]"
            >
              Revokes workspace and link sharing on every doc in this project. This can&rsquo;t be
              undone — making the project public again later won&rsquo;t restore the docs&rsquo;
              previous access. People you invited specifically keep access.
            </span>
          </button>

          {/* Option 2 — keep docs shared (the parent behaviour). */}
          <button
            type="button"
            data-testid={`proj-visibility-keep-${project.id}`}
            onClick={() => choose(false)}
            className="flex flex-col gap-1 rounded-[9px] border border-line p-3 text-left hover:border-ink/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <span className="text-[13px] font-medium text-ink">
              Only change the project (keep docs shared)
            </span>
            <span className="text-[12px] text-muted">
              The project becomes private, but existing docs keep their current sharing.
            </span>
          </button>
        </div>

        <AlertDialogFooter className="flex flex-row justify-end gap-2 px-[18px] pt-1 pb-[18px]">
          <AlertDialogCancel variant="secondary" className="mt-0">
            Cancel
          </AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
