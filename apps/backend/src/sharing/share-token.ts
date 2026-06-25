// Capability-token minting for shared docs (capability-share-link S-001).
//
// anchord's "anyone with link" URL was guessable: `/d/<slugified-title>-<suffix>`,
// where the title half leaks the content and the suffix is low-entropy. This module
// is the foundation primitive that restores the capability-URL assumption (the link
// itself IS the secret): when a doc's general access becomes `anyone_with_link`, the
// system mints a high-entropy, crypto-random, URL-safe token (NO part of the title)
// that addresses the doc at `/s/<token>`. Turning sharing off clears it.
//
// AS-001 / AS-002 / C-001: the token is crypto-random (Web Crypto getRandomValues),
//   carries ≥128 bits of entropy, is URL-safe (base64url, no `+` `/` `=`), and is
//   derived purely from random bytes — it can contain NO part of any doc title.
// The token LIFECYCLE is keyed on the LINK AXIS (doc-access-two-axis S-001/S-005):
//   `capabilityTokenForLinkAxis` mints/keeps a token while `link_role` is set and clears
//   it when `link_role` is null; `rotateCapabilityTokenForLinkAxis` is the explicit replace.
//
// This module is PURE (no DB): the transition logic + the generator are unit-testable
// in isolation. The persistence (the share_links.capability_token column write +
// global-uniqueness retry) is thin Drizzle glue layered on top in share-repo.ts.

import type { AxisRole } from "./share";

/**
 * 16 bytes = 128 bits of crypto-random entropy — the floor C-001 requires. base64url
 * encodes 16 bytes as 22 characters (no `=` padding), comfortably ≥ the spec's "22+".
 */
const TOKEN_BYTES = 16;

/** base64url alphabet check — URL-safe means [A-Za-z0-9_-] only (no `+` `/` `=`). */
const URL_SAFE = /^[A-Za-z0-9_-]+$/;

/**
 * Mint one capability token: 128 bits of crypto-random, base64url-encoded.
 *
 * Uses Web Crypto `getRandomValues` (a CSPRNG, available on Bun/Node/browsers) — never
 * Math.random. The token is built ONLY from random bytes, so by construction it cannot
 * contain any part of a doc title (C-001 / AS-002). Encoded base64url so it is URL-safe
 * and globally unique with overwhelming probability (a DB unique index is the hard
 * guarantee — see share-repo.ts).
 */
export function mintCapabilityToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** Encode raw bytes as a base64url string (RFC 4648 §5): `+`→`-`, `/`→`_`, no padding. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Whether a string is a well-formed capability token: URL-safe alphabet and at least
 * 22 chars (the base64url length of 128 bits). Used to assert the invariant in tests
 * and to validate an inbound `/s/:token` shape before a DB lookup.
 */
export function isWellFormedCapabilityToken(token: string): boolean {
  return typeof token === "string" && token.length >= 22 && URL_SAFE.test(token);
}

/**
 * Resolve the capability token for the LINK AXIS (doc-access-two-axis S-001). The link's
 * existence is now driven by the link axis directly, not the derived level: link_role set
 * (ON) ⇒ keep a live token or mint a fresh one; link_role null (OFF) ⇒ null (the token is
 * cleared with the link axis — the old link dies). Independent of the workspace axis.
 */
export function capabilityTokenForLinkAxis(
  linkRole: AxisRole,
  existing: string | null = null,
): string | null {
  if (linkRole == null) return null;
  return existing ?? mintCapabilityToken();
}

/**
 * Resolve the capability token for an EXPLICIT rotate, keyed on the LINK AXIS
 * (doc-access-two-axis S-005 / C-003). The link-axis analogue of `rotateCapabilityTokenFor`:
 * the rotate decision reads `link_role` directly, not the derived level.
 *
 *  - `link_role` set (ON)  → a brand-new crypto-random token over the old one — the whole point
 *    of a rotate is to replace the secret so the old link dies. The existing value is irrelevant
 *    (a fresh mint cannot collide with overwhelming probability).
 *  - `link_role` null (OFF) → null: a doc with no link axis has no capability link, so there is
 *    nothing to rotate. The DB layer / route turns this null into a no-op / 409, never a crash.
 *
 * This differs from `capabilityTokenForLinkAxis`, which KEEPS a live token while the link axis
 * stays set (a role change must NOT rotate, AS-020); rotate is the explicit "replace the secret".
 */
export function rotateCapabilityTokenForLinkAxis(
  linkRole: AxisRole,
  _existing: string | null = null,
): string | null {
  if (linkRole == null) return null;
  return mintCapabilityToken();
}
