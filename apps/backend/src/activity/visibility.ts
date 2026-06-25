// The ONE shared activity visibility gate (workspace-activity S-002 / C-003).
//
// C-003 forbids four hand-written access filters across the four read surfaces (feed-list,
// filter-counts, detail-url, stats-rail). This module is that single gate: S-002 builds it and
// applies it to the feed-list + the single-event (detail-url) read; S-003 (counts) and S-007
// (stats) REUSE the SAME function so counts, the busiest-doc name, and the feed can never disagree.
//
// The rule (resolved at READ time against each doc's CURRENT access — NEVER frozen at emit time,
// F-2):
//   - ADMIN (workspace role admin/owner) → sees EVERY workspace event. No per-doc resolve.
//   - MEMBER → sees:
//       • every workspace-level event (docId IS NULL) — but ONLY while they are a CURRENT member
//         at read time (the requireWorkspaceMember gate proves this before this runs, F-14), AND
//       • doc-scoped events ONLY on docs they can access, where "can access" is the SAME
//         `resolveAccess` path the doc viewer uses (sharing/resolve-access.ts) — NOT re-derived
//         here. Under the shared-workspace model the workspace default is `anyone_in_workspace`, so
//         a member can access (and sees events on) MOST docs; the filter excludes only docs
//         explicitly set `restricted` that the member wasn't invited to.
//       • EXCEPTION — `doc_deleted` / `doc_restored` (doc-delete-trash S-006 / C-010): the doc is
//         tombstoned, so `resolveAccess` returns canView:false for EVERYONE (S-004) — keying on it
//         would hide the lifecycle event even from someone who held a role at delete time. So these
//         two route through `resolveLiveRole` (the deletion-IGNORING resolver) instead: a MEMBER
//         sees the row iff they are the actor OR hold a surviving role (owner / invite). A member
//         who never held a role does NOT (AS-032); admins still see it via the admin short-circuit.
//
// C-008 (read side): the doc-scoped gate is `resolveAccess`, which resolves membership against the
// doc's OWN workspace. A row whose stored workspaceId disagrees with the doc's real workspace can
// never surface — the access decision is anchored to the doc's real workspace, not the row's.
//
// resolveAccess is resolved per DISTINCT docId (a workspace feed page often repeats a few docs), so
// a page of N rows over K distinct docs costs K resolves, not N.

import type { WorkspaceRole } from "../http/auth-gate";
import type { AccessResult } from "../sharing/resolve-access";
import type { Role } from "../sharing/roles";
import type { Viewer } from "../sharing/access";
import type { ActivityType } from "./types";

// doc-delete-trash S-006 / C-010: the two soft-delete lifecycle events whose visibility CANNOT key
// on the deleted-aware `resolveAccess` (which now returns canView:false for EVERYONE once the doc is
// tombstoned — S-004). For these two, the rule is "actors who held a role at delete time PLUS
// workspace admins" — so they route through the LIVE (deletion-ignoring) role resolver instead.
const DELETE_LIFECYCLE_TYPES: ReadonlySet<ActivityType> = new Set<ActivityType>([
  "doc_deleted",
  "doc_restored",
]);

/** A row the gate decides on — only the fields the visibility decision needs. */
export interface VisibilityRow {
  docId: string | null;
  /**
   * doc-delete-trash S-006 / C-010: the event type, so the gate can special-case `doc_deleted` /
   * `doc_restored` (whose doc is tombstoned → `resolveAccess` refuses everyone). Optional so the
   * pre-S-006 callers / tests that pass `{ docId }` keep working — an absent type falls through to
   * the normal `resolveAccess` path unchanged.
   */
  type?: ActivityType;
  /**
   * doc-delete-trash S-006 / C-010: the row's actor. For a delete-lifecycle row, the actor who did
   * the delete/restore always sees their own row even though the doc is now tombstoned. Optional —
   * absent leaves the actor-arm off.
   */
  actorUserId?: string | null;
}

/** The viewer the gate decides for: their workspace role + their user id. */
export interface ActivityViewer {
  userId: string;
  role: WorkspaceRole;
}

/**
 * The injected doc-access resolver — the SAME `resolveAccess` the doc viewer / annotation routes
 * gate on (sharing/resolve-access.ts createResolveAccess). The gate calls it for doc-scoped rows
 * ONLY; it is NOT re-derived here (C-003). Optional so the S-001 foundation (no access dep) reads
 * the whole workspace log unchanged; prod ALWAYS wires it (index.ts) so the gate is real.
 */
export type ResolveDocAccess = (docId: string, viewer: Viewer) => Promise<AccessResult>;

