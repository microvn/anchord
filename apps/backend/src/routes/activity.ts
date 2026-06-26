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
import { eq, inArray } from "drizzle-orm";
import { apiEnvelope } from "../http/envelope";
import { requireSession, requireWorkspaceMember, type SessionResolver, type WorkspaceRoleResolver, type WorkspaceScope } from "../http/auth-gate";
import { NotFoundError } from "../http/errors";
import { paginationQuery, paginate, type PaginationParams } from "../http/pagination";
import { docs, projects } from "../db/schema";
import { createActivityRepo, type ActivityRepo, type ActivityRow } from "../activity/repo";
import {
  createActivityVisibility,
  type ResolveDocAccess,
  type ResolveLiveRole,
  type ResolveProjectVisibility,
} from "../activity/visibility";
import { countByCategory, filterByCategory, isActivityCategory } from "../activity/category";
import { computeStats } from "../activity/stats";
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
  /**
   * doc-delete-trash S-006 / C-010: the deletion-IGNORING role resolver (the authoritative
   * `resolveDocRole`, before the `deleted_at` chokepoint). The visibility gate uses it for
   * `doc_deleted` / `doc_restored` rows so a member who HELD a role at delete time still sees the
   * lifecycle event, while a member with no prior role does not (AS-032) — the deleted-aware
   * `resolveAccess` would hide it from both. Optional: omitted leaves delete-lifecycle rows on the
   * admin/actor-only fallback.
   */
  resolveLiveRole?: ResolveLiveRole;
  /**
   * project-visibility S-006 / C-010: resolves a PROJECT's visibility + owner so the gate can hide a
   * PRIVATE project's project-level events from non-owners (admins included). Used only for
   * project-level rows (`docId == null && projectId != null`). Optional: omitted leaves project-level
   * rows on the legacy "doc-less ⇒ visible" rule; prod ALWAYS wires it (index.ts).
   */
  resolveProjectVisibility?: ResolveProjectVisibility;
  /**
   * workspace-activity S-004: resolves a doc-scoped event's CURRENT doc link target — the slug the
   * viewer is addressed by (`/d/:slug`) plus the project name — so the detail page's "Open doc"
   * deep-link can be built. Resolved at READ time; a DELETED doc returns null, and "Open doc"
   * degrades gracefully (C-001 / AS-018). Optional: omitted (pre-S-004 tests / foundation) leaves
   * `docSlug`/`projectName` null.
   */
  resolveDocLink?: ResolveDocLink;
}

/** The S-004 doc-link resolver: a live docId → its viewer slug (+ project name), or null if the doc
 *  was deleted (the "Open doc" link then degrades, AS-018). */
export type ResolveDocLink = (
  docId: string,
) => Promise<{ slug: string; projectName?: string } | null>;

