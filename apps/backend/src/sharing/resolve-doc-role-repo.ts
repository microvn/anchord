// Concrete doc-scoped role resolver + share-config reader (sharing-permissions).
//
// These CLOSE the two interim seams the earlier route clusters left in index.ts:
//   - createResolveDocRole(db): the real `resolveDocRole(docId, userId) → Role|null`
//     the versioning-diff + annotation-core routes (and these sharing routes) gate on.
//     It resolves the caller's EFFECTIVE role (roles.ts effectiveRole — highest wins,
//     C-002/AS-013) across the sources that are resolvable today:
//       · invited roles  → ACTIVE doc_members rows for the user (real).
//       · link role       → share_links.role, granted when general-access lets this
//                           user in via the link (anyone_with_link → always;
//                           anyone_in_workspace → if a workspace member) (real).
//       · owner           → an `isOwner(docId,userId)` SUB-PORT — the remaining seam.
//     No source → `null` (no doc-scoped role → least privilege at the call site).
//   - createLoadShareConfig(db): reads share_links.guest_commenting (annotation-core's
//     guest-comment seam). Missing row → OFF.
//
// OWNER-SOURCE SEAM (flagged, NOT faked): `docs` has no owner column and
// doc_versions.published_by is currently written null (auth seam), so "is this user
// the owner" is NOT resolvable yet. We DO NOT fake owner=true (that would make every
// caller an owner). The concrete resolver takes `isOwner` as a sub-port; prod wires
// it to a conservative `() => false` until the auth cluster adds the ownership column
// (then this single closure flips to read it). Tests inject `isOwner` to act as owner.

import { eq } from "drizzle-orm";
import { docs, shareLinks } from "../db/schema";
import type { DB } from "../db/client";
import { effectiveRole, type Role } from "./roles";
import type { ShareRole } from "./share";
import type { GeneralAccessLevel } from "./access";
import { activeRolesFor } from "./doc-member-repo";

/** The owner-source port: does `userId` own `docId`? See the header note. */
export type IsOwner = (docId: string, userId: string) => Promise<boolean>;

/**
 * Concrete owner-source read (auth-routes S-002, C-003): the doc owner = the user whose
 * id matches `docs.owner_id` (recorded at publish by S-001). This CLOSES the seam
 * `index.ts` wired to `async () => false`: a real `isOwner` so the owner's effective role
 * folds to `owner` (highest wins) on every access decision (AS-003/AS-005). A missing doc
 * or a null `owner_id` (an ownerless seed) → false (no one owns it).
 */
export function createIsDocOwner(db: DB): IsOwner {
  return async (docId: string, userId: string): Promise<boolean> => {
    const [doc] = await db
      .select({ ownerId: docs.ownerId })
      .from(docs)
      .where(eq(docs.id, docId));
    return doc?.ownerId != null && doc.ownerId === userId;
  };
}

/** Workspace-membership read for the link-role source on `anyone_in_workspace`. */
export type IsWorkspaceMember = (userId: string) => boolean | Promise<boolean>;

export interface ResolveDocRoleDeps {
  /** Owner-source sub-port — the flagged seam. Prod: `() => false` until auth lands. */
  isOwner: IsOwner;
  /** Whether the user is a workspace member (gates the link role on anyone_in_workspace). */
  isWorkspaceMember?: IsWorkspaceMember;
}

/**
 * Build the concrete `resolveDocRole`. Gathers every role SOURCE that grants this
 * user access to this doc and returns the highest (effectiveRole). Returns `null`
 * when no source grants any role — the call site treats that as least privilege.
 */
export function createResolveDocRole(
  db: DB,
  deps: ResolveDocRoleDeps,
): (docId: string, userId: string) => Promise<Role | null> {
  const isWorkspaceMember = deps.isWorkspaceMember ?? (() => false);

  return async (docId: string, userId: string): Promise<Role | null> => {
    const sources: Role[] = [];

    // ── invited roles: ACTIVE doc_members rows for this user (real) ──
    const invited = await activeRolesFor(db, docId, userId);
    for (const r of invited) sources.push(r as Role);

    // ── link role: share_links.role, when general-access admits this user via the link ──
    const [doc] = await db
      .select({ generalAccess: docs.generalAccess })
      .from(docs)
      .where(eq(docs.id, docId));
    if (doc) {
      const linkAdmits = await generalAccessAdmits(doc.generalAccess, userId, isWorkspaceMember);
      if (linkAdmits) {
        const [link] = await db
          .select({ role: shareLinks.role })
          .from(shareLinks)
          .where(eq(shareLinks.docId, docId));
        if (link) sources.push(link.role as ShareRole as Role);
      }
    }

    // ── owner: the remaining seam (sub-port; prod false until auth wires ownership) ──
    if (await deps.isOwner(docId, userId)) sources.push("owner");

    return sources.length ? effectiveRole(sources) : null;
  };
}

/** Whether the doc's general-access level admits this user via the link role source. */
async function generalAccessAdmits(
  level: GeneralAccessLevel,
  userId: string,
  isWorkspaceMember: IsWorkspaceMember,
): Promise<boolean> {
  switch (level) {
    case "anyone_with_link":
      return true; // the link grants its role to anyone holding it.
    case "anyone_in_workspace":
      return await isWorkspaceMember(userId);
    case "restricted":
      return false; // a restricted doc grants nothing via the link.
  }
}

/**
 * Build the concrete `loadShareConfig`. Reads the doc's share_links row for the two
 * per-doc toggles the route clusters gate on:
 *   - guest_commenting → annotation-core's guest-comment seam; no row → OFF.
 *   - editors_can_share (C-015) → the sharing routes' manage-sharing gate; no row →
 *     ON (the default — editors can share until an owner turns it off; a doc with no
 *     share_links row yet behaves as the default-on column would).
 */
export function createLoadShareConfig(
  db: DB,
): (docId: string) => Promise<{ guestCommentingEnabled: boolean; editorsCanShare: boolean }> {
  return async (docId: string) => {
    const [row] = await db
      .select({
        guestCommenting: shareLinks.guestCommenting,
        editorsCanShare: shareLinks.editorsCanShare,
      })
      .from(shareLinks)
      .where(eq(shareLinks.docId, docId));
    return {
      guestCommentingEnabled: row?.guestCommenting ?? false,
      editorsCanShare: row?.editorsCanShare ?? true,
    };
  };
}
