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
import { capabilityTokenFor, rotateCapabilityTokenFor } from "./share-token";
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
        // S-006: the link controls the redeem route enforces before serving — the password hash
        // (gated against a visitor-supplied password) and the total-open limit (gating the
        // atomic view consume). The plaintext password is never read here.
        passwordHash: shareLinks.passwordHash,
        viewLimit: shareLinks.viewLimit,
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
      passwordHash: row.passwordHash ?? null,
      viewLimit: row.viewLimit ?? null,
    };
  };
}

/**
 * The result of an explicit rotate (capability-share-link S-004 / AS-011 / C-004).
 *  - `rotated: true`  → the doc was anyone_with_link; its capability_token was REPLACED with a
 *    fresh one (`token`). The old token is permanently dead and every admission cookie minted
 *    from it is now refused (its bound token-hash no longer matches the live token).
 *  - `rotated: false` → the doc is NOT anyone_with_link (no capability link to rotate). The
 *    column is left as-is (null); the caller (route) turns this into a 409, never a crash.
 */
export type RotateResult =
  | { rotated: true; token: string }
  | { rotated: false };

/**
 * Explicit rotate of a doc's capability token (capability-share-link S-004 / AS-011 / C-004).
 *
 * This is the owner action that REPLACES the live link's secret while keeping general access
 * anyone_with_link and the link role UNCHANGED. It reads the doc's current level (the source of
 * truth on the doc row), and — only when it is still anyone_with_link — writes a brand-new
 * crypto-random token over the old one in ONE transaction. The minted value is distinct from the
 * old one (a fresh CSPRNG mint), so the previously-shared link stays dead and every admission
 * cookie minted from it is refused thereafter (the cookie binds a HASH of the now-replaced token).
 *
 * A doc that is not anyone_with_link (restricted / anyone_in_workspace) has no capability link, so
 * there is nothing to rotate: this returns `{ rotated: false }` and leaves the column untouched —
 * the route surfaces a 409, never a crash (C-004 edge). Only the role/level-agnostic token column
 * is touched; the link role + controls (password/expiry/view-limit) are left as-is.
 */
export async function rotateCapabilityToken(db: DB, docId: string): Promise<RotateResult> {
  return db.transaction(async (tx) => {
    const [doc] = await tx
      .select({ generalAccess: docs.generalAccess })
      .from(docs)
      .where(eq(docs.id, docId))
      .limit(1);
    // Nothing to rotate when the doc isn't link-shared (or doesn't exist): no-op, no crash.
    const next = doc ? rotateCapabilityTokenFor(doc.generalAccess) : null;
    if (next === null) return { rotated: false };

    // Replace the token on the doc's single share_links row (C-001 unique docId). The row
    // exists already (it is anyone_with_link), but upsert defensively so a missing row can't
    // crash the rotate; the role/controls are left untouched (only the token column moves).
    await tx
      .insert(shareLinks)
      .values({ docId, capabilityToken: next })
      .onConflictDoUpdate({
        target: shareLinks.docId,
        set: { capabilityToken: next },
      });
    return { rotated: true, token: next };
  });
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
            capabilityToken: shareLinks.capabilityToken,
          });

        return {
          docId,
          level: setting.level,
          role: row?.role ?? setting.role,
          editorsCanShare: row?.editorsCanShare ?? setting.editorsCanShare ?? true,
          // The resulting token (minted/kept on anyone_with_link, cleared null otherwise — C-001).
          // Fall back to the computed value so the result is correct even if RETURNING is empty.
          capabilityToken: row?.capabilityToken ?? capabilityToken,
        };
      });
    },
  };
}
