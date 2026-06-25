import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { deleteDoc } from "@/features/docs/services/client";
import { queryKeys } from "@/features/workspaces/lib/query-keys";
import { unwrapEnvelope } from "@/features/workspaces/hooks/use-bootstrap";
import { toApiError } from "@/lib/api/api-error";
import type { DocRow } from "@/features/docs/types";

// DeleteDocDialog (doc-delete-trash S-001 / AS-001) — the confirm gate for deleting a doc into
// Trash. Mirrors the project-delete confirm (project-more-menu.tsx): a destructive ConfirmDialog
// (focus-trap + Esc + Cancel safe default) whose action runs the soft-delete only on explicit
// confirm. The warning names the annotation count so the user knows what moves to Trash, and that
// it can be RESTORED (soft-delete, not permanent — C-001). On success the workspace docs +
// projects caches are invalidated so the deleted doc disappears from the grid, and a toast
// confirms. A backend refusal (403 for a commenter — AS-004) surfaces its reason and leaves the
// doc active. `trigger` is the menu item that opens the flow (passed through asChild).

export function DeleteDocDialog({
  trigger,
  doc,
  workspaceId,
}: {
  trigger: ReactNode;
  doc: DocRow;
  workspaceId: string;
}) {
  const queryClient = useQueryClient();

  async function onDelete() {
    try {
      const res = unwrapEnvelope(await deleteDoc(workspaceId, doc.slug));
      if (res.error) {
        toast.error(toApiError(res.error).message);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.docs(workspaceId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects(workspaceId) });
      toast.success(`Moved “${doc.title}” to Trash`);
    } catch (thrown) {
      toast.error(toApiError(thrown).message);
    }
  }

  // The annotation count drives the warning copy: "This doc and its N annotations move to Trash".
  // null-safe: 0 / undefined collapse to "This doc moves to Trash" (no "0 annotations" noise). The
  // verb agrees with the subject — plural "move" with the annotation list, singular "moves" alone.
  const n = doc.annotationCount ?? 0;
  const description =
    n > 0
      ? `This doc and its ${n} annotation${n === 1 ? "" : "s"} move to Trash and can be restored.`
      : "This doc moves to Trash and can be restored.";

  return (
    <ConfirmDialog
      trigger={trigger}
      title={`Delete “${doc.title}”?`}
      description={description}
      confirmLabel="Delete doc"
      confirmTestId="doc-delete-confirm"
      onConfirm={() => void onDelete()}
    />
  );
}
