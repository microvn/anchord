import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

// VisibilityBoundaryAlert (project-visibility-fe S-003 / C-002) — shown ONLY when a doc-move is
// refused with the server discriminator `reason === "visibility_boundary"` (a workspace-shared doc
// being moved into a private project). It is the FE half of the server-enforced choice: the move was
// NOT applied; the user must pick "Make this doc private" or "Keep current sharing" before any retry
// is sent, or Cancel to send nothing at all (C-002). The FE never guesses this boundary itself
// (C-001) — the parent opens this purely on the server's `reason`, and the chosen option rides the
// retry. Buttons are plain (not Radix Action/Cancel) so the parent fully controls when the alert
// closes: it stays open while a retry is in flight and is dismissed by the parent on success/terminal
// error — never auto-closed by the primitive, so a retry can never silently re-arm it (AS-013).

export function VisibilityBoundaryAlert({
  open,
  docTitle,
  targetName,
  busy = false,
  onMakePrivate,
  onKeepSharing,
  onCancel,
}: {
  open: boolean;
  docTitle: string;
  /** The private target project's name, for the disclosure copy. */
  targetName: string;
  /** A retry carrying the choice is in flight — disables the actions (no double-submit). */
  busy?: boolean;
  onMakePrivate: () => void;
  onKeepSharing: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog
      open={open}
      // Escape / overlay dismissal routes to Cancel — which sends nothing (AS-010).
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent
        data-testid="visibility-boundary-alert"
        overlayClassName="bg-[var(--scrim)]"
        className="border-line bg-surface"
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="font-serif text-[19px] font-medium text-ink">
            Move into a private project?
          </AlertDialogTitle>
          <AlertDialogDescription className="text-[13px] text-muted">
            “{docTitle}” is shared with your workspace, but {targetName} is private. Choose whether to
            make this doc private too, or keep its current sharing inside the private project.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-2 border-t border-line pt-4 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="secondary"
            data-testid="boundary-cancel"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="secondary"
            data-testid="boundary-keep"
            disabled={busy}
            onClick={onKeepSharing}
          >
            Keep current sharing
          </Button>
          <Button
            type="button"
            data-testid="boundary-make-private"
            disabled={busy}
            onClick={onMakePrivate}
          >
            Make this doc private
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
