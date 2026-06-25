// Drizzle-backed ShareRepo (doc-access-two-axis S-001). THIN glue between the share
// service (share.ts setGeneralAccess — the C-009/C-015 guards) and Postgres. No business
// logic lives here: validation already ran in the service before this is called.
//
// The write touches the doc's single share_links row with PER-AXIS, COLUMN-SCOPED
// updates (C-011): workspace_role and link_role are each set on their own column, never
// via a read-modify-write of the whole row — so two managers editing DIFFERENT axes do
// not clobber each other (AS-007). The legacy `docs.general_access` write is GONE (the
// column is dropped); the level is derived on read (deriveLevel).
//
// The link controls (password/expiry/view-limit, S-004) attach to the link axis and are
// untouched here (only the two axis columns + the capability token + editors_can_share).

import { eq } from "drizzle-orm";
import { docs, shareLinks } from "../db/schema";
import type { DB } from "../db/client";
import type { ShareRepo, ResolvedShareSetting, AxisRole } from "./share";
import { deriveLevel } from "./derive-level";
import { capabilityTokenForLinkAxis, rotateCapabilityTokenForLinkAxis } from "./share-token";
import type { RedeemTarget } from "../routes/share-redeem";

/**
 * capability-share-link S-002: resolve a capability token → its doc (or null when no doc
 * carries that token). Keyed on share_links.capability_token (the partial-unique index),
 * GUARDED on the LINK AXIS still being ON (link_role non-null) AND the token being
 * non-null — so a token cleared when the link axis was turned off no longer resolves.
 * Returns the readable slug + the LINK role + the link expiry. Existence-hiding: a
 * no-match is null, never an error.
 *
 * doc-access-two-axis S-001 stopgap: gates on share_links.link_role (the link axis) and
 * returns it as the redeem role — replaces the dropped docs.general_access gate. The full
 * anon-admission rework is S-003's job.
 */
export function createCapabilityTokenRepo(
  db: DB,
): (token: string) => Promise<RedeemTarget | null> {
  return async (token) => {
    const [row] = await db
      .select({
        docId: shareLinks.docId,
        slug: docs.slug,
        linkRole: shareLinks.linkRole,
        capabilityToken: shareLinks.capabilityToken,
        expiresAt: shareLinks.expiresAt,
        passwordHash: shareLinks.passwordHash,
        viewLimit: shareLinks.viewLimit,
      })
      .from(shareLinks)
      .innerJoin(docs, eq(docs.id, shareLinks.docId))
      .where(eq(shareLinks.capabilityToken, token))
      .limit(1);
    // Defense in depth: only a doc whose LINK AXIS is on (link_role set) admits an anon
    // via the token; a token that lingered after the link axis was turned off is refused.
    if (!row || !row.capabilityToken || row.linkRole == null) return null;
    return {
      docId: row.docId,
      slug: row.slug,
      role: row.linkRole,
      expiresAt: row.expiresAt ?? null,
      passwordHash: row.passwordHash ?? null,
      viewLimit: row.viewLimit ?? null,
    };
  };
}

/**
 * The result of an explicit rotate (capability-share-link S-004 / AS-011 / C-004).
 */
export type RotateResult =
  | { rotated: true; token: string }
  | { rotated: false };

/**
 * Explicit rotate of a doc's capability token (capability-share-link S-004 / AS-011).
 *
 * doc-access-two-axis S-005: the rotate decision reads the LINK AXIS (share_links.link_role)
 * directly via `rotateCapabilityTokenForLinkAxis` — NOT the dropped docs.general_access, and no
 * longer through the level-shaped helper. A doc whose link axis is ON (link_role set) has a
 * capability link → mint a fresh token over the old one; a doc whose link axis is off (link_role
 * null) has no link to rotate → `{ rotated: false }` (the route turns this into a 409). Only the
 * token column moves; the axes/controls are untouched.
 */
