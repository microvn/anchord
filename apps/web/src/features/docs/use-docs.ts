import { useQuery } from "@tanstack/react-query";
import { toApiError, type ApiError } from "@/lib/api/api-error";
import { useApiQuery } from "@/lib/api/use-api-query";
import { unwrapEnvelope } from "@/features/workspaces/use-bootstrap";
import { queryKeys } from "@/features/workspaces/query-keys";
import { fetchProjects, fetchProjectDocs, searchDocs } from "./client";
import type { DocRow, ProjectRow, SearchResultRow } from "./types";

// Browse data hooks for the workspace-project surfaces. Keyed by workspaceId (GAP-001) so
// switching workspace never shows stale data. The backend exposes NO workspace-wide docs
// list — only per-project docs (GET …/projects/:id/docs) — so the "all docs" view is the
// UNION across the workspace's projects, joined to project names client-side. Doc counts
// per project fall out of the same fetch (length of each project's browse-visible docs).
//
// The simple reads go through useApiQuery (centralized error + session-expiry bounce). The
// composed workspace-docs fan-out can't use that single-thunk hook, so it normalizes errors
// with toApiError itself to keep the same ApiError surface.

interface ProjectsResult {
  projects: ProjectRow[];
}
interface ProjectDocsResult {
  docs: Pick<
    DocRow,
    "id" | "slug" | "title" | "kind" | "version" | "commentCount" | "authorName" | "status"
  >[];
}
interface SearchResult {
  results: SearchResultRow[];
}

/** GET …/projects — active projects in the workspace. */
export function useProjects(workspaceId: string) {
  return useApiQuery<ProjectRow[]>(queryKeys.projects(workspaceId), async () => {
    const res = unwrapEnvelope<ProjectsResult>(await fetchProjects(workspaceId));
    if (res.error) return { data: null, error: res.error };
    return { data: (res.data?.projects ?? []).filter((p) => !p.archived), error: null };
  });
}

/**
 * The Projects-browse view: the workspace's projects (active by default; ALL when
 * `includeArchived`), each annotated with its browse-visible doc count. Separate from
 * `useWorkspaceDocs` because the Projects screen needs archived projects on demand (the
 * "Show archived" toggle, S-002/AS-005) — `useWorkspaceDocs` always drops archived. Keyed on
 * `includeArchived` so toggling refetches the broadened list rather than reading a stale slice.
 */
export function useProjectsBrowse(workspaceId: string, includeArchived = false) {
  return useQuery<ProjectRow[], ApiError>({
    queryKey: [...queryKeys.projects(workspaceId), includeArchived ? "all" : "active"] as const,
    retry: (failureCount, error) => !error?.isUnauthenticated && failureCount < 1,
    queryFn: async (): Promise<ProjectRow[]> => {
      const projRes = unwrapEnvelope<ProjectsResult>(await fetchProjects(workspaceId, includeArchived));
      if (projRes.error) throw toApiError(projRes.error);
      const projects = projRes.data?.projects ?? [];
      const visible = includeArchived ? projects : projects.filter((p) => !p.archived);
      return Promise.all(
        visible.map(async (p) => {
          const docsRes = unwrapEnvelope<ProjectDocsResult>(
            await fetchProjectDocs(workspaceId, p.id),
          );
          if (docsRes.error) throw toApiError(docsRes.error);
          return { ...p, docCount: docsRes.data?.docs?.length ?? 0 };
        }),
      );
    },
  });
}

export interface WorkspaceDocs {
  /** Active projects, each annotated with its browse-visible doc count. */
  projects: ProjectRow[];
  /** Every browse-visible doc across the workspace, annotated with its project name. */
  docs: DocRow[];
}

/**
 * The workspace-wide docs view: fetch projects, then docs for each project, then join.
 * One composed query so the dashboard stat row + All-docs grid read a single cache slice
 * keyed by workspaceId. The per-project counts are derived here (no aggregate endpoint).
 */
export function useWorkspaceDocs(workspaceId: string) {
  return useQuery<WorkspaceDocs, ApiError>({
    queryKey: queryKeys.docs(workspaceId),
    retry: (failureCount, error) => !error?.isUnauthenticated && failureCount < 1,
    queryFn: async (): Promise<WorkspaceDocs> => {
      const projRes = unwrapEnvelope<ProjectsResult>(await fetchProjects(workspaceId));
      if (projRes.error) throw toApiError(projRes.error);
      const projects = (projRes.data?.projects ?? []).filter((p) => !p.archived);

      const perProject = await Promise.all(
        projects.map(async (p) => {
          const docsRes = unwrapEnvelope<ProjectDocsResult>(
            await fetchProjectDocs(workspaceId, p.id),
          );
          if (docsRes.error) throw toApiError(docsRes.error);
          const docs: DocRow[] = (docsRes.data?.docs ?? []).map((d) => ({
            ...d,
            projectId: p.id,
            projectName: p.name,
          }));
          return { project: { ...p, docCount: docs.length }, docs };
        }),
      );

      return {
        projects: perProject.map((x) => x.project),
        docs: perProject.flatMap((x) => x.docs),
      };
    },
  });
}

/**
 * GET …/search?q=&projectId= — runs only when q is non-empty. When `projectId` is set the
 * search is scoped to that project (the backend project-scopes + access-filters); undefined
 * broadens to the whole workspace (S-004 / AS-010, AS-011). The scope is part of the query key
 * so scoped vs whole-workspace are distinct cache entries.
 */
export function useSearch(workspaceId: string, q: string, projectId?: string) {
  const trimmed = q.trim();
  return useQuery<SearchResultRow[], ApiError>({
    queryKey: queryKeys.search(workspaceId, trimmed, projectId),
    enabled: trimmed.length > 0,
    retry: (failureCount, error) => !error?.isUnauthenticated && failureCount < 1,
    queryFn: async (): Promise<SearchResultRow[]> => {
      const res = unwrapEnvelope<SearchResult>(await searchDocs(workspaceId, trimmed, projectId));
      if (res.error) throw toApiError(res.error);
      return res.data?.results ?? [];
    },
  });
}
