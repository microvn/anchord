// Access decision (sharing S-002): given a doc's general-access level and who is
// asking, decide whether they may VIEW the doc. This is the core read-gate that the
// /d/:slug route (render-publish / versioning-diff) and annotation-core both consume
// before serving any content.
//
// AS-004: anyone_with_link → a logged-out (anon) person can view.
// AS-006: restricted → only an invited user (or the owner) gets in; anon/uninvited
//         are denied with a CLEAN deny (allowed:false, no content) — the route serves
//         the "You do not have access" page; we assert the boolean here, the no-leak
//         route behaviour is integration-verified-later.
// AS-015: anyone_in_workspace → only a logged-in workspace MEMBER; anon → denied,
//         non-member user → denied.
// C-009:  the three levels are strictly ordered by who they admit —
//         restricted (invitees only) < anyone_in_workspace (every logged-in member,
//         no anon/outsiders) < anyone_with_link (includes anon/outsiders).
//
// Pure logic + injectable ports, mirroring share.ts. The concrete membership/invite
// lookups land in later stories (see the deps seams below); here the DECISION logic is
// unit-testable without a DB.

import type { generalAccess } from "../db/schema";

/** General-access level — mirrors docs.general_access (render-publish owns the enum). */
export type GeneralAccessLevel = (typeof generalAccess.enumValues)[number];

/** Who is asking to view: an anonymous (logged-out) session, or a logged-in user.
 *  An anon MAY carry the raw capability admission cookie value (capability-share-link
 *  S-002 / C-006) — the signed grant minted by the redeem route. When present, the access
 *  gate validates it (resolveAdmission) against the doc's CURRENT capability token and, on
 *  success, admits the anon at the cookie's link role on EVERY anon-reachable endpoint. */
export type Viewer =
  | { kind: "anon"; admissionCookie?: string | null }
  | { kind: "user"; userId: string };

/**
 * Injectable lookups the decision needs. Both are ports so the decision logic is
 * testable in isolation; the concrete implementations land in later stories:
 */
export interface AccessDeps {
  /** True if userId is individually invited to (or owns) this doc.
   *  SEAM: concrete impl lands in S-003 (doc_members). */
  isInvited(docId: string, userId: string): boolean;
  /** True if userId is a member of the doc's workspace.
   *  SEAM: concrete impl lands in workspace-project. */
  isWorkspaceMember(userId: string): boolean;
}

/** Reason a view was denied — for logging/telemetry, NOT shown to the viewer (no leak). */
export type DenyReason =
  | "restricted_not_invited"
  | "workspace_not_member"
  | "anon_not_allowed";

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; reason: DenyReason };

export interface CanViewDocArgs {
  docId: string;
  generalAccess: GeneralAccessLevel;
  viewer: Viewer;
  deps: AccessDeps;
}

/**
 * Decide whether `viewer` may view the doc at the given general-access level.
 *
 * Rules (C-009 ordering — restricted < anyone_in_workspace < anyone_with_link):
 *   - anyone_with_link → allowed for anon AND any user (AS-004).
 *   - anyone_in_workspace → allowed ONLY for a logged-in user who isWorkspaceMember
 *     (AS-015); anon denied, non-member user denied.
 *   - restricted → allowed ONLY for an invited user / owner (AS-006); anon and
 *     uninvited users denied.
 *
 * A deny is a clean `{ allowed:false, reason }` — the function never returns content;
 * the route is responsible for serving the not-access page (integration).
 */
export function canViewDoc(args: CanViewDocArgs): AccessDecision {
  const { docId, generalAccess, viewer, deps } = args;

  switch (generalAccess) {
    case "anyone_with_link":
      // AS-004: open to everyone, including anon.
      return { allowed: true };

    case "anyone_in_workspace":
      // AS-015: logged-in workspace members only. Anon never qualifies.
      if (viewer.kind === "anon") {
        return { allowed: false, reason: "anon_not_allowed" };
      }
      return deps.isWorkspaceMember(viewer.userId)
        ? { allowed: true }
        : { allowed: false, reason: "workspace_not_member" };

    case "restricted":
      // AS-006: invitees (or owner) only. Anon never qualifies — clean deny, no leak.
      if (viewer.kind === "anon") {
        return { allowed: false, reason: "anon_not_allowed" };
      }
      return deps.isInvited(docId, viewer.userId)
        ? { allowed: true }
        : { allowed: false, reason: "restricted_not_invited" };
  }
}
