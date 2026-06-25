// Share service (doc-access-two-axis S-001): someone who can manage sharing sets a
// doc's access as TWO INDEPENDENT axes — the workspace axis (the role every member of
// the doc's own workspace gets) and the link axis (the role anyone holding the link
// gets). Each axis is a share role (viewer|commenter|editor) or OFF (null). The two are
// independent: setting one never changes the other (C-001). The legacy single
// `general_access` level is gone — it is DERIVED on read (deriveLevel).
//
// AS-001: workspace=commenter, link=off → saved; members comment, outsider denied
//         (the member-grant / outsider-deny ENFORCEMENT is S-003's role logic +
//         the access gate; here we own that the SETTING persists on both axes).
// AS-002: link viewer does not demote workspace commenter — each axis stored as-is.
// AS-003: workspace off + link viewer → out of workspace, link views.
// AS-004: only viewer|commenter|editor|off per axis; "owner" never assignable (C-009).
// AS-007: each axis is written with a COLUMN-SCOPED, PARTIAL update (C-011) — only the
//         axes PRESENT in the call are written; an ABSENT axis is left at its current
//         value (omitted from the onConflict `set`). So two managers editing DIFFERENT
//         axes never clobber each other, even from a stale snapshot (no whole-row overwrite).
// C-001:  one access config per doc (unique docId on share_links); the link controls
//         (password/expiry/view-limit, S-004) attach to the link axis, untouched here.
//
// Persistence is behind an injectable ShareRepo port so the validation LOGIC is
// unit-testable without a DB. The real Drizzle glue (per-axis column-scoped writes on
// the doc's single share_links row) lives in share-repo.ts.

import type { shareRole } from "../db/schema";
import { deriveLevel, type GeneralAccessLevel } from "./derive-level";

export type { GeneralAccessLevel } from "./derive-level";
/** Role granted on an axis. NOT "owner" — owner is conferred by ownership, never assignable. */
export type ShareRole = (typeof shareRole.enumValues)[number];
/** An axis value: a share role, or null (the axis is OFF). */
export type AxisRole = ShareRole | null;

const SHARE_ROLES: readonly ShareRole[] = ["viewer", "commenter", "editor"];

/** Thrown when a requested setting violates a sharing rule (role validation / C-009 / C-015). */
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
  /**
   * The workspace axis (C-002): role for every member of the doc's workspace, or null = off.
   * PARTIAL-UPDATE (C-011): OPTIONAL — `undefined`/absent means "leave this axis unchanged"
   * (a stale single-axis edit cannot revert a concurrent edit to the other axis); null = off;
   * a role = set it. On first INSERT (no row yet) an absent axis falls back to its default.
   */
  workspaceRole?: AxisRole;
  /**
   * The link axis (C-003): role for anyone holding the link, or null = off (no public link).
   * PARTIAL-UPDATE (C-011): OPTIONAL — same semantics as workspaceRole (absent = unchanged).
   */
  linkRole?: AxisRole;
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
  /** The two raw axes, exactly as stored (C-001 — independent). */
  workspaceRole: AxisRole;
  linkRole: AxisRole;
  /** The DERIVED legacy summary (deriveLevel) — never stored, computed from the two axes. */
  level: GeneralAccessLevel;
  editorsCanShare: boolean;
  /**
   * The doc's resulting capability token after the write: a freshly minted / kept token
   * when the link axis is ON (link_role set), or `null` when the link axis is off (the
   * token is cleared with the link axis). The route turns this into `/s/<token>`.
   */
  capabilityToken: string | null;
}

