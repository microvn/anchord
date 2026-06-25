// Viewer identity for the access decision (sharing S-002, doc-access-two-axis S-004).
//
// doc-access-two-axis S-004 / C-010: the standalone level-switching `canViewDoc` is RETIRED.
// There is now ONE access decision — `createResolveAccess` (resolve-access.ts) — which folds
// owner + invite + the two share_links axes (workspace_role + link_role) and the capped anon
// admission. Every doc-centric route (doc read, annotation read/write, version read, AND the
// share-management read gate in routes/sharing.ts) gates on that single resolver, so no
// parallel decision can disagree with it. What remains in this module is the shared `Viewer`
// shape every gate speaks, plus the re-export of the derived `GeneralAccessLevel` summary.

// GeneralAccessLevel is a DERIVED summary (doc-access-two-axis S-001 / C-008) — the
// docs.general_access enum is dropped. The canonical type lives in derive-level.ts.
import type { GeneralAccessLevel } from "./derive-level";
export type { GeneralAccessLevel };

/** Who is asking to view: an anonymous (logged-out) session, or a logged-in user.
 *  An anon MAY carry the raw capability admission cookie value (capability-share-link
 *  S-002 / C-006) — the signed grant minted by the redeem route. When present, the access
 *  gate validates it (resolveAdmission) against the doc's CURRENT capability token and, on
 *  success, admits the anon at the cookie's link role on EVERY anon-reachable endpoint. */
export type Viewer =
  | { kind: "anon"; admissionCookie?: string | null }
  | { kind: "user"; userId: string };
