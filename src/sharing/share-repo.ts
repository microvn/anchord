// Drizzle-backed ShareRepo (sharing S-001). THIN glue between the share service
// (share.ts setGeneralAccess — the C-003/role guards) and Postgres. No business
// logic lives here: validation already ran in the service before this is called.
//
// One write touches TWO places, atomically (one transaction):
//   - docs.general_access = level (the access LEVEL lives on the doc row).
//   - the doc's single share_links row (role + guest_commenting) — upserted on the
//     unique docId (C-001: one general-access config per doc, never a second row).
// The link controls (password/expiry/view-limit, S-004) attach to the SAME row but
// are untouched here (only role + guestCommenting + the level), per C-001.

import { eq } from "drizzle-orm";
import { docs, shareLinks } from "../db/schema";
import type { DB } from "../db/client";
import type { ShareRepo, ResolvedShareSetting } from "./share";

/** Construct a ShareRepo backed by a Drizzle DB handle. */
export function createShareRepo(db: DB): ShareRepo {
  return {
    async setGeneralAccess(docId, setting): Promise<ResolvedShareSetting> {
      return db.transaction(async (tx) => {
        // 1. The access LEVEL lives on the doc row.
        await tx.update(docs).set({ generalAccess: setting.level }).where(eq(docs.id, docId));

        // 2. Upsert the doc's single share_links row (C-001 unique docId). Only the
        //    link role + guest toggle are set here; password/expiry/view-limit are
        //    S-004's controls and are left as-is on conflict.
        //    editors_can_share (C-015): set it ONLY when the caller provided it (owner
        //    flipping the toggle). When undefined, leave the column untouched on update
        //    and let the column DEFAULT (true) apply on first insert — so an editor's
        //    normal manage-sharing write never disturbs the owner's toggle.
        const setOnConflict: { role: typeof setting.role; guestCommenting: boolean; editorsCanShare?: boolean } = {
          role: setting.role,
          guestCommenting: setting.guestCommenting,
        };
        if (setting.editorsCanShare !== undefined) {
          setOnConflict.editorsCanShare = setting.editorsCanShare;
        }
        const [row] = await tx
          .insert(shareLinks)
          .values({
            docId,
            role: setting.role,
            guestCommenting: setting.guestCommenting,
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
            guestCommenting: shareLinks.guestCommenting,
            editorsCanShare: shareLinks.editorsCanShare,
          });

        return {
          docId,
          level: setting.level,
          role: row?.role ?? setting.role,
          guestCommenting: row?.guestCommenting ?? setting.guestCommenting,
          editorsCanShare: row?.editorsCanShare ?? setting.editorsCanShare ?? true,
        };
      });
    },
  };
}
