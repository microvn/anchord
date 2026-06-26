import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toApiError } from "@/lib/api/api-error";
import { unwrapEnvelope } from "@/features/workspaces/hooks/use-bootstrap";
import { queryKeys } from "@/features/workspaces/lib/query-keys";
import { setProjectVisibility } from "@/features/docs/services/client";
import type { ProjectRow, ProjectVisibility } from "@/features/docs/types";

// project-visibility-fe S-001 / AS-002 / AS-005 / C-003. The project-visibility toggle as a React
// Query mutation so the badge updates OPTIMISTICALLY, the authoritative refetch settles the value,
// and a rejected/failed toggle ROLLS BACK to the prior visibility — the server stays the authority
// (C-003: the `canToggleVisibility` flag is an affordance, not the gate). `isPending` disables the
// toggle while a request is in flight so no two toggles race (AS-002).
//
// The optimistic write patches EVERY cached projects list for this workspace — the browse key
// (`[…projects, "active"|"all"]`) and the picker key (`[…projects]`) all hang off the
// `queryKeys.projects(workspaceId)` prefix. The updater guards `Array.isArray` because the same
// prefix also matches the per-project doc view (`[…projects, id, "docs"]`), whose payload is an
// object, not a `ProjectRow[]` — those are left untouched.

export interface ToggleVisibilityVars {
  projectId: string;
  /** The visibility to switch TO (the opposite of the project's current value). */
  next: ProjectVisibility;
}

interface ToggleContext {
  /** Snapshot of every matching projects cache entry, for rollback on error (AS-005). */
  prev: [readonly unknown[], ProjectRow[] | undefined][];
}

export function useToggleProjectVisibility(workspaceId: string) {
  const queryClient = useQueryClient();
  const projectsKey = queryKeys.projects(workspaceId);

  return useMutation<unknown, Error, ToggleVisibilityVars, ToggleContext>({
    mutationFn: async ({ projectId, next }) => {
      const res = unwrapEnvelope(await setProjectVisibility(workspaceId, projectId, next));
      if (res.error) throw toApiError(res.error);
      return res.data;
    },
    onMutate: async ({ projectId, next }) => {
      // Stop in-flight refetches clobbering the optimistic value before the mutation resolves.
      await queryClient.cancelQueries({ queryKey: projectsKey });
      const prev = queryClient.getQueriesData<ProjectRow[]>({ queryKey: projectsKey });
      queryClient.setQueriesData<ProjectRow[]>({ queryKey: projectsKey }, (old) =>
        Array.isArray(old)
          ? old.map((p) => (p.id === projectId ? { ...p, visibility: next } : p))
          : old,
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      // Roll the optimistic badge back to the server's last-known value (AS-005) — the badge never
      // sticks on a value the server didn't accept.
      ctx?.prev.forEach(([key, data]) => queryClient.setQueryData(key, data));
    },
    onSettled: () => {
      // Authoritative refetch settles the final value (success) or confirms the rollback (error).
      void queryClient.invalidateQueries({ queryKey: projectsKey });
    },
  });
}
