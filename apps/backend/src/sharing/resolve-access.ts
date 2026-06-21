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
//   - An ANONYMOUS caller has no userId, so `resolveDocRole` can't run. An anon may see
//     only an anyone_with_link doc (C-005), where they get the link role. Every other
//     general-access level denies anon (no role, no view) — existence-hiding upstream.

import { eq } from "drizzle-orm";
import { docs, shareLinks } from "../db/schema";
import type { DB } from "../db/client";
import type { Role } from "./roles";
import type { ShareRole } from "./share";
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
 * Anon path: only an anyone_with_link doc admits an anon, at the link's role (C-005).
 * Every other level (or a missing doc / missing link row) → denied.
 * User path: delegate to the authoritative `resolveDocRole`; a non-null role means view.
 */
export function createResolveAccess(
  db: DB,
  deps: ResolveAccessDeps,
): (docId: string, viewer: Viewer) => Promise<AccessResult> {
  return async (docId, viewer): Promise<AccessResult> => {
    if (viewer.kind === "anon") {
      // AS-004 / C-005: an anon may view ONLY an anyone_with_link doc, at the link role.
      const [doc] = await db
        .select({ generalAccess: docs.generalAccess })
        .from(docs)
        .where(eq(docs.id, docId))
        .limit(1);
      if (!doc || doc.generalAccess !== "anyone_with_link") return DENIED;
      // general_access = anyone_with_link IS the grant (AS-004/AS-010): anyone holding the
      // link may view. The share_links.role refines WHICH role; absent a row, default to
      // `viewer` (least-privilege admit) rather than failing closed — failing closed here
      // would contradict "anyone with the link can view" whenever no explicit link role row
      // has been written yet.
      const [link] = await db
        .select({ role: shareLinks.role, capabilityToken: shareLinks.capabilityToken })
        .from(shareLinks)
        .where(eq(shareLinks.docId, docId))
        .limit(1);

      // capability-share-link S-002 / C-006: when the anon carries a VALID admission cookie
      // for THIS doc (bound to its docId + minted from its CURRENT capability token), admit
      // at the COOKIE's link role. resolveAdmission does the cross-doc (AS-020) + stale-token
      // (AS-021) binding against the live token; a forged/garbage/doc-B/no cookie returns
      // null and falls through to the existing slug admit below. This is the production
      // consumer of resolveAdmission — it grants the cookie role on every anon-reachable
      // endpoint (the doc read AND the comment/resolve writes flow through this one gate).
      if (deps.secret && viewer.admissionCookie) {
        const claims = resolveAdmission(
          viewer.admissionCookie,
          docId,
          link?.capabilityToken ?? null,
          deps.secret,
        );
        if (claims) return { role: claims.role as Role, canView: true };
      }

      const role = (link ? (link.role as ShareRole) : "viewer") as Role;
      return { role, canView: true };
    }

    // Logged-in: the authoritative resolver decides (owner/invited/workspace/link),
    // scoped to the doc's OWN workspace (AS-005). No role → denied (AS-006).
    const role = await deps.resolveDocRole(docId, viewer.userId);
    return role !== null ? { role, canView: true } : DENIED;
  };
}
