// Accept-link token scheme (auth AS-011 / C-009 / harden H6).
//
// A pending invite must be acceptable via an in-app/shareable link that does NOT
// depend on the verify/invite email arriving. The link is `{inviteId}/{token}`
// (invite.ts buildAcceptLink). The `doc_members` table carries no token column —
// and adding one would be a schema migration outside this fix — so the token is a
// DETERMINISTIC, verifiable HMAC over the invite id keyed by APP_SECRET:
//
//   token = base64url(HMAC-SHA256(secret, "invite-accept:" + inviteId))
//
// Properties this gives us, without a new column:
//  - Unforgeable: only the server (holding APP_SECRET) can mint a token for an id,
//    so a guessed/iterated inviteId without the matching token is refused.
//  - Stateless + idempotent: re-deriving the same token for the same id always
//    matches, so the accept-link works on every retry (the email-independent path).
//  - Verified by recomputation: the route mints the EXPECTED token from the id +
//    secret and compares (timing-safe) against the one in the link.
//
// The accept-link is otherwise just glue around invite.ts acceptInviteByLink, which
// owns the email-match + verified gate (C-005). The token only binds the link to a
// specific invite id so it can't be pointed at a different invite.

import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_CONTEXT = "invite-accept:";

/** Mint the deterministic accept-link token for a pending invite id (HMAC keyed by secret). */
export function mintInviteToken(inviteId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(TOKEN_CONTEXT + inviteId)
    .digest("base64url");
}

/**
 * Constant-time compare a presented token against the one minted for `inviteId`.
 * Returns false on any length/format mismatch (never throws) so the route can map
 * a bad token to a plain refusal.
 */
export function verifyInviteToken(inviteId: string, token: string, secret: string): boolean {
  if (typeof token !== "string" || token.length === 0) return false;
  const expected = mintInviteToken(inviteId, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
