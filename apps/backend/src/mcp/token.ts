// mcp-roundtrip S-001 — personal access token (PAT) minting, hashing, and scopes.
//
// A PAT authenticates an agent on /mcp AS the owning user, bound to ONE workspace and a
// scope set (C-001/C-008). The plaintext (`anch_pat_<random>`) is shown ONCE at creation;
// only the HMAC-SHA256(APP_SECRET, plaintext) hash is stored — peppered (a stolen DB alone
// can't validate guesses), indexed for O(1) lookup, and compared constant-time. This reuses
// the HMAC-over-secret pattern from auth/invite-token.ts (NOT argon2/bcrypt: a per-row
// salted KDF can't be indexed, turning every MCP call into a full-table KDF scan).

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Plaintext token prefix — the only part ever echoed back after creation (C-008). */
export const TOKEN_PREFIX = "anch_pat_";

/** The 6 granular scopes (C-009). A token's scope set is a subset of these. */
export const ALL_SCOPES = [
  "docs:read",
  "docs:write",
  "annotations:read",
  "annotations:write",
  "projects:read",
  "projects:write",
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

const SCOPE_SET = new Set<string>(ALL_SCOPES);

/** True when `s` is one of the 6 known scopes. */
export function isScope(s: unknown): s is Scope {
  return typeof s === "string" && SCOPE_SET.has(s);
}

/**
 * Mint a fresh plaintext PAT: the `anch_pat_` prefix + 32 random bytes (base64url).
 * High-entropy and unguessable; returned to the caller exactly once.
 */
export function mintPlaintextToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/**
 * HMAC-SHA256(secret, plaintext) → base64url. Deterministic for a given (plaintext, secret),
 * so the stored hash can be recomputed for an O(1) indexed lookup on every request (C-008).
 */
export function hashToken(plaintext: string, secret: string): string {
  return createHmac("sha256", secret).update(plaintext).digest("base64url");
}

/**
 * Constant-time compare a presented plaintext against a stored hash (re-derive + compare).
 * Returns false on any length/format mismatch — never throws — so the caller maps a bad
 * token to a plain auth refusal (AS-002). The compare is timing-safe so the hash can't be
 * probed byte-by-byte.
 */
export function verifyTokenHash(plaintext: string, storedHash: string, secret: string): boolean {
  if (typeof plaintext !== "string" || plaintext.length === 0) return false;
  if (typeof storedHash !== "string" || storedHash.length === 0) return false;
  const expected = hashToken(plaintext, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(storedHash);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Normalize + validate a requested scope set: dedupe, reject any unknown scope, reject empty.
 * Throws `TokenScopeError` so the issuance path can refuse a bogus request. The stored order
 * follows ALL_SCOPES for a stable, comparable representation.
 */
export class TokenScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenScopeError";
  }
}

export function normalizeScopes(requested: readonly unknown[]): Scope[] {
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new TokenScopeError("a token must request at least one scope");
  }
  const seen = new Set<Scope>();
  for (const s of requested) {
    if (!isScope(s)) {
      throw new TokenScopeError(`unknown scope: ${String(s)}`);
    }
    seen.add(s);
  }
  return ALL_SCOPES.filter((s) => seen.has(s));
}

/**
 * Extract the bearer token from an Authorization header value. Returns the raw token
 * string, or null when the header is absent/malformed (→ auth refusal). Case-insensitive
 * on the `Bearer` keyword per RFC 6750.
 */
export function parseBearer(header: string | null | undefined): string | null {
  if (typeof header !== "string") return null;
  const m = header.match(/^Bearer[ \t]+(.+)$/i);
  if (!m) return null;
  const token = m[1]!.trim();
  return token.length > 0 ? token : null;
}

/**
 * The `last_used_at` write is COALESCED (C-008): at most one bump per token per
 * `intervalMs` (default 60s), so a read-heavy agent doesn't write the row on every call.
 * `shouldBump(lastUsedAt, now)` is the pure predicate the repo consults before an UPDATE.
 */
export const LAST_USED_COALESCE_MS = 60_000;

export function shouldBumpLastUsed(
  lastUsedAt: Date | null,
  now: Date = new Date(),
  intervalMs: number = LAST_USED_COALESCE_MS,
): boolean {
  if (!lastUsedAt) return true;
  return now.getTime() - lastUsedAt.getTime() >= intervalMs;
}
