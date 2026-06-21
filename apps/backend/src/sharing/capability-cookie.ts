// Capability admission cookie (capability-share-link S-002).
//
// When an anonymous visitor successfully opens a capability link (`GET /s/<token>`, see
// share-redeem.ts), the server issues a SIGNED, HTTP-only, Secure, SameSite admission
// cookie. That cookie — NOT the raw token in the URL — is what authorizes every later
// anon-reachable request for that doc (the doc read, its annotations/versions/diff reads,
// and the comment/resolve writes — C-006). This module is the PURE crypto primitive: it
// mints and verifies the cookie value, with no DB and no HTTP. The redeem route + the
// (S-003) anon access branch are the thin glue that calls it.
//
// What the signed payload binds (C-007 / Data Model):
//   - docId        — the cookie is for ONE doc; presented against doc B it is refused
//                    (cross-doc replay, AS-020).
//   - tokenHash    — an HMAC of the CURRENT capability token, so rotating/clearing the
//                    token invalidates every cookie minted from the old token (the hash no
//                    longer matches — AS-021, S-004 leans on this). We store a HASH, never
//                    the raw token, so the cookie never re-leaks the secret.
//   - role         — the admitted link role (viewer/commenter/editor), so follow-up
//                    writes are authorized at the link role without re-redeeming.
//   - pwdCleared   — a "password-cleared" marker (S-006 reads it; S-002 always mints it
//                    true for a passwordless link, false otherwise — the shape exists now
//                    so S-006 is a one-field change, not a re-mint).
//   - exp          — a bounded ABSOLUTE expiry (epoch ms). NOT renewed on read. The redeem
//                    route caps it at the link's own expiry when that is sooner (S-006).
//
// Signing reuses the SAME idiom as invite-token.ts: HMAC-SHA256 keyed by APP_SECRET,
// base64url, verified by recomputation with a timing-safe compare. No new crypto lib.

import { createHmac, timingSafeEqual } from "node:crypto";

/** The cookie name carrying the admission grant. One per browser/session is enough — the
 *  payload's docId binds it, so a visitor opening several docs simply re-redeems each. */
export const ADMISSION_COOKIE_NAME = "anchord_cap";

/** Default absolute lifetime: 24h (Data Model / GAP-001). Capped at the link's own expiry
 *  by the caller (S-006) when that is sooner. */
export const DEFAULT_ADMISSION_TTL_MS = 24 * 60 * 60 * 1000;

const SIG_CONTEXT = "cap-admission:";
const TOKEN_HASH_CONTEXT = "cap-token-hash:";

/** The admitted link role carried in the cookie (mirrors ShareRole). */
export type AdmissionRole = "viewer" | "commenter" | "editor";

/** The claims bound into a (verified) admission cookie. */
export interface AdmissionClaims {
  /** The doc this cookie admits — bound so a cookie for A is refused on B (C-007/AS-020). */
  docId: string;
  /** HMAC of the capability token that was live at mint time (C-007/AS-021). */
  tokenHash: string;
  /** The admitted link role — authorizes follow-up reads/writes at this role (C-006). */
  role: AdmissionRole;
  /** "password-cleared" marker (S-006); S-002 mints true for a passwordless link. */
  pwdCleared: boolean;
  /** Absolute expiry, epoch ms. NOT renewed on read. */
  exp: number;
}

/**
 * Derive a stable, non-reversible hash of a capability token (C-007). HMAC-SHA256 keyed by
 * the app secret so the hash can't be precomputed off a stolen cookie, and so it changes
 * the instant the token rotates (a new token → a new hash → the old cookie's bound hash no
 * longer matches → refused, AS-021). Never stores/derives from the title.
 */
export function hashCapabilityToken(token: string, secret: string): string {
  return createHmac("sha256", secret).update(TOKEN_HASH_CONTEXT + token).digest("base64url");
}

