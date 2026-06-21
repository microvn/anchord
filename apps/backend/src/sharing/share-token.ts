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
// AS-003: a doc that is NOT `anyone_with_link` (restricted / anyone_in_workspace) has
//   no capability token — `capabilityTokenFor` resolves to null for those levels.
//
// This module is PURE (no DB): the transition logic + the generator are unit-testable
// in isolation. The persistence (the share_links.capability_token column write +
// global-uniqueness retry) is thin Drizzle glue layered on top in share-repo.ts.

import type { GeneralAccessLevel } from "./share";

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
 * Resolve the capability token for a general-access transition (PURE — no DB).
 *
 *  - `anyone_with_link`  → a token MUST be present. If the doc already has a live
 *    token (`existing`) it is kept (re-saving the same access level does not silently
 *    rotate the link — rotation is S-004's explicit action); otherwise a fresh one is
 *    minted (AS-001).
 *  - any other level (`restricted` / `anyone_in_workspace`) → null: the doc has NO
 *    capability link (AS-003). Going back to a shared level later mints a NEW token,
 *    so the old link stays dead (S-004 leans on this).
 *
 * @param level     the general-access level being set
 * @param existing  the doc's current capability_token, if any (null when none)
 */
export function capabilityTokenFor(
  level: GeneralAccessLevel,
  existing: string | null = null,
): string | null {
  if (level !== "anyone_with_link") return null;
  return existing ?? mintCapabilityToken();
}
