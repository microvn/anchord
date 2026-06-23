// HTTP route mount for the workspace activity feed READ surface (workspace-activity S-001).
//
// WORKSPACE-scoped under /api/w/:workspaceId/activity — gated by requireSession +
// requireWorkspaceMember (a non-member 404s, existence-hiding). The earlier emit sites WRITE
// activity rows; this reads them back for the feed.
//
// Contract:
//   GET /api/w/:workspaceId/activity?page=&limit=  → 200 { items, pagination }  recent-first (C-007)
//
// C-007: paginated recent-first, default 20 per page, cap 50. The server returns a FLAT recent-first
// list; day-grouping is CLIENT-SIDE in the viewer's timezone (a day may straddle a page boundary).
//
// S-001 does NOT apply the per-doc access filter — the feed is the whole workspace log scoped to
// :workspaceId. The role/access visibility gate (admins-all / members-filtered-by-doc-access) is
// S-002 (C-003); this story lays the foundation it builds on.

import { Elysia } from "elysia";
import { apiEnvelope } from "../http/envelope";
import { requireSession, requireWorkspaceMember, type SessionResolver, type WorkspaceRoleResolver } from "../http/auth-gate";
import { paginationQuery, paginate, type PaginationParams } from "../http/pagination";
import { createActivityRepo, type ActivityRepo } from "../activity/repo";
import type { DB } from "../db/client";

// Feed page size: default 20, cap 50 (C-007).
const activityPage = paginationQuery({ defaultLimit: 20, maxLimit: 50 });

export interface ActivityRoutesDeps {
  db?: DB;
  /** Pre-built read repo (tests). Wins over `db`. */
  repo?: ActivityRepo;
  resolveSession: SessionResolver;
  /** workspaces S-006: resolves the caller's role in :workspaceId for the path-scoped gate. */
  resolveWorkspaceRole: WorkspaceRoleResolver;
}

export function activityRoutes(deps: ActivityRoutesDeps) {
  const repo: ActivityRepo =
    deps.repo ??
    (() => {
      if (!deps.db) throw new Error("activityRoutes requires either `repo` or `db`");
      return createActivityRepo(deps.db);
    })();

  return apiEnvelope(new Elysia())
    .use(requireSession({ resolveSession: deps.resolveSession }))
    .use(requireWorkspaceMember({ resolveWorkspaceRole: deps.resolveWorkspaceRole }))
    // GET /api/w/:workspaceId/activity — the workspace's recent events, newest-first, paginated.
    // C-007: default 20 / cap 50. The flat list is day-grouped client-side (viewer TZ).
    .get("/api/w/:workspaceId/activity", async ({ params, query }) => {
      const page = activityPage.parse(query) as PaginationParams;
      const filter = { workspaceId: params.workspaceId };
      const total = await repo.countActivity(filter);
      const items = await repo.listActivity(filter, {
        offset: (page.page - 1) * page.limit,
        limit: page.limit,
      });
      return paginate(items, { page: page.page, limit: page.limit, total });
    });
}