/** Encode an object as a URL-safe base64 segment (no `=` padding, `+`→`-`, `/`→`_`). */
function encodeSegment(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

/** Sign a payload segment: HMAC-SHA256(secret, context + segment), base64url. */
function sign(segment: string, secret: string): string {
  return createHmac("sha256", secret).update(SIG_CONTEXT + segment).digest("base64url");
}

/**
 * Mint the admission cookie VALUE (the string to set as the cookie). Format is
 * `<payloadSegment>.<signature>` — the payload is recoverable (it carries no secret, only
 * the token HASH), and the signature makes it unforgeable (only APP_SECRET can produce it).
 *
 * The caller (redeem route) supplies the docId, the live token, the admitted role, the
 * password-cleared marker, and the absolute expiry. We hash the token here so the raw token
 * is never written into the cookie.
 */
export function mintAdmissionCookie(
  input: {
    docId: string;
    token: string;
    role: AdmissionRole;
    pwdCleared: boolean;
    exp: number;
  },
  secret: string,
): string {
  const claims: AdmissionClaims = {
    docId: input.docId,
    tokenHash: hashCapabilityToken(input.token, secret),
    role: input.role,
    pwdCleared: input.pwdCleared,
    exp: input.exp,
  };
  const segment = encodeSegment(claims);
  return `${segment}.${sign(segment, secret)}`;
}

/**
 * Verify a presented admission cookie value and return its claims, or null when the cookie
 * is absent/garbled, the signature doesn't verify (forged/tampered), or it has expired.
 * Never throws — a bad cookie is a plain "no admission", not a 500.
 *
 * This does NOT bind to a specific doc/token — that's the CALLER's check (compare
 * `claims.docId` to the doc being requested and `claims.tokenHash` to the live token's
 * hash). Splitting it keeps the binding decision (C-007) where the doc context lives.
 */
export function verifyAdmissionCookie(
  value: string | undefined | null,
  secret: string,
  now: number = Date.now(),
): AdmissionClaims | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const segment = value.slice(0, dot);
  const presentedSig = value.slice(dot + 1);
  const expectedSig = sign(segment, secret);
  // Timing-safe signature compare (reject on any length/format mismatch).
  const a = Buffer.from(expectedSig);
  const b = Buffer.from(presentedSig);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  let claims: AdmissionClaims;
  try {
    claims = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as AdmissionClaims;
  } catch {
    return null;
  }
  // Shape + absolute-expiry guards. The signature already proved we minted it, but a
  // truncated/extended payload that still parses must not slip through with missing fields.
  if (
    typeof claims.docId !== "string" ||
    typeof claims.tokenHash !== "string" ||
    typeof claims.role !== "string" ||
    typeof claims.pwdCleared !== "boolean" ||
    typeof claims.exp !== "number"
  ) {
    return null;
  }
  if (now >= claims.exp) return null; // absolute expiry, NOT renewed on read.
  return claims;
}

/**
 * The cross-doc + token-binding check (C-007), kept here so both the redeem route and the
 * (S-003) anon access branch decide admission the SAME way. Returns the admitted claims when
 * the cookie is valid AND bound to THIS doc AND minted from the CURRENT token; null otherwise
 * (absent/forged/expired cookie, a cookie for another doc — AS-020, or a stale token — AS-021).
 *
 * @param cookieValue  the raw admission cookie string from the request
 * @param docId        the doc being requested
 * @param currentToken the doc's CURRENT capability token (null when the doc is not link-shared)
 * @param secret       APP_SECRET
 */
export function resolveAdmission(
  cookieValue: string | undefined | null,
  docId: string,
  currentToken: string | null,
  secret: string,
  now: number = Date.now(),
): AdmissionClaims | null {
  if (!currentToken) return null; // doc not link-shared → no admission possible.
  const claims = verifyAdmissionCookie(cookieValue, secret, now);
  if (!claims) return null;
  if (claims.docId !== docId) return null; // C-007/AS-020: bound to another doc.
  if (claims.tokenHash !== hashCapabilityToken(currentToken, secret)) return null; // C-007/AS-021: stale token.
  return claims;
}
