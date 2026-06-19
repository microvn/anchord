// mcp-roundtrip S-001 — PAT crypto/scope unit tests (C-008/C-009).
// Pure logic: HMAC hashing + constant-time verify, scope normalization, bearer
// parsing, and the coalesced last_used_at predicate. No DB.

import { describe, expect, test } from "bun:test";
import {
  ALL_SCOPES,
  hashToken,
  isScope,
  LAST_USED_COALESCE_MS,
  mintPlaintextToken,
  normalizeScopes,
  parseBearer,
  shouldBumpLastUsed,
  TOKEN_PREFIX,
  TokenScopeError,
  verifyTokenHash,
} from "./token";

const SECRET = "x".repeat(32);

describe("PAT hashing (C-008)", () => {
  test("AS-008: mintPlaintextToken emits the anch_pat_ prefix + high-entropy body", () => {
    const a = mintPlaintextToken();
    const b = mintPlaintextToken();
    expect(a.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(b.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(a).not.toBe(b); // random body each mint
    expect(a.length).toBeGreaterThan(TOKEN_PREFIX.length + 20);
  });

  test("AS-002: hashToken is deterministic + peppered — verify matches only the right secret/plaintext", () => {
    const plain = mintPlaintextToken();
    const stored = hashToken(plain, SECRET);
    // Deterministic: same input → same hash (so an indexed lookup can recompute it).
    expect(hashToken(plain, SECRET)).toBe(stored);
    // The hash is NOT the plaintext (peppered, irreversible to a plain compare).
    expect(stored).not.toContain(plain);
    expect(verifyTokenHash(plain, stored, SECRET)).toBe(true);
    // Wrong secret (the pepper) → no match: a stolen DB alone can't validate guesses.
    expect(verifyTokenHash(plain, stored, "different-secret-aaaaaaaaaaaaa")).toBe(false);
    // Wrong plaintext → no match.
    expect(verifyTokenHash(mintPlaintextToken(), stored, SECRET)).toBe(false);
  });

  test("AS-002: verifyTokenHash never throws on garbage/empty input — returns false", () => {
    const stored = hashToken(mintPlaintextToken(), SECRET);
    expect(verifyTokenHash("", stored, SECRET)).toBe(false);
    expect(verifyTokenHash("garbage", stored, SECRET)).toBe(false);
    expect(verifyTokenHash("anything", "", SECRET)).toBe(false);
    // @ts-expect-error — exercise the non-string guard
    expect(verifyTokenHash(null, stored, SECRET)).toBe(false);
  });
});

describe("scope normalization (C-009)", () => {
  test("AS-011: normalizeScopes dedupes + orders by ALL_SCOPES, rejects unknown + empty", () => {
    expect(normalizeScopes(["docs:write", "docs:read", "docs:read"])).toEqual([
      "docs:read",
      "docs:write",
    ]);
    expect(() => normalizeScopes([])).toThrow(TokenScopeError);
    expect(() => normalizeScopes(["docs:bogus"])).toThrow(TokenScopeError);
    // @ts-expect-error — non-array
    expect(() => normalizeScopes("docs:read")).toThrow(TokenScopeError);
  });

  test("AS-011: isScope only accepts the 6 known scopes", () => {
    for (const s of ALL_SCOPES) expect(isScope(s)).toBe(true);
    expect(ALL_SCOPES).toHaveLength(6);
    expect(isScope("comments:read")).toBe(false); // the old name was renamed
    expect(isScope(42)).toBe(false);
    expect(isScope(undefined)).toBe(false);
  });
});

describe("bearer parsing (AS-001/AS-002)", () => {
  test("AS-001: parseBearer extracts the token, case-insensitive on Bearer", () => {
    expect(parseBearer("Bearer anch_pat_abc")).toBe("anch_pat_abc");
    expect(parseBearer("bearer anch_pat_abc")).toBe("anch_pat_abc");
    expect(parseBearer("Bearer   anch_pat_abc  ")).toBe("anch_pat_abc");
  });

  test("AS-002: parseBearer returns null for absent/malformed headers", () => {
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer("")).toBeNull();
    expect(parseBearer("anch_pat_abc")).toBeNull(); // no scheme
    expect(parseBearer("Bearer ")).toBeNull(); // no token
    expect(parseBearer("Basic abc")).toBeNull();
  });
});

describe("last_used_at coalescing (C-008)", () => {
  test("AS-001: shouldBumpLastUsed is true when never used or window elapsed, false inside the window", () => {
    const now = new Date("2026-06-19T12:00:00Z");
    expect(shouldBumpLastUsed(null, now)).toBe(true); // never used → bump
    const justNow = new Date(now.getTime() - 1_000);
    expect(shouldBumpLastUsed(justNow, now)).toBe(false); // inside the 60s window → no write
    const old = new Date(now.getTime() - LAST_USED_COALESCE_MS - 1);
    expect(shouldBumpLastUsed(old, now)).toBe(true); // window elapsed → bump
  });
});
