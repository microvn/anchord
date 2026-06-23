// HTTP route mount for the workspace activity feed READ surface (workspace-activity S-001 + S-002).
//
// WORKSPACE-scoped under /api/w/:workspaceId/activity — gated by requireSession +
// requireWorkspaceMember (a non-member 404s, existence-hiding). The earlier emit sites WRITE
// activity rows; this reads them back for the feed.
//
// Contract:
//   GET /api/w/:workspaceId/activity?page=&limit=  → 200 { items, pagination }  recent-first (C-007)
//   GET /api/w/:workspaceId/activity/:eventId       → 200 { event } | 404         single event (S-002)
//
// C-007: paginated recent-first, default 20 per page, cap 50. The server returns a FLAT recent-first
// list; day-grouping is CLIENT-SIDE in the viewer's timezone (a day may straddle a page boundary).
//
// S-002 / C-003: every read here is role- and access-gated through ONE shared visibility query-
// builder (createActivityVisibility) — admins see all; members see workspace-level events plus
// doc-scoped events on docs they can access via the SAME resolveAccess path the doc viewer uses
// (resolved at READ time, never frozen at emit time, F-2). The feed-list FILTERS the whole workspace
// log through the gate BEFORE paging (so `total` is the count of VISIBLE rows), and the single-event
// read returns NOT-FOUND when the gate hides the row (existence-hiding, never forbidden — AS-010).
// C-008 (read side): the gate's doc check is resolveAccess, anchored to the doc's OWN workspace, so a
// row whose stored workspaceId disagrees with the doc's real workspace can never surface.

import { Elysia } from "elysia";
import { apiEnvelope } from "../http/envelope";
import { requireSession, requireWorkspaceMember, type SessionResolver, type WorkspaceRoleResolver, type WorkspaceScope } from "../http/auth-gate";
import { NotFoundError } from "../http/errors";
import { paginationQuery, paginate, type PaginationParams } from "../http/pagination";
import { createActivityRepo, type ActivityRepo } from "../activity/repo";
import { createActivityVisibility, type ResolveDocAccess } from "../activity/visibility";
import type { DB } from "../db/client";
import type { Actor } from "../http/auth-gate";

// Feed page size: default 20, cap 50 (C-007).
const activityPage = paginationQuery({ defaultLimit: 20, maxLimit: 50 });

export interface ActivityRoutesDeps {
  db?: DB;
  /** Pre-built read repo (tests). Wins over `db`. */
  repo?: ActivityRepo;
  resolveSession: SessionResolver;
  /** workspaces S-006: resolves the caller's role in :workspaceId for the path-scoped gate. */
  resolveWorkspaceRole: WorkspaceRoleResolver;
  /**
   * workspace-activity S-002 / C-003: the doc viewer's authoritative access gate
   * (sharing/resolve-access.ts createResolveAccess). The visibility filter calls it for doc-scoped
   * rows so a member never sees an event on a doc they can't open. Optional — omitted (S-001
   * foundation / pre-S-002 tests) means the whole workspace log is visible; prod ALWAYS wires it.
   */
  resolveAccess?: ResolveDocAccess;
}

export function activityRoutes(deps: ActivityRoutesDeps) {
  const repo: ActivityRepo =
    deps.repo ??
    (() => {
      if (!deps.db) throw new Error("activityRoutes requires either `repo` or `db`");
      return createActivityRepo(deps.db);
    })();

  // The ONE shared visibility gate (C-003). The feed-list + the single-event read both route
  // through it; S-003 (counts) and S-007 (stats) reuse the SAME instance — never a parallel filter.
  const visibility = createActivityVisibility({ resolveAccess: deps.resolveAccess });

  return apiEnvelope(new Elysia())
    .use(requireSession({ resolveSession: deps.resolveSession }))
    .use(requireWorkspaceMember({ resolveWorkspaceRole: deps.resolveWorkspaceRole }))
    // GET /api/w/:workspaceId/activity — the workspace's recent events, newest-first, paginated.
    // C-007: default 20 / cap 50. C-003: gated through the shared visibility filter BEFORE paging.
    .get("/api/w/:workspaceId/activity", async (ctx) => {
      const { params, query } = ctx;
      const { actor, ws } = scope(ctx);
      const page = activityPage.parse(query) as PaginationParams;
      const filter = { workspaceId: params.workspaceId };
      // C-003: filter the WHOLE log by per-doc visibility first, THEN page — so `total` and the
      // page can never disagree (a count of 15 with only 12 visible rows is impossible, F-STATS).
      const all = await repo.listAllActivity(filter);
      const visible = await visibility.filterVisible(all, { userId: actor.userId, role: ws.role });
      const offset = (page.page - 1) * page.limit;
      const items = visible.slice(offset, offset + page.limit);
      return paginate(items, { page: page.page, limit: page.limit, total: visible.length });
    })
    // GET /api/w/:workspaceId/activity/:eventId — one event's row (the detail-url surface, S-002).
    // C-003 / AS-010: an event the viewer can't see returns NOT-FOUND (existence-hiding), never
    // forbidden — indistinguishable from a non-existent / cross-workspace id.
    .get("/api/w/:workspaceId/activity/:eventId", async (ctx) => {
      const { params } = ctx;
      const { actor, ws } = scope(ctx);
      const filter = { workspaceId: params.workspaceId };
      const event = await repo.getActivityById(filter, params.eventId);
      if (!event) throw new NotFoundError();
      const canSee = await visibility.canSee(event, { userId: actor.userId, role: ws.role });
      if (!canSee) throw new NotFoundError(); // AS-010/AS-030: hide existence, not 403
      return { event };
    });
}

/** Read the gates' injected context (actor from requireSession, ws from requireWorkspaceMember). */
function scope(ctx: unknown): { actor: Actor; ws: WorkspaceScope } {
  const c = ctx as { actor: Actor; ws: WorkspaceScope };
  return { actor: c.actor, ws: c.ws };
}
