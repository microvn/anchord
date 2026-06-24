// HTTP route mount for the personal "Your actions" feed (your-activity-actions S-001).
//
// ACCOUNT-scoped under /api/me/activity — gated by requireSession ALONE (no /api/w/:workspaceId
// path). It is the caller's OWN cross-workspace history: every row's actor IS the session user.
//
// Contract:
//   GET /api/me/activity?page=&limit=  → 200 { items, pagination }  recent-first (C-003)
//
// C-001 (no IDOR): the actor filter is ALWAYS actor.userId from the session — a query/path
// `actorUserId` is IGNORED (the read takes only the session id). A null-actor (System/guest) row
// never matches (the read is an equality on the caller's id). C-006: only rows in workspaces the
// caller is a CURRENT member of (the read's workspace_members inner join) — a left workspace drops.
//
// C-002 (read-time genericize, DIFFERS from the workspace feed): the workspace feed DROPS a row the
// member can't see; here the caller's OWN row ALWAYS lists (it is their history) — instead, when
// `resolveAccess` denies the row's target doc at read time, every target-DERIVED display field
// (docTitle / projectName / target / docSlug → "Open in doc") is nulled/genericized so the row
// never exposes current content/structure the caller can no longer access (AS-006). C-007: the FE
// reuses workspace-activity's feed/row/detail components — this route just serves the rows.

import { Elysia } from "elysia";
import { eq, inArray } from "drizzle-orm";
import { apiEnvelope } from "../http/envelope";
import { requireSession, type SessionResolver } from "../http/auth-gate";
import { paginationQuery, paginate, type PaginationParams } from "../http/pagination";
import { docs, projects } from "../db/schema";
import {
  createActorActivityRepo,
  type ActorActivityRepo,
  type ActorActivityRow,
} from "../activity/list-for-actor";
import type { ResolveDocAccess } from "../activity/visibility";
import type { DB } from "../db/client";

// Feed page size: default 20, cap 50 — mirrors the workspace feed (C-003 / workspace-activity C-007).
const activityPage = paginationQuery({ defaultLimit: 20, maxLimit: 50 });

/** The non-revealing placeholder a lost-access row's doc title degrades to (AS-006 / C-002). */
export const LOST_ACCESS_PLACEHOLDER = "a document you no longer have access to";

export interface MeActivityRoutesDeps {
  db?: DB;
  /** Pre-built read repo (tests). Wins over `db`. */
  repo?: ActorActivityRepo;
  resolveSession: SessionResolver;
  /**
   * The doc viewer's authoritative access gate (sharing/resolve-access.ts createResolveAccess) — the
   * SAME resolver the workspace feed + doc viewer use. C-002: for a doc-scoped own-action row, a
   * `canView: false` here does NOT drop the row (it's the caller's history) — it genericizes the
   * row's target-derived display. Optional: omitted (tests with no access dep) leaves every row's
   * doc fields enriched as-is; prod ALWAYS wires it.
   */
  resolveAccess?: ResolveDocAccess;
}

/** A served row: the actor read row plus the read-time doc title + project name (or genericized). */
type ServedRow = ActorActivityRow & { docTitle: string | null; projectName: string | null };

export function meActivityRoutes(deps: MeActivityRoutesDeps) {
  const repo: ActorActivityRepo =
    deps.repo ??
    (() => {
      if (!deps.db) throw new Error("meActivityRoutes requires either `repo` or `db`");
      return createActorActivityRepo(deps.db);
    })();

  return apiEnvelope(new Elysia())
    .use(requireSession({ resolveSession: deps.resolveSession }))
    // GET /api/me/activity — the caller's own actions across their current workspaces, newest-first.
    // C-001: scoped to actor.userId (session) — a `?actorUserId=other` is never read. C-003: paged.
    .get("/api/me/activity", async ({ query, actor }) => {
      const page = activityPage.parse(query) as PaginationParams;
      const offset = (page.page - 1) * page.limit;
      const [total, rows] = await Promise.all([
        repo.countForActor(actor.userId),
        repo.listForActor(actor.userId, { offset, limit: page.limit }),
      ]);
      // Enrich the page with doc title + project name (a bounded 2-query batch over ≤ limit rows),
      // then genericize any row whose target doc the caller can no longer access (C-002 / AS-006).
      const enriched = await enrichRows(deps.db, rows);
      const served = await genericizeLostAccess(enriched, actor.userId, deps.resolveAccess);
      return paginate(served, { page: page.page, limit: page.limit, total });
    });
}

/**
 * Batch-resolve doc title + project name for a page of rows (≤ page limit). Two `IN (...)` queries,
 * not a join on the full scan — bounded per request. Without `db` (tests injecting a pre-built repo)
 * the rows pass through with null enrichment. A deleted doc/project resolves to null.
 */
async function enrichRows(db: DB | undefined, rows: ActorActivityRow[]): Promise<ServedRow[]> {
  const base: ServedRow[] = rows.map((r) => ({ ...r, docTitle: null, projectName: null }));
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

/**
 * C-002 / AS-006: for each DOC-scoped row, resolve the caller's CURRENT access at read time. When
 * access is DENIED the row STILL LISTS (the caller's own history is never dropped — this is the key
 * difference from the workspace feed), but every target-derived display field is genericized so the
 * row can't expose current content/structure: docTitle → the placeholder, and projectName / target /
 * the `meta.quote` body are nulled. Workspace-level rows (no docId) and an absent resolver pass
 * through unchanged. resolveAccess is resolved per DISTINCT docId (one resolve per doc per page).
 */
async function genericizeLostAccess(
  rows: ServedRow[],
  userId: string,
  resolveAccess: ResolveDocAccess | undefined,
): Promise<ServedRow[]> {
  if (!resolveAccess) return rows;
  const access = new Map<string, boolean>();
  const out: ServedRow[] = [];
  for (const r of rows) {
    if (r.docId == null) {
      out.push(r);
      continue;
    }
    let canView = access.get(r.docId);
    if (canView === undefined) {
      const res = await resolveAccess(r.docId, { kind: "user", userId });
      canView = res.canView;
      access.set(r.docId, canView);
    }
    if (canView) {
      out.push(r);
      continue;
    }
    // Lost access: keep the row (action type + when + workspace label survive), genericize every
    // target-derived display field so no current content/structure leaks (AS-006).
    out.push({
      ...r,
      docTitle: LOST_ACCESS_PLACEHOLDER,
      projectName: null,
      target: null,
      // C-002: drop the slug so the reused detail's "Open in doc" degrades to the disabled span
      // (openDocHref → null) — a lost-access row never deep-links into a doc the caller can't open.
      docSlug: null,
      meta: stripDocDerivedMeta(r.meta),
    });
  }
  return out;
}

/** Drop the body/quote from a lost-access row's meta — the version diff counts (publish) stay, but
 *  any quoted/annotated current content is removed (AS-006). NULL-safe. */
function stripDocDerivedMeta(meta: unknown): unknown {
  if (meta == null || typeof meta !== "object") return meta;
  const { quote: _quote, body: _body, ...rest } = meta as Record<string, unknown>;
  return rest;
}
