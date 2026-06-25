// doc-access-routing S-001 — the SINGLE authoritative access gate.
//
// `resolveAccess(docId, viewer)` decides "can this viewer see this doc, and at what
// role" in ONE place, and is applied on EVERY doc-centric route (doc read, annotation
// read + write, version read, content). It REPLACES the permissive sync `canViewDoc`
// stubs (index.ts wired `isInvited: () => true, isWorkspaceMember: () => true`) whose
// only real wall was the requireWorkspaceMember middleware.
//
// It is the most-permissive of {owner, invited role, workspace role when
// anyone_in_workspace, link role when anyone_with_link} — always resolved against the
// doc's OWN workspace (C-003). A doc with no project has no workspace, so the
// anyone_in_workspace path grants it nothing (C-011, fail-closed).
//
// Layering (why this wraps `resolveDocRole`):
//   - A LOGGED-IN caller's role is the authoritative async `resolveDocRole` — it
//     already folds owner + active invited doc_members + link-role-when-admitted, and
//     resolves anyone_in_workspace against the doc's own workspace (the cross-tenant
//     guard, AS-005). So for a user, canView ⇔ resolveDocRole returns SOME role.
//   - An ANONYMOUS caller has no userId, so `resolveDocRole` can't run. After
//     capability-share-link S-003 (C-002) an anon reaches an anyone_with_link doc ONLY via a
//     valid capability admission cookie (minted at /s/<token> redeem, S-002) — knowing the
//     readable /d/:slug address is no longer enough. Without that cookie the anon is denied at
//     every general-access level (no role, no view) — existence-hiding upstream.

import { eq } from "drizzle-orm";
import { shareLinks } from "../db/schema";
import type { DB } from "../db/client";
import { capAnonRole, type Role } from "./roles";
import type { Viewer } from "./access";
import { resolveAdmission } from "./capability-cookie";

/** The single access decision every doc-centric route gates on. */
export interface AccessResult {
  /** The viewer's effective role on this doc, or `null` when no source grants one. */
  role: Role | null;
  /** Whether the viewer may view the doc at all (⇔ `role !== null`). */
  canView: boolean;
}

/** No-access result — least privilege, the existence-hiding default. */
const DENIED: AccessResult = { role: null, canView: false };

export interface ResolveAccessDeps {
  /**
   * The authoritative LOGGED-IN role resolver (resolve-doc-role-repo's
   * createResolveDocRole): folds owner + invited + link + workspace against the doc's
   * OWN workspace. `null` → no source grants a role.
   */
  resolveDocRole: (docId: string, userId: string) => Promise<Role | null>;
  /**
   * capability-share-link S-002 / C-006: APP_SECRET, used to verify the anon admission
   * cookie against the doc's CURRENT capability token (resolveAdmission). Optional — when
   * omitted (or no cookie is presented) the anon path falls back to the existing
   * anyone_with_link-by-slug admit. Wiring this is purely ADDITIVE: a VALID admission cookie
   * grants the cookie's link role on every anon-reachable endpoint; it never removes the
   * pre-existing slug admit (that tightening is S-003).
   */
  secret?: string;
}

/**
 * Build the single authoritative `resolveAccess(docId, viewer)` gate.
 *
 * Anon path (capability-share-link S-003 / C-002): an anon is admitted to an anyone_with_link
 * doc ONLY with a valid capability admission cookie (bound to this doc + its current token), at
 * the cookie's link role. No cookie (or any other general-access level / missing doc) → denied —
 * the readable /d/:slug address is no longer an anonymous entry point.
 * User path: delegate to the authoritative `resolveDocRole`; a non-null role means view.
 */
export function createResolveAccess(
  db: DB,
  deps: ResolveAccessDeps,
): (docId: string, viewer: Viewer) => Promise<AccessResult> {
  return async (docId, viewer): Promise<AccessResult> => {
    if (viewer.kind === "anon") {
      // capability-share-link S-003 / C-002: the readable /d/:slug address NO LONGER admits an
      // anon just because the doc is anyone_with_link. An anonymous visitor reaches an
      // anyone_with_link doc ONLY through a valid capability admission cookie (the path S-002
      // minted at /s/<token> redeem). The old "admit-by-slug" branch is GONE (AS-007): knowing
      // the readable address is not enough. (Before S-003 an anon with no cookie was admitted
      // here whenever generalAccess === "anyone_with_link"; that is the behaviour this story
      // removes — see resolve-access.test.ts AS-007 for the boundary regression test.)
      // doc-access-two-axis S-001 stopgap: the dropped docs.general_access is derived from
      // the link axis — an anon can only reach a doc whose link axis is ON (link_role set,
      // i.e. derived level anyone_with_link).
      const [linkAxis] = await db
        .select({ linkRole: shareLinks.linkRole })
        .from(shareLinks)
        .where(eq(shareLinks.docId, docId))
        .limit(1);
      if (!linkAxis || linkAxis.linkRole == null) return DENIED;

      // capability-share-link S-002 / C-006: the ONLY anon admit now. When the anon carries a
      // VALID admission cookie for THIS doc (bound to its docId + minted from its CURRENT
      // capability token), admit at the COOKIE's link role. resolveAdmission does the cross-doc
      // (AS-020) + stale-token (AS-021) binding against the live token; a forged/garbage/doc-B/
      // no cookie returns null → DENIED (no slug fallback any more). This is the production
      // consumer of resolveAdmission — it grants the cookie role on every anon-reachable
      // endpoint (the doc read AND the comment/resolve writes flow through this one gate).
      if (deps.secret && viewer.admissionCookie) {
        const [link] = await db
          .select({ capabilityToken: shareLinks.capabilityToken })
          .from(shareLinks)
          .where(eq(shareLinks.docId, docId))
          .limit(1);
        const claims = resolveAdmission(
          viewer.admissionCookie,
          docId,
          link?.capabilityToken ?? null,
          deps.secret,
        );
        if (claims) {
          // doc-access-two-axis S-003 / C-004 — THE GUEST CAP SEAM. A no-account guest is
          // never allowed to edit: clamp the admitted link role to AT MOST commenter here,
          // at the single anonymous-admission seam, BEFORE returning. Because every anon-
          // reachable surface (doc read, comment, resolve, version publish) resolves access
          // through this one branch, capping here means no write route ever sees a guest as
          // editor — the cap is inherited, not re-implemented per route. We clamp at READ
          // time (not at cookie mint) so a link_role lowered after a cookie was minted still
          // caps correctly, and the ceiling never depends on stale cookie state.
          return { role: capAnonRole(claims.role as Role), canView: true };
        }
      }

      // No valid admission cookie → the anon is refused at the readable address (AS-007 / C-002).
      return DENIED;
    }

    // Logged-in: the authoritative resolver decides (owner/invited/workspace/link),
    // scoped to the doc's OWN workspace (AS-005). No role → denied (AS-006).
    const role = await deps.resolveDocRole(docId, viewer.userId);
    return role !== null ? { role, canView: true } : DENIED;
  };
}
