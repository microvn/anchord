import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { queryKeys } from "@/features/workspaces/lib/query-keys";
import { unwrapEnvelope } from "@/features/workspaces/hooks/use-bootstrap";
import { toApiError } from "@/lib/api/api-error";
import {
  moveDoc,
  copyDoc,
  fetchWorkspaceDocs,
  type MoveAccessChoice,
} from "@/features/docs/services/client";
import type { DocRow, GeneralAccess, ProjectRow } from "@/features/docs/types";

// useDocMove (project-visibility-fe S-003) — the move/copy mutation orchestration the MoveCopyDialog
// renders. It owns the busy/error state, the COPY + plain-MOVE happy paths, and the visibility-
// boundary flow: a move refused with the server discriminator `reason === "visibility_boundary"`
// (C-002) opens the alert instead of erroring; the user's choice rides the retry; and the retry's
// outcome is reconciled from the doc's ACTUAL server access — never a false "now private" (AS-014).
// The FE never computes the boundary itself (C-001) — it keys purely on the server's `reason`.

type Mode = "move" | "copy";

interface MoveCopyResult {
  docId: string;
  slug: string;
  projectId: string;
}

// The doc shape the post-move reconcile reads back (AS-014): the workspace-docs read carries each
// doc's resulting `generalAccess`, the ONLY authoritative signal for a doc's access after a boundary
// move — the move response itself has no access field, so the FE must NOT assert "now private" from
// the user's choice; it reads the actual server value (C-001/C-002).
interface ReconcileDocsResult {
  docs: { slug: string; generalAccess?: GeneralAccess }[];
}

export interface UseDocMove {
  busy: boolean;
  error: string | null;
  /** The project id a boundary-crossing move was refused for — non-null ⇔ the alert is open. */
  boundaryTarget: string | null;
  /** Display name of the boundary target project, for the alert copy. */
  boundaryTargetName: string;
  /** Run a move or copy to `target`. A boundary-crossing move opens the alert (no error surfaced). */
  confirm: (mode: Mode, target: string) => Promise<void>;
  /** Retry the refused move carrying the user's access choice. */
  chooseBoundary: (choice: MoveAccessChoice) => Promise<void>;
  /** Dismiss the alert; sends nothing, leaves the doc + sharing unchanged (AS-010). */
  cancelBoundary: () => void;
  /** Clear a surfaced error (e.g. when the dialog reopens). */
  clearError: () => void;
}

export function useDocMove(
  workspaceId: string,
  doc: DocRow,
  projects: ProjectRow[],
  onDone: () => void,
): UseDocMove {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [boundaryTarget, setBoundaryTarget] = useState<string | null>(null);

  function projectName(id: string | null): string {
    return (id && projects.find((p) => p.id === id)?.name) || "project";
  }

  async function invalidateBrowse() {
    await queryClient.invalidateQueries({ queryKey: queryKeys.docs(workspaceId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.projects(workspaceId) });
  }

  // C-002: the alert is keyed STRICTLY on the server's `reason` discriminator — never on the bare 409
  // status or message text. A refusal for any other reason surfaces a generic error (AS-011).
  function handleMoveError(apiErr: ReturnType<typeof toApiError>, refusedTarget: string) {
    if (apiErr.reason === "visibility_boundary") {
      setBoundaryTarget(refusedTarget);
      setBusy(false);
      return;
    }
    setError(apiErr.message);
    setBusy(false);
  }

  async function confirm(mode: Mode, target: string) {
    if (!target) return;
    setBusy(true);
    setError(null);
    const targetName = projectName(target);
    try {
      if (mode === "copy") {
        const res = unwrapEnvelope<MoveCopyResult>(await copyDoc(workspaceId, doc.slug, target));
        if (res.error) {
          setError(toApiError(res.error).message);
          setBusy(false);
          return;
        }
        await invalidateBrowse();
        toast.success(`Copied “${doc.title}” to ${targetName}`);
        onDone();
        setBusy(false);
        return;
      }

      // MOVE — a boundary-crossing refusal opens the alert; everything else is a plain success/error.
      const res = unwrapEnvelope<MoveCopyResult>(await moveDoc(workspaceId, doc.slug, target));
      if (res.error) {
        handleMoveError(toApiError(res.error), target);
        return;
      }
      await invalidateBrowse();
      // A plain (non-boundary) move implies no access change → confirm the move, claim no access.
      toast.success(`Moved “${doc.title}” to ${targetName}`);
      onDone();
      setBusy(false);
    } catch (thrown) {
      handleMoveError(toApiError(thrown), target);
    }
  }

  // Retry the move carrying the chosen access option (AS-012/AS-015). On terminal failure the alert
  // is dismissed with an error — never silently re-armed or looped (AS-013).
  async function chooseBoundary(choice: MoveAccessChoice) {
    if (!boundaryTarget) return;
    const retryTarget = boundaryTarget;
    setBusy(true);
    setError(null);
    const targetName = projectName(retryTarget);
    try {
      const res = unwrapEnvelope<MoveCopyResult>(
        await moveDoc(workspaceId, doc.slug, retryTarget, choice),
      );
      if (res.error) {
        // AS-013: a retry that fails terminally (404/403) closes the alert and shows the error.
        setBoundaryTarget(null);
        setError(toApiError(res.error).message);
        setBusy(false);
        return;
      }
      await reconcileAndFinish(targetName);
    } catch (thrown) {
      setBoundaryTarget(null);
      setError(toApiError(thrown).message);
      setBusy(false);
    }
  }

  // AS-014 / C-001: after a boundary retry succeeds, read the doc's ACTUAL resulting access from a
  // refetch — the move response carries none, so we never confirm "private" from the choice. If the
  // target was flipped public mid-flow the server applied a plain move; the reconcile then reports
  // the real (still-shared) outcome instead of a false "now private".
  async function reconcileAndFinish(targetName: string) {
    let access: GeneralAccess | null = null;
    try {
      const res = unwrapEnvelope<ReconcileDocsResult>(await fetchWorkspaceDocs(workspaceId));
      if (!res.error) {
        access = res.data?.docs.find((d) => d.slug === doc.slug)?.generalAccess ?? null;
      }
    } catch {
      // Reconcile read failed — fall back to a neutral "moved" confirmation (never a false claim).
      access = null;
    }
    await invalidateBrowse();
    setBoundaryTarget(null);
    onDone();
    setBusy(false);
    if (access === "restricted") {
      toast.success(`Moved “${doc.title}” to ${targetName} — now private (only you)`);
    } else if (access != null) {
      toast.success(`Moved “${doc.title}” to ${targetName} — still shared with your workspace`);
    } else {
      toast.success(`Moved “${doc.title}” to ${targetName}`);
    }
  }

  function cancelBoundary() {
    // AS-010: Cancel sends nothing and leaves the doc + its sharing unchanged.
    setBoundaryTarget(null);
    setBusy(false);
  }

  return {
    busy,
    error,
    boundaryTarget,
    boundaryTargetName: projectName(boundaryTarget),
    confirm,
    chooseBoundary,
    cancelBoundary,
    clearError: () => setError(null),
  };
}