export async function rotateCapabilityToken(db: DB, docId: string): Promise<RotateResult> {
  return db.transaction(async (tx) => {
    const [link] = await tx
      .select({ linkRole: shareLinks.linkRole })
      .from(shareLinks)
      .where(eq(shareLinks.docId, docId))
      .limit(1);
    // Keyed on the link axis directly: rotate only when link_role is set, else nothing to rotate.
    const next = rotateCapabilityTokenForLinkAxis(link?.linkRole ?? null);
    if (next === null) return { rotated: false };

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
        // Read the doc's CURRENT row first. Two reasons:
        //  1. The capability token follows the LINK AXIS (C-003): keeping the link axis on
        //     does NOT silently rotate (rotation is S-004's explicit action); turning it on
        //     from nothing mints a fresh token; turning it off clears it (the old link dies).
        //  2. PARTIAL-UPDATE (C-011): when the linkRole axis is ABSENT, the resulting link
        //     state is the CURRENT column value — so the token side-effect must be computed
        //     against that current value (mint when it becomes set, clear when it becomes
        //     null), not against an absent intent.
        const [existing] = await tx
          .select({
            capabilityToken: shareLinks.capabilityToken,
            linkRole: shareLinks.linkRole,
          })
          .from(shareLinks)
          .where(eq(shareLinks.docId, docId));
        // The link role that will be in effect AFTER this write: the provided value when the
        // linkRole axis is present, else the current column value (left untouched).
        const resultingLinkRole =
          setting.linkRole !== undefined ? setting.linkRole : existing?.linkRole ?? null;
        const capabilityToken = capabilityTokenForLinkAxis(
          resultingLinkRole,
          existing?.capabilityToken ?? null,
        );

        // PER-AXIS, COLUMN-SCOPED write (C-011 / AS-007). Each column is set on its OWN
        // field — never a read-modify-write of a whole-row snapshot. PARTIAL-UPDATE: an
        // axis (or editors_can_share) that the caller did NOT provide is OMITTED from the
        // onConflict `set`, so its current column value is LEFT UNTOUCHED — two managers
        // editing DIFFERENT axes each write only their own column and neither reverts the
        // other. On first INSERT an omitted axis falls back to its default (the INSERT
        // `values` carries workspace_role=commenter — the new-doc default — and leaves
        // link_role at its null column default when neither was provided).
        const setOnConflict: {
          workspaceRole?: AxisRole;
          linkRole?: AxisRole;
          editorsCanShare?: boolean;
          capabilityToken: string | null;
        } = { capabilityToken };
        if (setting.workspaceRole !== undefined) setOnConflict.workspaceRole = setting.workspaceRole;
        if (setting.linkRole !== undefined) setOnConflict.linkRole = setting.linkRole;
        if (setting.editorsCanShare !== undefined) {
          setOnConflict.editorsCanShare = setting.editorsCanShare;
        }
        const [row] = await tx
          .insert(shareLinks)
          .values({
            docId,
            // INSERT defaults for an absent axis (no prior row): workspace_role=commenter
            // is the new-doc default; link_role stays null (off).
            workspaceRole: setting.workspaceRole !== undefined ? setting.workspaceRole : "commenter",
            ...(setting.linkRole !== undefined ? { linkRole: setting.linkRole } : {}),
            capabilityToken,
            ...(setting.editorsCanShare !== undefined
              ? { editorsCanShare: setting.editorsCanShare }
              : {}),
          })
          .onConflictDoUpdate({
            target: shareLinks.docId,
            set: setOnConflict,
          })
          .returning({
            workspaceRole: shareLinks.workspaceRole,
            linkRole: shareLinks.linkRole,
            editorsCanShare: shareLinks.editorsCanShare,
            capabilityToken: shareLinks.capabilityToken,
          });

        const workspaceRole = row?.workspaceRole ?? null;
        const linkRole = row?.linkRole ?? null;
        return {
          docId,
          workspaceRole,
          linkRole,
          level: deriveLevel(workspaceRole, linkRole),
          editorsCanShare: row?.editorsCanShare ?? setting.editorsCanShare ?? true,
          capabilityToken: row?.capabilityToken ?? capabilityToken,
        };
      });
    },
  };
}