export function activityRoutes(deps: ActivityRoutesDeps) {
  const repo: ActivityRepo =
    deps.repo ??
    (() => {
      if (!deps.db) throw new Error("activityRoutes requires either `repo` or `db`");
      return createActivityRepo(deps.db);
    })();

  // The ONE shared visibility gate (C-003). The feed-list + the single-event read both route
  // through it; S-003 (counts) and S-007 (stats) reuse the SAME instance — never a parallel filter.
  const visibility = createActivityVisibility({
    resolveAccess: deps.resolveAccess,
    resolveLiveRole: deps.resolveLiveRole,
    resolveProjectVisibility: deps.resolveProjectVisibility,
  });

  return apiEnvelope(new Elysia())
    .use(requireSession({ resolveSession: deps.resolveSession }))
    .use(requireWorkspaceMember({ resolveWorkspaceRole: deps.resolveWorkspaceRole }))
    // GET /api/w/:workspaceId/activity — the workspace's recent events, newest-first, paginated.
    // C-007: default 20 / cap 50. C-003: gated through the shared visibility filter BEFORE paging.
    .get("/api/w/:workspaceId/activity", async (ctx) => {
      const { params, query } = ctx;
      const { actor, ws } = scope(ctx);
      const page = activityPage.parse(query) as PaginationParams;
      // S-003: optional category filter (All / Comments / Versions / Sharing / People). An unknown
      // or absent value falls back to "all" — the filter is a UI narrowing, never an error.
      const category = isActivityCategory(query.category) ? query.category : "all";
      const filter = { workspaceId: params.workspaceId };
      // C-003 / F-7: filter the WHOLE log by per-doc visibility ONCE through the shared gate, THEN
      // derive both the counts and the page from that SAME visible set — so a count can never reveal
      // an event the viewer can't see, and `total` and the page can never disagree (F-STATS, AS-012).
      const all = await repo.listAllActivity(filter);
      const visible = await visibility.filterVisible(all, { userId: actor.userId, role: ws.role });
      // S-003: per-category counts are over the full visible set (NOT the category-filtered set) so
      // every segment shows its own visible count regardless of which filter is active (AS-012).
      const counts = countByCategory(visible);
      // The page is the category-filtered visible set, sliced (AS-011); `total` is that filtered
      // length so pagination matches the rows actually shown.
      const matching = filterByCategory(visible, category);
      const offset = (page.page - 1) * page.limit;
      const items = matching.slice(offset, offset + page.limit);
      // Enrich JUST the page (≤ limit rows) with the doc title + project name so each row renders
      // "… in <doc>" + the doc/project chips like the prototype. A bounded 2-query batch, not a join
      // on the full-log scan above. Workspace-level rows (no docId/projectId) resolve to null.
      const enriched = await enrichRows(deps.db, items);
      // `counts` (per-category, over the visible set) + the active `category` ride alongside the
      // standard {items, pagination} so the FE renders the segment with counts without a 2nd request.
      return { ...paginate(enriched, { page: page.page, limit: page.limit, total: matching.length }), counts, category };
    })
    // GET /api/w/:workspaceId/activity/stats — the stats rail (S-007). The FOURTH surface that MUST
    // route through the SAME shared visibility gate (C-003/F-7): load the whole workspace log, filter
    // it through `visibility.filterVisible` FIRST, THEN aggregate over that visible set. So a member's
    // recent-event counts AND the "busiest doc" name can never include a doc they can't open (AS-028);
    // an admin's rail covers every workspace event (same aggregator, wider visible set). All three
    // aggregates cover a trailing 7-day window (C-006/AS-026) — `computeStats` windows + aggregates.
    // Registered BEFORE the `:eventId` route so the static `/stats` segment is never read as an id.
    .get("/api/w/:workspaceId/activity/stats", async (ctx) => {
      const { params } = ctx;
      const { actor, ws } = scope(ctx);
      const filter = { workspaceId: params.workspaceId };
      const all = await repo.listAllActivity(filter);
      const visible = await visibility.filterVisible(all, { userId: actor.userId, role: ws.role });
      // GAP-001 (deferred): per-viewer filtered aggregates cost a full visible-set load + in-process
      // aggregate on every request — the SAME shape the feed already uses; no cache/cap in v0.
      const stats = computeStats(visible);
      // The busiest-doc NAME must be the doc's TITLE, not the row `target` (which now carries the
      // comment's section/anchor, e.g. "§ Sanitization"). Resolve the title at read time (one query).
      if (stats.busiestDoc && deps.db) {
        const [doc] = await deps.db.select({ title: docs.title }).from(docs).where(eq(docs.id, stats.busiestDoc.docId)).limit(1);
        if (doc) stats.busiestDoc = { ...stats.busiestDoc, name: doc.title };
      }
      return stats;
    })
    // GET /api/w/:workspaceId/activity/:eventId — one event's row (the detail-url surface, S-002 +
    // S-004). C-003 / AS-010: an event the viewer can't see returns NOT-FOUND (existence-hiding),
    // never forbidden — indistinguishable from a non-existent / cross-workspace id. S-004 enriches
    // the row with the CURRENT doc slug (+ project name) so the detail page's "Open doc" deep-link
    // can be built; a deleted doc resolves to null and "Open doc" degrades (AS-018).
    .get("/api/w/:workspaceId/activity/:eventId", async (ctx) => {
      const { params } = ctx;
      const { actor, ws } = scope(ctx);
      const filter = { workspaceId: params.workspaceId };
      const event = await repo.getActivityById(filter, params.eventId);
      if (!event) throw new NotFoundError();
      const canSee = await visibility.canSee(event, { userId: actor.userId, role: ws.role });
      if (!canSee) throw new NotFoundError(); // AS-010/AS-030: hide existence, not 403
      // S-004 / AS-014: resolve the live doc link for "Open doc". docId null (workspace-level) or a
      // deleted doc (resolver → null) both yield a null slug, and the FE degrades the button (AS-018).
      let docSlug: string | null = null;
      let projectName: string | null = null;
      let docTitle: string | null = null;
      if (event.docId != null && deps.resolveDocLink) {
        const link = await deps.resolveDocLink(event.docId);
        docSlug = link?.slug ?? null;
        projectName = link?.projectName ?? null;
      }
      // The doc TITLE for the detail's "Document" row + the "… in <doc>" sentence (target now carries
      // the section/anchor, not the doc name). One read-time lookup; a deleted doc resolves to null.
      if (event.docId != null && deps.db) {
        const [doc] = await deps.db.select({ title: docs.title }).from(docs).where(eq(docs.id, event.docId)).limit(1);
        docTitle = doc?.title ?? null;
      }
      return { event: { ...event, docSlug, projectName, docTitle } };
    })
    // GET /api/w/:workspaceId/activity/:eventId/related — "More on this doc" (S-004). Other events on
    // the SAME doc as :eventId, recent-first, capped at 5, EXCLUDING the viewed event. Gated through
    // the SAME visibility filter (C-003) so related rows are access-filtered exactly like the feed;
    // the event must itself be visible first (else NOT-FOUND, existence-hiding — a member can't probe
    // a doc they can't access). A workspace-level event (docId null) has no "this doc" → empty list.
    .get("/api/w/:workspaceId/activity/:eventId/related", async (ctx) => {
      const { params } = ctx;
      const { actor, ws } = scope(ctx);
      const viewer = { userId: actor.userId, role: ws.role };
      const filter = { workspaceId: params.workspaceId };
      const event = await repo.getActivityById(filter, params.eventId);
      if (!event) throw new NotFoundError();
      if (!(await visibility.canSee(event, viewer))) throw new NotFoundError();
      if (event.docId == null) return { items: [] }; // workspace-level event — no "this doc"
      const related = await repo.listRelatedByDoc(filter, event.docId, { excludeId: event.id, limit: 5 });
      // C-003 / F-7: same gate as the feed-list — never a second hand-written access filter.
      const items = await visibility.filterVisible(related, viewer);
      return { items };
    });
}

