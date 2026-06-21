// Share service (sharing S-001): an owner sets a doc's general-access level + the
// role granted to anyone-with-link.
//
// AS-001: anyone-with-link + commenter → setting saved (level + role). The commenter+
//         link role IS the grant for guests — there is NO separate guest-commenting
//         toggle (Google-Docs model, sharing reversal 2026-06-20).
// AS-002: restricted → only invitees get in (link-but-not-invited denied). The
//         actual outsider-denied / outsider-gets-commenter ENFORCEMENT is S-005's
//         role logic + the /d/:slug gate (integration); here we assert the SETTING
//         is persisted correctly.
// C-001: one general-access config per doc (unique docId on share_links); the link
//        controls (password/expiry/view-limit, S-004) attach to that same row but
//        are independent of, and untouched by, this setting.
//
// Persistence is behind an injectable ShareRepo port (mirrors publish's DocRepo /
// version's VersionRepo) so the guard + validation LOGIC is unit-testable without a
// DB. The real Drizzle glue (sets docs.general_access + upserts the share_links row
// in one transaction) is integration-verified-later, NOT here.

import type { generalAccess, shareRole } from "../db/schema";

/** General-access level — mirrors docs.general_access (render-publish owns the enum). */
export type GeneralAccessLevel = (typeof generalAccess.enumValues)[number];
/** Role granted to anyone-with-link. NOT "owner" — owner is never a link role. */
export type ShareRole = (typeof shareRole.enumValues)[number];

const SHARE_ROLES: readonly ShareRole[] = ["viewer", "commenter", "editor"];

/** Thrown when a requested setting violates a sharing rule (role validation / C-015). */
export class ShareRejected extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_role"
      | "toggle_owner_only",
  ) {
    super(message);
    this.name = "ShareRejected";
  }
}

export interface GeneralAccessInput {
  level: GeneralAccessLevel;
  role: ShareRole;
  /**
   * The owner-controlled `editors_can_share` toggle (C-015). Optional: when omitted
   * the stored value is left untouched (defaults true on the first set). When present
   * it changes the toggle and REQUIRES the actor be owner (`actorIsOwner`), else
   * ShareRejected("toggle_owner_only"). An editor managing sharing leaves this out.
   */
  editorsCanShare?: boolean;
}

/** The resolved, persisted setting (what the repo stored). */
export interface ResolvedShareSetting {
  docId: string;
  level: GeneralAccessLevel;
  role: ShareRole;
  editorsCanShare: boolean;
  /**
   * The doc's resulting capability token after the write (capability-share-link AS-027/AS-028):
   * the freshly minted / kept token when level is `anyone_with_link`, or `null` when it was cleared
   * (restricted / anyone_in_workspace). The route turns this into the external `/s/<token>` link so
   * the Share dialog surfaces it IN-SESSION on an access change, without re-reading …/share.
   */
  capabilityToken: string | null;
}

/** Persistence port. The real implementation (repo.ts) is thin Drizzle glue. */
export interface ShareRepo {
  /**
   * Persist docs.general_access = level AND upsert the doc's single share_links row
   * (role, and `editorsCanShare` when present) atomically. Returns the stored setting.
   * The unique docId (C-001) means this is an upsert keyed on docId, never a second row.
   * `editorsCanShare` is OPTIONAL on the write: when undefined the stored toggle is left
   * untouched (default true on first insert).
   */
  setGeneralAccess(
    docId: string,
    setting: {
      level: GeneralAccessLevel;
      role: ShareRole;
      editorsCanShare?: boolean;
    },
  ): Promise<ResolvedShareSetting>;
}

function isShareRole(role: string): role is ShareRole {
  return (SHARE_ROLES as readonly string[]).includes(role);
}

/**
 * Set a doc's general-access level, its anyone-with-link role, and (owner-only) the
 * editors_can_share toggle. Validates BEFORE the repo is touched, so a rejected setting
 * never persists:
 *   - role must be one of viewer | commenter | editor (owner is not a link role).
 *   - C-015 GUARD: changing `editorsCanShare` requires `actorIsOwner` — an editor
 *     managing sharing may NOT flip the toggle, even when it is on. Omitting
 *     `editorsCanShare` leaves the toggle untouched (an editor's normal path).
 *
 * NOTE (sharing reversal 2026-06-20): there is NO guest-commenting toggle. A commenter+
 * link role IS the grant for guests (Google-Docs model), so guest access is decided by
 * the link role alone, not a separate flag here.
 *
 * Returns the resolved setting the repo persisted.
 */
export async function setGeneralAccess(
  docId: string,
  input: GeneralAccessInput,
  repo: ShareRepo,
  ctx: { actorIsOwner: boolean } = { actorIsOwner: false },
): Promise<ResolvedShareSetting> {
  const { level, role } = input;

  if (!isShareRole(role)) {
    throw new ShareRejected(
      `Invalid share role "${role}": must be one of ${SHARE_ROLES.join(", ")}`,
      "invalid_role",
    );
  }

  // C-015 / AS-022: only the owner may change the editors_can_share toggle. A non-owner
  // who tries to set it (even to its current value) is rejected — the toggle is the
  // owner's lock on who else can share.
  if (input.editorsCanShare !== undefined && !ctx.actorIsOwner) {
    throw new ShareRejected(
      "Only the owner can change editors_can_share",
      "toggle_owner_only",
    );
  }

  return repo.setGeneralAccess(docId, {
    level,
    role,
    editorsCanShare: input.editorsCanShare,
  });
}