/** Persistence port. The real implementation (repo.ts) is per-axis Drizzle glue. */
export interface ShareRepo {
  /**
   * Persist the two axes onto the doc's single share_links row with PER-AXIS,
   * COLUMN-SCOPED writes (C-011) — workspace_role and link_role are each written to
   * their own column, never via a read-modify-write of the whole row, so concurrent
   * edits to different axes do not clobber each other (AS-007). Upserted on the unique
   * docId (C-001 — never a second row).
   *
   * PARTIAL-UPDATE (C-011): each axis is OPTIONAL. An axis that is `undefined` is NOT
   * written — on UPDATE its current column value is LEFT UNTOUCHED (it stays out of the
   * onConflict `set`); on first INSERT (no row) it falls back to the schema/new-doc
   * default (workspace_role=commenter, link_role=null). Only the axes PRESENT in `setting`
   * are written, so a single-axis edit never reverts a concurrent edit to the other axis.
   *
   * `editorsCanShare` is OPTIONAL: when undefined the toggle is left untouched (default
   * true on first insert). Returns the stored setting (both raw axes + derived level +
   * capability token).
   */
  setGeneralAccess(
    docId: string,
    setting: {
      workspaceRole?: AxisRole;
      linkRole?: AxisRole;
      editorsCanShare?: boolean;
    },
  ): Promise<ResolvedShareSetting>;
}

/** A value is a valid axis setting iff it is null (off) or one of viewer|commenter|editor. */
function isAxisRole(role: unknown): role is AxisRole {
  return role === null || (typeof role === "string" && (SHARE_ROLES as readonly string[]).includes(role));
}

/**
 * Set a doc's two access axes (workspace + link) and (owner-only) the editors_can_share
 * toggle. Validates BEFORE the repo is touched, so a rejected setting never persists:
 *   - each axis must be viewer | commenter | editor or null/off — "owner" (or any other
 *     value) on EITHER axis is rejected (C-009 / AS-004); the stored access is unchanged.
 *   - C-015 GUARD: changing `editorsCanShare` requires `actorIsOwner`.
 *
 * The two axes are independent (C-001): this passes both straight through to the repo,
 * which writes each to its own column (C-011) — setting one never mutates the other.
 *
 * Returns the resolved setting the repo persisted (both raw axes + the derived level).
 */
export async function setGeneralAccess(
  docId: string,
  input: GeneralAccessInput,
  repo: ShareRepo,
  ctx: { actorIsOwner: boolean } = { actorIsOwner: false },
): Promise<ResolvedShareSetting> {
  const { workspaceRole, linkRole } = input;

  // C-009 / AS-004: each axis is viewer|commenter|editor or off (null). "owner" is never
  // assignable on either axis. Validation runs only on a PRESENT axis (C-011 partial-update):
  // an absent axis (`undefined`) carries no intent, so there is nothing to validate or write.
  // A bad value on EITHER present axis rejects the whole change.
  if (workspaceRole !== undefined && !isAxisRole(workspaceRole)) {
    throw new ShareRejected(
      `Invalid workspace access role "${String(workspaceRole)}": must be one of ${SHARE_ROLES.join(", ")} or off`,
      "invalid_role",
    );
  }
  if (linkRole !== undefined && !isAxisRole(linkRole)) {
    throw new ShareRejected(
      `Invalid link access role "${String(linkRole)}": must be one of ${SHARE_ROLES.join(", ")} or off`,
      "invalid_role",
    );
  }

  // C-015 / AS-022: only the owner may change the editors_can_share toggle.
  if (input.editorsCanShare !== undefined && !ctx.actorIsOwner) {
    throw new ShareRejected(
      "Only the owner can change editors_can_share",
      "toggle_owner_only",
    );
  }

  // Thread ONLY the present axes through (C-011) — an undefined axis stays out of the repo
  // call so the column-scoped write leaves it at its current value (no whole-row overwrite).
  return repo.setGeneralAccess(docId, {
    ...(workspaceRole !== undefined ? { workspaceRole } : {}),
    ...(linkRole !== undefined ? { linkRole } : {}),
    editorsCanShare: input.editorsCanShare,
  });
}

/** Re-export the derive helper so callers of the share service can summarize the axes. */
export { deriveLevel };
