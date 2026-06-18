import { useQuery } from "@tanstack/react-query";
import { toApiError, type ApiError } from "@/lib/api/api-error";
import { useApiQuery } from "@/lib/api/use-api-query";
import { unwrapEnvelope } from "@/features/workspaces/hooks/use-bootstrap";
import { queryKeys } from "@/features/workspaces/lib/query-keys";
import { fetchProjects, fetchProjectDocs, searchDocs } from "@/features/docs/services/client";
import type { DocRow, ProjectRow, SearchResultRow } from "@/features/docs/types";

// Browse data hooks for the workspace-project surfaces. Keyed by workspaceId (GAP-001) so
// switching workspace never shows stale data. The backend exposes NO workspace-wide docs
// list — only per-project docs (GET …/projects/:id/docs) — so the "all docs" view is the
// UNION across the workspace's projects, joined to project names client-side. Doc counts
// per project fall out of the same fetch (the pagination total, or the page length when the
// endpoint returns no pagination block).
//
// S-008 pagination: the three list endpoints now return a `pagination` envelope alongside their
// domain key. The numbered browse control is page-state lifted in each SCREEN; here we (a) keep
// the AGGREGATION consumers whole — `useWorkspaceDocs`/`useProjects`/`useProjectsBrowse` must read
// the COMPLETE set (page through `hasNext`), not the first 20, or counts shrink — and (b) expose
// a per-page search read for the search screen's server-side paging.
//
// The simple reads go through useApiQuery (centralized error + session-expiry bounce). The
// composed workspace-docs fan-out can't use that single-thunk hook, so it normalizes errors
// with toApiError itself to keep the same ApiError surface.

/** The pagination envelope the backend adds alongside the domain key (`docs`/`projects`/`results`). */
export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

interface ProjectsResult {
  projects: ProjectRow[];
  pagination?: PaginationMeta;
}
interface ProjectDocsResult {
  docs: Pick<
    DocRow,
    | "id"
    | "slug"
    | "title"
    | "kind"
    | "version"
    | "annotationCount"
    | "authorName"
    | "status"
    | "generalAccess"
    | "createdAt"
    | "updatedAt"
  >[];
  pagination?: PaginationMeta;
}
interface SearchResult {
  results: SearchResultRow[];
  pagination?: PaginationMeta;
}

/** Fixed browse page size — 20 (C-007). Projects browse fills its 3-col grid via the
 *  New-project tile (20 + tile = 21 = 7 rows); search is server-paginated. */
export const BROWSE_PAGE_SIZE = 20;
/** Doc grid page size — 18, a multiple of BOTH grid column counts (3-col → 6 rows, 2-col →
 *  9 rows) so a full page leaves NO trailing empty cell (the doc grid has no New-doc tile to
 *  round out the last row the way the projects grid does). Client-side slice only — the
 *  workspace doc union is already fully fetched, so this changes display paging, not any read. */
export const DOCS_PAGE_SIZE = 18;
/** Server-side search page size (same fixed size, C-007). */
export const SEARCH_PAGE_SIZE = 20;

/** Page size requested when paging through a list to read its COMPLETE set (the backend caps at
 *  100; the aggregation reads must not inherit the 20-row default). */
const COMPLETE_SET_LIMIT = 100;
/** Safety bound so a server that always reports `hasNext` can't loop forever. */
const MAX_PAGES = 100;

/**
 * Read the COMPLETE access-filtered set from a paginated list endpoint by following `hasNext`.
 * `getPage(page, limit)` returns the already-envelope-unwrapped `{ items, pagination? }`. A reply
 * with no `pagination` block is treated as one complete page (so a non-paginated/mocked endpoint
 * passes through unchanged). Returns both the accumulated items and the accessible total (the
 * pagination total when present, else the item count) — counts read this total, never a page slice.
 */
async function fetchAllPages<T>(
  getPage: (page: number, limit: number) => Promise<{ items: T[]; pagination?: PaginationMeta }>,
): Promise<{ items: T[]; total: number }> {
  const all: T[] = [];
  let total: number | undefined;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { items, pagination } = await getPage(page, COMPLETE_SET_LIMIT);
    all.push(...(items ?? []));
    total = pagination?.total;
    if (!pagination?.hasNext) break;
  }
  return { items: all, total: total ?? all.length };
}