/**
 * doc-delete-trash S-006 / C-010 — the DELETION-IGNORING role resolver (the same authoritative
 * `resolveDocRole` the access gate wraps, BEFORE the `deleted_at` chokepoint). It answers "would
 * this user hold a role on the doc if it weren't deleted" — i.e. did they hold one at delete time
 * (a surviving owner / invite grant). Used ONLY for `doc_deleted` / `doc_restored` rows, so a
 * prior-role-holder still sees the lifecycle event the deleted-aware `resolveAccess` would hide
 * from everyone (AS-032). A non-null role ⇒ visible. Optional: omitted (pre-S-006 wirings / tests)
 * means delete-lifecycle rows fall back to the normal `resolveAccess` path (admin/actor-only in
 * practice, since the doc is tombstoned).
 */
export type ResolveLiveRole = (docId: string, userId: string) => Promise<Role | null>;

export interface ActivityVisibility {
  /**
   * Keep only the rows `viewer` may see, in input order (recent-first preserved). Admins pass
   * through unchanged; members keep workspace-level rows (docId null) plus doc-scoped rows whose
   * doc `resolveAccess` admits at read time.
   */
  filterVisible<R extends VisibilityRow>(rows: R[], viewer: ActivityViewer): Promise<R[]>;
  /**
   * Whether `viewer` may see ONE row (the detail-url surface — AS-010/AS-030). True for an admin;
   * for a member true on a workspace-level row, else the doc's current `resolveAccess.canView`.
   * The detail route turns a `false` here into NOT-FOUND (existence-hiding), never forbidden.
   */
  canSee(row: VisibilityRow, viewer: ActivityViewer): Promise<boolean>;
}

/**
 * Build the single visibility gate. `resolveAccess` is the doc viewer's authoritative gate; when
 * omitted (S-001 foundation / tests that don't exercise visibility) every row is visible.
 */
export function createActivityVisibility(deps: {
  resolveAccess?: ResolveDocAccess;
  resolveLiveRole?: ResolveLiveRole;
}): ActivityVisibility {
  const { resolveAccess, resolveLiveRole } = deps;

  // doc-delete-trash S-006 / C-010: decide a `doc_deleted` / `doc_restored` row for a MEMBER. The
  // doc is tombstoned, so `resolveAccess` says canView:false for everyone — keying on it would hide
  // the lifecycle event even from someone who held a role at delete time. Instead: the row's ACTOR
  // always sees their own delete/restore, and anyone with a SURVIVING role (resolveLiveRole != null,
  // the deletion-ignoring resolver) is treated as having "had a role at delete time". A member with
  // no prior role resolves null → hidden (AS-032). Cached per distinct docId like the normal path.
  async function decideDeleteLifecycle(
    row: VisibilityRow,
    viewer: ActivityViewer,
    cache: Map<string, boolean>,
  ): Promise<boolean> {
    if (row.actorUserId != null && row.actorUserId === viewer.userId) return true;
    if (row.docId == null) return true; // a lifecycle row should always carry a docId; null = no doc to gate
    if (!resolveLiveRole) {
      // No live resolver wired: fall back to the deleted-aware gate (admin/actor only in practice).
      return resolveAccess ? (await resolveAccess(row.docId, { kind: "user", userId: viewer.userId })).canView : true;
    }
    const cacheKey = `live:${row.docId}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const role = await resolveLiveRole(row.docId, viewer.userId);
    const seen = role !== null;
    cache.set(cacheKey, seen);
    return seen;
  }

  // Decide one row. Admin → always. Workspace-level (docId null) → always (the member is a current
  // member, proven by requireWorkspaceMember upstream, F-14). A delete-lifecycle row → the prior-
  // role-holder rule (C-010, above). Otherwise doc-scoped → resolveAccess at READ time against the
  // doc's CURRENT access (F-2); no resolver wired → visible (foundation mode).
  async function decide(
    row: VisibilityRow,
    viewer: ActivityViewer,
    cache: Map<string, boolean>,
  ): Promise<boolean> {
    if (viewer.role === "admin") return true;
    if (row.docId == null) return true;
    if (row.type && DELETE_LIFECYCLE_TYPES.has(row.type)) {
      return decideDeleteLifecycle(row, viewer, cache);
    }
    if (!resolveAccess) return true;
    const cached = cache.get(row.docId);
    if (cached !== undefined) return cached;
    const { canView } = await resolveAccess(row.docId, { kind: "user", userId: viewer.userId });
    cache.set(row.docId, canView);
    return canView;
  }

  return {
    async filterVisible(rows, viewer) {
      if (viewer.role === "admin") return rows; // sees all — skip every per-doc resolve
      const cache = new Map<string, boolean>(); // one resolve per distinct docId per call
      const out: typeof rows = [];
      for (const row of rows) {
        if (await decide(row, viewer, cache)) out.push(row);
      }
      return out;
    },

    async canSee(row, viewer) {
      return decide(row, viewer, new Map());
    },
  };
}