/** Read the gates' injected context (actor from requireSession, ws from requireWorkspaceMember). */
function scope(ctx: unknown): { actor: Actor; ws: WorkspaceScope } {
  const c = ctx as { actor: Actor; ws: WorkspaceScope };
  return { actor: c.actor, ws: c.ws };
}

/** A read row plus the doc title + project name resolved at READ time for the feed's chips/sentence. */
type EnrichedRow = ActivityRow & { docTitle: string | null; projectName: string | null };

/**
 * Batch-resolve the doc title + project name for a page of rows (≤ page limit). Two `IN (...)`
 * queries, not a join on the full-log scan — bounded per request. Without `db` (tests that inject a
 * pre-built repo) the rows pass through unchanged (the FE renders without the extra chips). A deleted
 * doc/project simply resolves to null (the row survives — C-001), so "Open doc"/chips degrade.
 */
async function enrichRows(db: DB | undefined, rows: ActivityRow[]): Promise<EnrichedRow[]> {
  const base = rows.map((r) => ({ ...r, docTitle: null as string | null, projectName: null as string | null }));
  if (!db || base.length === 0) return base;
  const docIds = [...new Set(base.map((r) => r.docId).filter((x): x is string => x != null))];
  const projIds = [...new Set(base.map((r) => r.projectId).filter((x): x is string => x != null))];
  const titleOf = new Map<string, string>();
  const nameOf = new Map<string, string>();
  if (docIds.length) {
    for (const d of await db.select({ id: docs.id, title: docs.title }).from(docs).where(inArray(docs.id, docIds)))
      titleOf.set(d.id, d.title);
  }
  if (projIds.length) {
    for (const p of await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, projIds)))
      nameOf.set(p.id, p.name);
  }
  return base.map((r) => ({
    ...r,
    docTitle: r.docId ? (titleOf.get(r.docId) ?? null) : null,
    projectName: r.projectId ? (nameOf.get(r.projectId) ?? null) : null,
  }));
}