/** GET …/projects — active projects in the workspace (COMPLETE set: the picker + scope control
 *  need every project, not a page). */
export function useProjects(workspaceId: string) {
  return useApiQuery<ProjectRow[]>(queryKeys.projects(workspaceId), async () => {
    try {
      const { items } = await fetchAllPages<ProjectRow>(async (page, limit) => {
        const res = unwrapEnvelope<ProjectsResult>(
          await fetchProjects(workspaceId, false, page, limit),
        );
        if (res.error) throw toApiError(res.error);
        return { items: res.data?.projects ?? [], pagination: res.data?.pagination };
      });
      return { data: items.filter((p) => !p.archived), error: null };
    } catch (thrown) {
      return { data: null, error: thrown };
    }
  });
}

/** A project annotated with its browse-visible doc count, derived from the per-project docs read's
 *  pagination total (or the doc count when the endpoint returns no pagination block). The doc
 *  payload itself is discarded — only the access-filtered total is needed for the card stat. */
async function projectWithCount(workspaceId: string, p: ProjectRow): Promise<ProjectRow> {
  // limit:1 — we only need `pagination.total`, not the docs (cheap when paginated). When the
  // endpoint returns no pagination block (legacy/mock), fall back to the returned doc count.
  const docsRes = unwrapEnvelope<ProjectDocsResult>(await fetchProjectDocs(workspaceId, p.id, 1, 1));
  if (docsRes.error) throw toApiError(docsRes.error);
  const docCount = docsRes.data?.pagination?.total ?? docsRes.data?.docs?.length ?? 0;
  return { ...p, docCount };
}

/**
 * The Projects-browse view: the workspace's projects (active by default; ALL when
 * `includeArchived`), each annotated with its browse-visible doc count. Returns the COMPLETE
 * projects list (the screen paginates it client-side, S-008) — separate from `useWorkspaceDocs`
 * because the Projects screen needs archived projects on demand (the "Show archived" toggle,
 * S-002/AS-005). Keyed on `includeArchived` so toggling refetches the broadened list.
 */
export function useProjectsBrowse(workspaceId: string, includeArchived = false) {
  return useQuery<ProjectRow[], ApiError>({
    queryKey: [...queryKeys.projects(workspaceId), includeArchived ? "all" : "active"] as const,
    retry: (failureCount, error) => !error?.isUnauthenticated && failureCount < 1,
    queryFn: async (): Promise<ProjectRow[]> => {
      const { items } = await fetchAllPages<ProjectRow>(async (page, limit) => {
        const res = unwrapEnvelope<ProjectsResult>(
          await fetchProjects(workspaceId, includeArchived, page, limit),
        );
        if (res.error) throw toApiError(res.error);
        return { items: res.data?.projects ?? [], pagination: res.data?.pagination };
      });
      const visible = includeArchived ? items : items.filter((p) => !p.archived);
      return Promise.all(visible.map((p) => projectWithCount(workspaceId, p)));
    },
  });
}

/** The per-project doc browse (workspace-project-browse S-001): one project + its COMPLETE
 *  access-filtered doc set. `project` is undefined when the id resolves to no accessible project. */
export interface ProjectDocsView {
  project: ProjectRow | undefined;
  docs: DocRow[];
}

/**
 * One project's docs, for the per-project browse view (`/w/:workspaceId/projects/:id`). Reads the
 * project (for its name) and its COMPLETE access-filtered doc set (page through `hasNext`, like the
 * other aggregation reads — the screen paginates client-side, S-001/AS-003). Includes archived
 * projects when resolving the NAME (the card you clicked may be archived), but the doc set is
 * whatever the backend lists as accessible. Keyed by workspaceId + projectId.
 */
