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
//
// C-008 (read side): the doc-scoped gate is `resolveAccess`, which resolves membership against the
// doc's OWN workspace. A row whose stored workspaceId disagrees with the doc's real workspace can
// never surface — the access decision is anchored to the doc's real workspace, not the row's.
//
// resolveAccess is resolved per DISTINCT docId (a workspace feed page often repeats a few docs), so
// a page of N rows over K distinct docs costs K resolves, not N.

import type { WorkspaceRole } from "../http/auth-gate";
import type { AccessResult } from "../sharing/resolve-access";
import type { Viewer } from "../sharing/access";

/** A row the gate decides on — only the fields the visibility decision needs. */
export interface VisibilityRow {
  docId: string | null;
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
export function createActivityVisibility(deps: { resolveAccess?: ResolveDocAccess }): ActivityVisibility {
  const { resolveAccess } = deps;

  // Decide one row. Admin → always. Workspace-level (docId null) → always (the member is a current
  // member, proven by requireWorkspaceMember upstream, F-14). Doc-scoped → resolveAccess at READ
  // time against the doc's CURRENT access (F-2); no resolver wired → visible (foundation mode).
  async function decide(
    row: VisibilityRow,
    viewer: ActivityViewer,
    cache: Map<string, boolean>,
  ): Promise<boolean> {
    if (viewer.role === "admin") return true;
    if (row.docId == null) return true;
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
