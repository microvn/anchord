// Drizzle-backed ShareStateRepo (sharing S-006). THIN read glue for the share-state
// aggregator (share-state.ts readShareState): one read of docs.general_access, one of
// the doc's share_links row (role + toggles + link controls), and the doc_members
// people list. No business logic — shaping only.
//
// C-016 / AS-026: the password is read ONLY as the boolean `hasPassword`
// (password_hash != null). The raw hash is never SELECTed into the returned shape, so
// it cannot leak into the API response. The select on share_links deliberately omits
// password_hash except inside the != null derivation.
//
// Defaults mirror the gate/loader conventions: no share_links row yet → role "viewer"
// (the column default), editors_can_share ON (default), no password/expiry/view-limit,
// view_count 0 (matches createLoadShareConfig + setLinkControls). (No guest-commenting
// field — guest access is decided by the link role, sharing reversal 2026-06-20.)

import { eq } from "drizzle-orm";
import { shareLinks, docMembers, user } from "../db/schema";
import type { DB } from "../db/client";
import type { ShareStateRepo, ShareStateRow, SharePerson } from "./share-state";

/** Construct a ShareStateRepo backed by a Drizzle DB handle. */
export function createShareStateRepo(db: DB): ShareStateRepo {
  return {
    async readShareState(docId: string): Promise<ShareStateRow> {
      // doc-access-two-axis S-001: access lives entirely on the share_links row as the two
      // axes — there is no longer a docs.general_access column to read.
      // The share_links row carries both axes + toggles + link controls. Note:
      // password_hash is read here ONLY to derive the boolean — it is never propagated
      // past this function (C-016).
      const [link] = await db
        .select({
          workspaceRole: shareLinks.workspaceRole,
          linkRole: shareLinks.linkRole,
          editorsCanShare: shareLinks.editorsCanShare,
          passwordHash: shareLinks.passwordHash,
          expiresAt: shareLinks.expiresAt,
          viewLimit: shareLinks.viewLimit,
          viewCount: shareLinks.viewCount,
          // S-005: the capability token (the external /s/<token> link's secret). Set only while the
          // doc is anyone_with_link; null otherwise (capability-share-link C-001/C-004).
          capabilityToken: shareLinks.capabilityToken,
        })
        .from(shareLinks)
        .where(eq(shareLinks.docId, docId));

      // 3. The people list — every doc_members row (active + pending). Left-join the
      //    bound account to pick up its display name (active rows); a pending invite
      //    has no userId → no name. ONE query, no per-row N+1.
      const memberRows = await db
        .select({
          id: docMembers.id,
          email: docMembers.email,
          name: user.name,
          role: docMembers.role,
          status: docMembers.status,
        })
        .from(docMembers)
        .leftJoin(user, eq(docMembers.userId, user.id))
        .where(eq(docMembers.docId, docId));

      const people: SharePerson[] = memberRows.map((m) => ({
        id: m.id,
        email: m.email,
        ...(m.name ? { name: m.name } : {}),
        role: m.role,
        status: m.status,
      }));

      return {
        workspaceRole: link?.workspaceRole ?? null,
        linkRole: link?.linkRole ?? null,
        editorsCanShare: link?.editorsCanShare ?? true,
        people,
        link: {
          hasPassword: link?.passwordHash != null,
          expiresAt: link?.expiresAt ?? null,
          viewLimit: link?.viewLimit ?? null,
          viewCount: link?.viewCount ?? 0,
        },
        capabilityToken: link?.capabilityToken ?? null,
      };
    },
  };
}
