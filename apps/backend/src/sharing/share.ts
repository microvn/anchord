// Share service (sharing S-001): an owner sets a doc's general-access level + the
// role granted to anyone-with-link, and toggles guest commenting on/off.
//
// AS-001: anyone-with-link + commenter → setting saved (level + role).
// AS-002: restricted → only invitees get in (link-but-not-invited denied). The
//         actual outsider-denied / outsider-gets-commenter ENFORCEMENT is S-005's
//         role logic + the /d/:slug gate (integration); here we assert the SETTING
//         is persisted correctly.
// AS-003 / C-003: guest commenting is accepted ONLY when level = anyone_with_link;
//         on restricted (or anyone_in_workspace) it is rejected with a domain error.
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

/** Thrown when a requested setting violates a sharing rule (C-003 / role validation / C-015). */
export class ShareRejected extends Error {
  constructor(
    message: string,
    readonly code:
      | "guest_commenting_requires_link"
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
  /** Default false. Only accepted when level === "anyone_with_link" (C-003). */
  guestCommenting?: boolean;
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
  guestCommenting: boolean;
  editorsCanShare: boolean;
}

/** Persistence port. The real implementation (repo.ts) is thin Drizzle glue. */
export interface ShareRepo {
  /**
   * Persist docs.general_access = level AND upsert the doc's single share_links row
   * (role, guestCommenting, and `editorsCanShare` when present) atomically. Returns the
   * stored setting. The unique docId (C-001) means this is an upsert keyed on docId,
   * never a second row. `editorsCanShare` is OPTIONAL on the write: when undefined the
   * stored toggle is left untouched (default true on first insert).
   */
  setGeneralAccess(
    docId: string,
    setting: {
      level: GeneralAccessLevel;
      role: ShareRole;
      guestCommenting: boolean;
      editorsCanShare?: boolean;
    },
  ): Promise<ResolvedShareSetting>;
}

function isShareRole(role: string): role is ShareRole {
  return (SHARE_ROLES as readonly string[]).includes(role);
}

/**
 * Set a doc's general-access level, its anyone-with-link role, the guest-comment
 * toggle, and (owner-only) the editors_can_share toggle. Validates BEFORE the repo is
 * touched, so a rejected setting never persists:
 *   - role must be one of viewer | commenter | editor (owner is not a link role).
 *   - C-003 GUARD: guestCommenting === true is accepted ONLY when level is
 *     "anyone_with_link"; on any other level it throws ShareRejected (reject-with-
 *     clear-error, not silent-force-false).
 *   - C-015 GUARD: changing `editorsCanShare` requires `actorIsOwner` — an editor
 *     managing sharing may NOT flip the toggle, even when it is on. Omitting
 *     `editorsCanShare` leaves the toggle untouched (an editor's normal path).
 * Returns the resolved setting the repo persisted.
 */
export async function setGeneralAccess(
  docId: string,
  input: GeneralAccessInput,
  repo: ShareRepo,
  ctx: { actorIsOwner: boolean } = { actorIsOwner: false },
): Promise<ResolvedShareSetting> {
  const { level, role } = input;
  const guestCommenting = input.guestCommenting ?? false;

  if (!isShareRole(role)) {
    throw new ShareRejected(
      `Invalid share role "${role}": must be one of ${SHARE_ROLES.join(", ")}`,
      "invalid_role",
    );
  }

  // C-003 / AS-003: guest commenting only when anyone-with-link.
  if (guestCommenting && level !== "anyone_with_link") {
    throw new ShareRejected(
      `Guest commenting can only be enabled when general-access is "anyone_with_link" (got "${level}")`,
      "guest_commenting_requires_link",
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
    guestCommenting,
    editorsCanShare: input.editorsCanShare,
  });
}
