// Concrete doc-scoped role resolver + share-config reader (sharing-permissions).
//
// These CLOSE the two interim seams the earlier route clusters left in index.ts:
//   - createResolveDocRole(db): the real `resolveDocRole(docId, userId) → Role|null`
//     the versioning-diff + annotation-core routes (and these sharing routes) gate on.
//     It resolves the LOGGED-IN caller's EFFECTIVE role (roles.ts effectiveRole — highest
//     wins, C-005) by folding every source that grants this user access to this doc
//     (doc-access-two-axis S-003):
//       · invited roles    → ACTIVE doc_members rows for the user (real).
//       · workspace_role   → share_links.workspace_role, when the caller is a member of
//                            THIS doc's OWN workspace (C-002 cross-tenant guard).
//       · link_role        → share_links.link_role, contributed to any logged-in caller
//                            who reaches the doc (C-005). The anon guest cap (C-004) is
//                            NOT applied here — it lives at the anon seam (resolve-access).
//       · owner            → an `isOwner(docId,userId)` SUB-PORT — the remaining seam.
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

/**
 * Workspace-membership read for the link-role source on `anyone_in_workspace`.
 * workspaces S-006/C-002 (AS-019/AS-020): SCOPED to the DOC — the concrete impl resolves
 * the doc's OWN workspace (docs.project_id → projects.workspace_id) and checks membership
 * THERE, so a member of workspace B never gets anyone_in_workspace access to a doc in A.
 */
export type IsWorkspaceMember = (docId: string, userId: string) => boolean | Promise<boolean>;

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

    // ── the two access axes (doc-access-two-axis S-003 / C-005) ──
    // Effective role folds BOTH axes independently, highest wins (effectiveRole):
    //   · workspace_role → contributed when the caller is a member of THIS doc's OWN
    //     workspace (C-002 — the cross-tenant guard; a member of another workspace never
    //     gets it). `null` = the doc is not shared with the workspace.
    //   · link_role → contributed to any LOGGED-IN caller who reaches the doc (C-005:
    //     "link_role when the caller holds the link"). `null` = no public link.
    // Both are folded, not just one: a doc shared with the workspace AND link-shared
    // contributes both sources so the higher wins (AS-010). The anon guest cap (C-004) is
    // NOT here — it lives at the anonymous-admission seam (resolve-access), since this
    // resolver only ever runs for a logged-in user.
    const [link] = await db
      .select({
        workspaceRole: shareLinks.workspaceRole,
        linkRole: shareLinks.linkRole,
      })
      .from(shareLinks)
      .where(eq(shareLinks.docId, docId));
    if (link) {
      if (link.linkRole != null) {
        sources.push(link.linkRole as ShareRole as Role);
      }
      if (link.workspaceRole != null && (await isWorkspaceMember(docId, userId))) {
        sources.push(link.workspaceRole as ShareRole as Role);
      }
    }

    // ── owner: the remaining seam (sub-port; prod false until auth wires ownership) ──
    if (await deps.isOwner(docId, userId)) sources.push("owner");

    return sources.length ? effectiveRole(sources) : null;
  };
}

/**
 * Build the concrete `loadShareConfig`. Reads the doc's share_links row for the
 * per-doc toggle the sharing routes gate on:
 *   - editors_can_share (C-015) → the sharing routes' manage-sharing gate; no row →
 *     ON (the default — editors can share until an owner turns it off; a doc with no
 *     share_links row yet behaves as the default-on column would).
 *
 * NOTE (sharing reversal 2026-06-20): the guest-commenting toggle is GONE (Google-Docs
 * model — an anon comments via the link role, no separate flag). The `share_links`
 * `guest_commenting` column is left in place (dropping it needs a migration) but is no
 * longer read or written anywhere.
 */
export function createLoadShareConfig(
  db: DB,
): (docId: string) => Promise<{ editorsCanShare: boolean }> {
  return async (docId: string) => {
    const [row] = await db
      .select({
        editorsCanShare: shareLinks.editorsCanShare,
      })
      .from(shareLinks)
      .where(eq(shareLinks.docId, docId));
    return {
      editorsCanShare: row?.editorsCanShare ?? true,
    };
  };
}
