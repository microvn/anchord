import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { useActiveWorkspace } from "@/features/workspaces/components/active-workspace";
import { queryKeys } from "@/features/workspaces/lib/query-keys";
import { unwrapEnvelope } from "@/features/workspaces/hooks/use-bootstrap";
import { toApiError } from "@/lib/api/api-error";
import { useApiQuery } from "@/lib/api/use-api-query";
import { useSession } from "@/lib/api/auth-client";
import { listTrash, restoreDoc, permanentlyDeleteDoc } from "@/features/docs/services/client";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Icon } from "@/components/icon";
import { Skeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { usePageMeta } from "@/hooks/use-page-meta";

// `/w/:id/trash` — the workspace Trash (doc-delete-trash S-003 + S-007). Lists this workspace's
// deleted docs (title + when-deleted) each with a [Restore] action; an empty state ("Nothing in
// Trash") when nothing is deleted (AS-013). Restoring brings the doc back PRIVATE to its original
// project (or the restorer's default when that project is gone) — handled server-side. The list is
// workspace-scoped server-side (C-007 / AS-026): another workspace's deleted docs never appear.
//
// S-007: each row ALSO offers "Delete forever" — but ONLY to the doc's owner or a workspace admin
// (AS-035; the server gate is authoritative). It opens a SECOND, distinctly-worded confirm warning
// the removal is permanent + unrecoverable, then hard-deletes the doc (cascading its versions /
// annotations / comments / share_links).

interface TrashRow {
  id: string;
  slug: string;
  title: string;
  deletedAt: string;
  ownerId: string | null;
}

function useTrash(workspaceId: string) {
  return useApiQuery<TrashRow[]>(queryKeys.trash(workspaceId), async () => {
    try {
      const res = unwrapEnvelope<{ docs: TrashRow[] }>(await listTrash(workspaceId));
      if (res.error) throw toApiError(res.error);
      return { data: res.data?.docs ?? [], error: null };
    } catch (thrown) {
      return { data: null, error: thrown };
    }
  });
}

export function TrashScreen() {
  usePageMeta("Trash");
  const { workspace, isAdmin } = useActiveWorkspace();
  const { data: session } = useSession();
  const myUserId = (session?.user as { id?: string } | undefined)?.id ?? null;
  const queryClient = useQueryClient();
  const query = useTrash(workspace.id);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [purging, setPurging] = useState<string | null>(null);

  const rows = query.data ?? [];

  // S-007 visibility gate (AS-035): "Delete forever" is offered ONLY to the doc's OWNER or a
  // workspace ADMIN — narrower than Restore (owner/editor/admin). A per-doc editor or commenter
  // never sees it; the server gate refuses them regardless.
  function canPurge(row: TrashRow): boolean {
    return isAdmin || (myUserId != null && row.ownerId === myUserId);
  }

  async function onPurge(row: TrashRow) {
    setPurging(row.id);
    try {
      const res = unwrapEnvelope<{ purged: boolean }>(
        await permanentlyDeleteDoc(workspace.id, row.id),
      );
      if (res.error) {
        toast.error(toApiError(res.error).message);
        setPurging(null);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.trash(workspace.id) });
      toast.success(`Permanently deleted “${row.title}”`);
      setPurging(null);
    } catch (thrown) {
      toast.error(toApiError(thrown).message);
      setPurging(null);
    }
  }

  async function onRestore(row: TrashRow) {
    setRestoring(row.id);
    try {
      const res = unwrapEnvelope<{ restored: boolean }>(await restoreDoc(workspace.id, row.id));
      if (res.error) {
        toast.error(toApiError(res.error).message);
        setRestoring(null);
        return;
      }
      // The doc returns to a project AND comes back private — refresh both the Trash list and the
      // browse/projects surfaces it reappears in.
      await queryClient.invalidateQueries({ queryKey: queryKeys.trash(workspace.id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.docs(workspace.id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects(workspace.id) });
      toast.success(`Restored “${row.title}”`);
      setRestoring(null);
    } catch (thrown) {
      toast.error(toApiError(thrown).message);
      setRestoring(null);
    }
  }

  return (
    <section className="mx-auto max-w-[1100px] px-6 py-8" data-testid="trash-screen">
      <div className="mb-[22px]">
        <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.12em] text-subtle">
          Workspace
        </div>
        <h1 className="font-serif text-[30px] font-medium leading-[1.05] tracking-[-0.02em] text-ink">
          Trash
        </h1>
        <p className="mt-2 text-[13px] text-muted">
          Deleted docs keep their annotations and versions and can be restored. A restored doc comes
          back private — re-share it if you need the link again.
        </p>
      </div>

      {query.isPending ? (
        <Skeleton rows={4} />
      ) : query.isError ? (
        <ErrorState message={query.error?.message} onRetry={() => void query.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Nothing in Trash"
          description="Docs you delete land here and can be restored. Trash is empty right now."
        />
      ) : (
        <ul data-testid="trash-list" className="flex flex-col gap-2">
          {rows.map((row) => (
            <li
              key={row.id}
              data-testid={`trash-row-${row.id}`}
              className="flex items-center gap-4 rounded-[11px] border border-line bg-surface px-4 py-3"
            >
              <span className="grid size-8 flex-none place-items-center rounded-sm bg-accent-soft text-accent-ink">
                <Icon name="trash" size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-semibold text-ink">{row.title}</div>
                <div className="mt-0.5 text-[12px] text-subtle">
                  Deleted {formatDistanceToNow(new Date(row.deletedAt), { addSuffix: true })}
                </div>
              </div>
              <Button
                type="button"
                variant="secondary"
                data-testid={`trash-restore-${row.id}`}
                disabled={restoring === row.id || purging === row.id}
                onClick={() => void onRestore(row)}
              >
                {restoring === row.id ? "Restoring…" : "Restore"}
              </Button>
              {canPurge(row) ? (
                <ConfirmDialog
                  trigger={
                    <Button
                      type="button"
                      variant="destructive"
                      data-testid={`trash-purge-${row.id}`}
                      disabled={restoring === row.id || purging === row.id}
                    >
                      {purging === row.id ? "Deleting…" : "Delete forever"}
                    </Button>
                  }
                  title={`Permanently delete “${row.title}”?`}
                  description="This removes the doc and all its versions, annotations, and comments from the database. It cannot be restored — this is permanent."
                  confirmLabel="Delete forever"
                  confirmTestId={`trash-purge-confirm-${row.id}`}
                  onConfirm={() => void onPurge(row)}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
