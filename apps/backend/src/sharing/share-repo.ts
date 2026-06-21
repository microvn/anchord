// Drizzle-backed ShareRepo (sharing S-001). THIN glue between the share service
// (share.ts setGeneralAccess — the C-003/role guards) and Postgres. No business
// logic lives here: validation already ran in the service before this is called.
//
// One write touches TWO places, atomically (one transaction):
//   - docs.general_access = level (the access LEVEL lives on the doc row).
//   - the doc's single share_links row (role) — upserted on the unique docId
//     (C-001: one general-access config per doc, never a second row).
// The link controls (password/expiry/view-limit, S-004) attach to the SAME row but
// are untouched here (only role + the level), per C-001.

import { and, eq } from "drizzle-orm";
import { docs, shareLinks } from "../db/schema";
import type { DB } from "../db/client";
import type { ShareRepo, ResolvedShareSetting } from "./share";
import { capabilityTokenFor } from "./share-token";
import type { RedeemTarget } from "../routes/share-redeem";

/**
 * capability-share-link S-002: resolve a capability token → its doc (or null when no doc
 * carries that token). Keyed on share_links.capability_token (the partial-unique index), and
 * GUARDED on the doc still being anyone_with_link AND the token being non-null — so a token
 * that was cleared/rotated (S-004) or a doc that left link-sharing no longer resolves, even if
 * a stale row somehow lingered. Returns the readable slug + the link role + the link expiry so
 * the redeem route can mint a cookie capped at the link's own expiry. Existence-hiding: a
 * no-match is null, never an error that distinguishes "no such token" from "wrong shape".
 */
export function createCapabilityTokenRepo(
  db: DB,
): (token: string) => Promise<RedeemTarget | null> {
  return async (token) => {
    const [row] = await db
      .select({
        docId: shareLinks.docId,
        slug: docs.slug,
        role: shareLinks.role,
        generalAccess: docs.generalAccess,
        capabilityToken: shareLinks.capabilityToken,
        expiresAt: shareLinks.expiresAt,
      })
      .from(shareLinks)
      .innerJoin(docs, eq(docs.id, shareLinks.docId))
      .where(
        and(
          eq(shareLinks.capabilityToken, token),
          // Defense in depth: only an anyone_with_link doc admits an anon via the token. A
          // doc that left link-sharing has its token cleared (S-004), but gate the level too.
          eq(docs.generalAccess, "anyone_with_link"),
        ),
      )
      .limit(1);
    if (!row || !row.capabilityToken) return null;
    return {
      docId: row.docId,
      slug: row.slug,
      role: row.role,
      expiresAt: row.expiresAt ?? null,
    };
  };
}

/** Construct a ShareRepo backed by a Drizzle DB handle. */
export function createShareRepo(db: DB): ShareRepo {
  return {
    async setGeneralAccess(docId, setting): Promise<ResolvedShareSetting> {
      return db.transaction(async (tx) => {
        // 1. The access LEVEL lives on the doc row.
        await tx.update(docs).set({ generalAccess: setting.level }).where(eq(docs.id, docId));

        // 1b. Capability token (capability-share-link S-001 / C-001). Read the doc's
        //     current token so re-saving the SAME anyone_with_link level keeps the live
        //     link (no silent rotation — that is S-004's explicit action); a transition
        //     INTO anyone_with_link from no token mints a fresh one, and any non-shared
        //     level clears it (the old link dies). The partial-unique index on the column
        //     is the global-uniqueness guarantee behind the minted secret.
        const [existing] = await tx
          .select({ capabilityToken: shareLinks.capabilityToken })
          .from(shareLinks)
          .where(eq(shareLinks.docId, docId));
        const capabilityToken = capabilityTokenFor(
          setting.level,
          existing?.capabilityToken ?? null,
        );

        // 2. Upsert the doc's single share_links row (C-001 unique docId). Only the
        //    link role is set here; password/expiry/view-limit are S-004's controls and
        //    are left as-is on conflict. (The guest_commenting column is no longer
        //    written — guest access is decided by the link role, sharing reversal
        //    2026-06-20.)
        //    editors_can_share (C-015): set it ONLY when the caller provided it (owner
        //    flipping the toggle). When undefined, leave the column untouched on update
        //    and let the column DEFAULT (true) apply on first insert — so an editor's
        //    normal manage-sharing write never disturbs the owner's toggle.
        const setOnConflict: {
          role: typeof setting.role;
          editorsCanShare?: boolean;
          capabilityToken: string | null;
        } = {
          role: setting.role,
          // Always written: mint/keep on anyone_with_link, clear (null) otherwise (C-001).
          capabilityToken,
        };
        if (setting.editorsCanShare !== undefined) {
          setOnConflict.editorsCanShare = setting.editorsCanShare;
        }
        const [row] = await tx
          .insert(shareLinks)
          .values({
            docId,
            role: setting.role,
            capabilityToken,
            // On INSERT, undefined falls through to the column default (true).
            ...(setting.editorsCanShare !== undefined
              ? { editorsCanShare: setting.editorsCanShare }
              : {}),
          })
          .onConflictDoUpdate({
            target: shareLinks.docId,
            set: setOnConflict,
          })
          .returning({
            role: shareLinks.role,
            editorsCanShare: shareLinks.editorsCanShare,
          });

        return {
          docId,
          level: setting.level,
          role: row?.role ?? setting.role,
          editorsCanShare: row?.editorsCanShare ?? setting.editorsCanShare ?? true,
        };
      });
    },
  };
}
