// Share-state read aggregator (sharing S-006): assembles the doc's current sharing
// state for the FE Share dialog to prefill from. PURE shaping over an injectable
// ShareStateRepo port (mirrors share.ts's setGeneralAccess pattern) so the read can
// be unit-tested without a DB; the concrete Drizzle read lives in share-state-repo.ts.
//
// The three management routes (PUT access / POST invites / PUT link) are write-only;
// this is the matching READ surface (sharing-permissions-ui:GAP-003).
//
// AS-025: returns level, role, editorsCanShare, the people list (email/name, role,
//         active|pending), and the link controls (expiresAt, viewLimit, viewCount, url,
//         and WHETHER a password is set). No guest-commenting field — guest access is
//         decided by the commenter+ link role (Google-Docs model, reversal 2026-06-20).
// AS-026 / C-016: the stored password NEVER leaves the server — only a boolean
//         `hasPassword` (derived from password_hash != null) is exposed; the hash is
//         not part of the repo's read shape at all.

import type { GeneralAccessLevel, ShareRole } from "./share";
import type { Role } from "./roles";

/** One row of the people list — an invited member (active) or a pending invite. */
export interface SharePerson {
  /** The doc_members row id — lets the Share dialog target the change-role / remove member
   *  actions (S-007 PATCH/DELETE …/members/:id). (AS-025) */
  id: string;
  email: string;
  /** The account display name when known; absent for a pending (no-account) invite. */
  name?: string;
  role: ShareRole;
  status: "active" | "pending";
}

/** The link controls the dialog shows — password is a BOOLEAN only (C-016). */
export interface ShareLinkState {
  hasPassword: boolean;
  expiresAt: Date | null;
  viewLimit: number | null;
  viewCount: number;
  /** The shareable link to the doc (the /d/:slug viewer path). */
  url: string;
}

/** The full share state the GET …/share route returns (AS-025). */
export interface ShareState {
  level: GeneralAccessLevel;
  role: ShareRole;
  editorsCanShare: boolean;
  people: SharePerson[];
  link: ShareLinkState;
  /**
   * The CALLER's own effective role on this doc (owner/editor/commenter/viewer) — the same role
   * `requireManageSharing` resolved to gate the read. The dialog uses it for the owner-only gate
   * (C-003 editors_can_share) so that check works regardless of HOW the dialog was opened (the
   * viewer passes `effectiveRole`, but the docs-list ⋯ entry preloads no role — lazy gate, C-002).
   */
  viewerRole: Role;
}

/**
 * What the repo reads from the DB for a doc. The link's password is exposed ONLY as
 * `hasPassword` (the repo derives it from password_hash != null) — the raw hash is
 * never part of this shape, so it cannot leak into the response (AS-026 / C-016).
 */
export interface ShareStateRow {
  level: GeneralAccessLevel;
  /** From the share_links row; defaults to "viewer" when no link row exists yet. */
  role: ShareRole;
  editorsCanShare: boolean;
  people: SharePerson[];
  link: {
    hasPassword: boolean;
    expiresAt: Date | null;
    viewLimit: number | null;
    viewCount: number;
  };
}

/** Read port — the concrete Drizzle impl is share-state-repo.ts. */
export interface ShareStateRepo {
  /** Read the doc's general access + share_links controls + doc_members people list. */
  readShareState(docId: string): Promise<ShareStateRow>;
}

/**
 * Assemble the share state for the dialog. PURE shaping: reads the repo row and adds
 * the shareable `url` (the /d/:slug viewer path). NEVER touches a password hash —
 * `hasPassword` is the only password signal it propagates (AS-026 / C-016).
 */
export async function readShareState(
  docId: string,
  slug: string,
  repo: ShareStateRepo,
  viewerRole: Role,
): Promise<ShareState> {
  const row = await repo.readShareState(docId);
  return {
    level: row.level,
    role: row.role,
    editorsCanShare: row.editorsCanShare,
    people: row.people,
    viewerRole,
    link: {
      hasPassword: row.link.hasPassword,
      expiresAt: row.link.expiresAt,
      viewLimit: row.link.viewLimit,
      viewCount: row.link.viewCount,
      url: shareUrl(slug),
    },
  };
}

/** The shareable link to a doc — the trusted-origin viewer path (/d/:slug). */
export function shareUrl(slug: string): string {
  return `/d/${encodeURIComponent(slug)}`;
}