export function useProjectDocs(workspaceId: string, projectId: string) {
  return useQuery<ProjectDocsView, ApiError>({
    queryKey: [...queryKeys.docs(workspaceId), "project", projectId] as const,
    enabled: !!projectId,
    retry: (failureCount, error) => !error?.isUnauthenticated && failureCount < 1,
    queryFn: async (): Promise<ProjectDocsView> => {
      // Resolve the project name (include archived so a clicked archived card still names it).
      const { items: projectList } = await fetchAllPages<ProjectRow>(async (page, limit) => {
        const res = unwrapEnvelope<ProjectsResult>(await fetchProjects(workspaceId, true, page, limit));
        if (res.error) throw toApiError(res.error);
        return { items: res.data?.projects ?? [], pagination: res.data?.pagination };
      });
      const found = projectList.find((p) => p.id === projectId);
      const { items, total } = await fetchAllPages<ProjectDocsResult["docs"][number]>(
        async (page, limit) => {
          const res = unwrapEnvelope<ProjectDocsResult>(
            await fetchProjectDocs(workspaceId, projectId, page, limit),
          );
          if (res.error) throw toApiError(res.error);
          return { items: res.data?.docs ?? [], pagination: res.data?.pagination };
        },
      );
      const docs: DocRow[] = items.map((d) => ({
        ...d,
        projectId,
        projectName: found?.name,
      }));
      return { project: found ? { ...found, docCount: total } : undefined, docs };
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
 * The workspace-wide docs view: fetch projects, then the COMPLETE docs for each project, then join.
 * One composed query so the dashboard stat row + All-docs grid read a single cache slice keyed by
 * workspaceId. The All-docs screen paginates this complete union client-side (S-008); the sidebar
 * and home tile read its counts, so this must stay the COMPLETE set (page through `hasNext`), never
 * a 20-row first page. Per-project counts are derived here from each project's accessible total.
 */
export function useWorkspaceDocs(workspaceId: string) {
  return useQuery<WorkspaceDocs, ApiError>({
    queryKey: queryKeys.docs(workspaceId),
    retry: (failureCount, error) => !error?.isUnauthenticated && failureCount < 1,
    queryFn: async (): Promise<WorkspaceDocs> => {
      const { items: projects } = await fetchAllPages<ProjectRow>(async (page, limit) => {
        const res = unwrapEnvelope<ProjectsResult>(await fetchProjects(workspaceId, false, page, limit));
        if (res.error) throw toApiError(res.error);
        return { items: res.data?.projects ?? [], pagination: res.data?.pagination };
      });
      const active = projects.filter((p) => !p.archived);

      const perProject = await Promise.all(
        active.map(async (p) => {
          const { items, total } = await fetchAllPages<ProjectDocsResult["docs"][number]>(
            async (page, limit) => {
              const res = unwrapEnvelope<ProjectDocsResult>(
                await fetchProjectDocs(workspaceId, p.id, page, limit),
              );
              if (res.error) throw toApiError(res.error);
              return { items: res.data?.docs ?? [], pagination: res.data?.pagination };
            },
          );
          const docs: DocRow[] = items.map((d) => ({
            ...d,
            projectId: p.id,
            projectName: p.name,
          }));
          return { project: { ...p, docCount: total }, docs };
        }),
      );

      return {
        projects: perProject.map((x) => x.project),
        docs: perProject.flatMap((x) => x.docs),
      };
    },
  });
}

/** What the search screen consumes: one page of results plus its pagination meta (S-008). */
export interface SearchPage {
  results: SearchResultRow[];
  pagination?: PaginationMeta;
}

/**
 * GET …/search?q=&projectId=&page=&limit= — runs only when q is non-empty. When `projectId` is set
 * the search is scoped to that project; undefined broadens to the whole workspace (S-004 /
 * AS-010, AS-011). S-008: paginated server-side — `page` is part of the query key, so each page is
 * its own cache entry and switching scope/query resets to page 1 (the screen owns the page state).
 */
export function useSearch(workspaceId: string, q: string, projectId?: string, page = 1) {
  const trimmed = q.trim();
  return useQuery<SearchPage, ApiError>({
    queryKey: [...queryKeys.search(workspaceId, trimmed, projectId), "page", page] as const,
    enabled: trimmed.length > 0,
    retry: (failureCount, error) => !error?.isUnauthenticated && failureCount < 1,
    queryFn: async (): Promise<SearchPage> => {
      const res = unwrapEnvelope<SearchResult>(
        await searchDocs(workspaceId, trimmed, projectId, page, SEARCH_PAGE_SIZE),
      );
      if (res.error) throw toApiError(res.error);
      return { results: res.data?.results ?? [], pagination: res.data?.pagination };
    },
  });
}
