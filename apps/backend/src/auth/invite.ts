// Pending-invite activation (auth S-005).
//
// AS-008: signing up with the invited email (verified) activates the invited role.
// AS-009: a different email does NOT activate someone else's invite.
// C-005:  a pending invite activates when an account for that EXACT email exists +
//         is verified — mirror the verification gate (an unverified email never activates).
//
// The activation logic is pure + driven by an injectable PendingInviteRepo port, so
// it is unit-tested with a fake repo (the project's "injectable port" pattern, cf.
// publish/service.ts DocRepo, services/version.ts VersionRepo).
//
// CROSS-SPEC SEAM: the `doc_members` pending-invite table is OWNED by the
// sharing-permissions cluster (NOT built here). The CONCRETE PendingInviteRepo
// (thin Drizzle glue over that table) lands in sharing-permissions; this story
// only defines the port + the activation algorithm against it.

/** One pending invite row, as the sharing-permissions repo will expose it. */
export interface PendingInvite {
  id: string;
  docId: string;
  /** The exact email the invite was issued to (normalize-compared, never fuzzy). */
  email: string;
  /** Role to grant on activation: viewer | commenter | editor | owner. */
  role: string;
  /** Lifecycle state; only `"pending"` invites are eligible to activate. */
  status: string;
}

/**
 * Persistence port for pending invites. Concrete impl lands in sharing-permissions
 * (thin Drizzle glue over the `doc_members` table it owns).
 */
export interface PendingInviteRepo {
  /** All pending invites issued to this email (exact, case-insensitive normalized). */
  findPendingByEmail(email: string): Promise<PendingInvite[]>;
  /** Bind an invite to the now-existing user account and flip it to active. */
  activate(inviteId: string, userId: string): Promise<void>;
}

/** Normalize an email for EXACT (case-insensitive) match — no fuzzy matching. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface ActivatedInvite {
  inviteId: string;
  docId: string;
  role: string;
}

/**
 * Activate every pending invite issued to `email`, granting `userId` the invited
 * role on each corresponding doc.
 *
 * Gate (C-005): activation requires `isVerified === true`. An unverified email
 * activates NOTHING — this mirrors the email-verification gate used elsewhere in
 * auth, so a pending invite can never be claimed by an unverified address.
 *
 * Match is EXACT (case-insensitive normalize is fine, no fuzzy) — so a different
 * signer (AS-009) finds no invites of theirs and gets no role.
 *
 * Returns the invites it activated (empty when none matched or unverified).
 */
export async function activatePendingInvites(
  email: string,
  userId: string,
  isVerified: boolean,
  repo: PendingInviteRepo,
): Promise<ActivatedInvite[]> {
  // C-005: the verification gate. Unverified → activate nothing.
  if (!isVerified) return [];
  if (typeof email !== "string" || email.trim().length === 0) return [];
  if (typeof userId !== "string" || userId.trim().length === 0) return [];

  const normalized = normalizeEmail(email);
  const invites = await repo.findPendingByEmail(normalized);

  const activated: ActivatedInvite[] = [];
  for (const invite of invites) {
    // Defense in depth: the repo filters by email + pending, but re-check both so a
    // loose repo can never grant the wrong person a role (AS-009) or re-activate a
    // non-pending invite. EXACT normalized match only.
    if (invite.status !== "pending") continue;
    if (normalizeEmail(invite.email) !== normalized) continue;

    await repo.activate(invite.id, userId);
    activated.push({ inviteId: invite.id, docId: invite.docId, role: invite.role });
  }
  return activated;
}

// ---------------------------------------------------------------------------
// Invite accept-link (AS-011 / C-009): a pending invite must be acceptable
// in-app via a shareable link that does NOT depend on the verify/invite email
// arriving. The token is the email's independent path: even when the mail
// transport is failing, the operator/inviter can hand this link to the invitee.
// ---------------------------------------------------------------------------

const ACCEPT_LINK_PREFIX = "/invite/accept/";

/** Mint a shareable accept-link path for a pending invite (email-independent). */
export function buildAcceptLink(inviteId: string, token: string): string {
  return `${ACCEPT_LINK_PREFIX}${encodeURIComponent(inviteId)}/${encodeURIComponent(token)}`;
}

/**
 * Mint the WORKSPACE-invite accept/reject landing link (workspaces S-004 / AS-009).
 * Shape consumed by the FE WorkspaceInviteLanding route (workspaces-ui S-004):
 * `/invite/workspace/:invitationId?token=…&email=…`. Distinct from buildAcceptLink
 * (the per-doc invite path) — a workspace invite grants MEMBERSHIP, not a doc role.
 * The token is the random DB token (workspace_invitations.token), not an APP_SECRET mint.
 */
export function buildWorkspaceAcceptLink(
  invitationId: string,
  token: string,
  email: string,
): string {
  const q = new URLSearchParams({ token, email });
  return `/invite/workspace/${encodeURIComponent(invitationId)}?${q.toString()}`;
}

export interface ParsedAcceptLink {
  inviteId: string;
  token: string;
}

/** Parse an accept-link path back into {inviteId, token}; null if malformed. */
export function parseAcceptLink(path: string): ParsedAcceptLink | null {
  if (typeof path !== "string" || !path.startsWith(ACCEPT_LINK_PREFIX)) return null;
  const rest = path.slice(ACCEPT_LINK_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  const inviteId = decodeURIComponent(rest.slice(0, slash));
  const token = decodeURIComponent(rest.slice(slash + 1));
  if (inviteId.length === 0 || token.length === 0) return null;
  return { inviteId, token };
}

/**
 * Accept a pending invite via its shareable link — the path that works REGARDLESS
 * of whether the verify/invite email ever arrives (AS-011 / C-009). Resolves the
 * invite by id, checks it is still pending and the token + email match, then
 * activates it for `userId`.
 *
 * This deliberately does not touch the mailer: a failing transport must not block
 * an invitee who already holds the link.
 *
 * `expectedToken` is what the invite was minted with (the sharing-permissions repo
 * stores it); the in-app accept page passes the user's verified email so the same
 * EXACT-match + verified gate (C-005) still applies.
 */
export async function acceptInviteByLink(
  link: string,
  userId: string,
  acceptingEmail: string,
  isVerified: boolean,
  expectedToken: string,
  repo: PendingInviteRepo,
): Promise<ActivatedInvite | null> {
  const parsed = parseAcceptLink(link);
  if (!parsed) return null;
  if (parsed.token !== expectedToken) return null;
  // C-005 gate also applies to the link path: verified + exact email only.
  if (!isVerified) return null;

  const normalized = normalizeEmail(acceptingEmail);
  const invites = await repo.findPendingByEmail(normalized);
  const invite = invites.find((i) => i.id === parsed.inviteId);
  if (!invite) return null;
  if (invite.status !== "pending") return null;
  if (normalizeEmail(invite.email) !== normalized) return null;

  await repo.activate(invite.id, userId);
  return { inviteId: invite.id, docId: invite.docId, role: invite.role };
}
