import { test, expect } from "bun:test";
import {
  mintCapabilityToken,
  capabilityTokenFor,
  rotateCapabilityTokenFor,
  isWellFormedCapabilityToken,
} from "./share-token";
import { shareUrl } from "./share-state";

// capability-share-link S-001: minting an unguessable capability token for a shared doc.
//
// UNIT tests of the PURE token primitive — the generator + the transition logic — with no
// DB. They assert the token's crypto/entropy/URL-safe/no-title properties (C-001) and that
// a token is present iff the doc is anyone_with_link. The persistence (the
// share_links.capability_token column + the global-unique index) is integration glue in
// share-repo.ts, verified later.

// base64url length of N random bytes (no padding) = ceil(N*4/3). 16 bytes → 22 chars.
const BITS_128_MIN_LEN = 22;

test("AS-001: sharing to anyone-with-link mints a capability link keyed by a token distinct from the readable slug", () => {
  // Given a doc whose general access is restricted (no token).
  // When the owner sets general access to anyone-with-link.
  const token = capabilityTokenFor("anyone_with_link", null);

  // Then a capability token is minted...
  expect(token).not.toBeNull();
  expect(isWellFormedCapabilityToken(token!)).toBe(true);

  // ...and it addresses the doc distinctly from the readable /d/<slug> address.
  // Data: title "Refund Spec" → slug "refund-spec-xxxxxx"; token unrelated to "refund".
  const readableSlug = "refund-spec-9f3a1c";
  const capabilityPath = `/s/${token}`;
  expect(capabilityPath).not.toBe(shareUrl(readableSlug));
  expect(token!.toLowerCase()).not.toContain("refund");
});

test("AS-002: the capability token is crypto-random, >=128-bit, URL-safe, and leaks no part of the doc title", () => {
  // Given a doc shared to anyone-with-link; When its token is generated.
  // >=128 bits of entropy → at least 22 base64url chars.
  const token = mintCapabilityToken();
  expect(token.length).toBeGreaterThanOrEqual(BITS_128_MIN_LEN);

  // URL-safe: base64url alphabet only — no `+`, `/`, `=`, or other unsafe chars.
  expect(token).toMatch(/^[A-Za-z0-9_-]+$/);

  // Crypto-random: two mints are overwhelmingly unlikely to collide. A large sample with
  // zero duplicates demonstrates high entropy (not a low-entropy counter/slug suffix).
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) seen.add(mintCapabilityToken());
  expect(seen.size).toBe(2000);

  // No part of the doc title. Data: title "Q3 Roadmap" → token contains neither.
  for (const part of ["q3", "roadmap"]) {
    expect(token.toLowerCase()).not.toContain(part);
  }
});

test("AS-003: a restricted or anyone-in-workspace doc has no capability link", () => {
  // Given a doc whose general access is NOT anyone-with-link; When its share state is read.
  // Then no capability token is present (cleared on the transition away from shared).
  expect(capabilityTokenFor("restricted", null)).toBeNull();
  expect(capabilityTokenFor("anyone_in_workspace", null)).toBeNull();

  // Even if a token existed before (the doc WAS shared), moving to a non-shared level
  // clears it — the old link is gone (S-004 leans on this clear).
  const live = mintCapabilityToken();
  expect(capabilityTokenFor("restricted", live)).toBeNull();
  expect(capabilityTokenFor("anyone_in_workspace", live)).toBeNull();
});

test("C-001: a capability token is unguessable — >=128-bit crypto, URL-safe, globally unique, and carries no title", () => {
  // Entropy + URL-safe shape (the unguessability core). 16 random bytes = 128 bits.
  const samples = Array.from({ length: 5000 }, () => mintCapabilityToken());
  for (const t of samples) {
    expect(t.length).toBeGreaterThanOrEqual(BITS_128_MIN_LEN);
    expect(isWellFormedCapabilityToken(t)).toBe(true);
  }
  // Globally unique with overwhelming probability — 5000 mints, no collision.
  expect(new Set(samples).size).toBe(5000);

  // Re-saving the SAME anyone-with-link level keeps the existing token (no silent
  // rotation here — rotation is S-004's explicit action); it is NOT title-derived.
  const existing = mintCapabilityToken();
  expect(capabilityTokenFor("anyone_with_link", existing)).toBe(existing);
});

// ── S-004: explicit rotation decision (PURE) ─────────────────────────────────

test("AS-011: rotating a live anyone_with_link doc mints a FRESH token, distinct from the old (the role/level are the route's concern, not this pure step)", () => {
  // Given a doc that is anyone_with_link with a live token; When the owner rotates it.
  const old = mintCapabilityToken();
  const next = rotateCapabilityTokenFor("anyone_with_link", old);

  // Then a NEW, well-formed token is minted — never the old value resurrected (C-004).
  expect(next).not.toBeNull();
  expect(next).not.toBe(old);
  expect(isWellFormedCapabilityToken(next!)).toBe(true);
});

test("AS-010: re-minting on anyone_with_link always yields a value DIFFERENT from any prior token (old stays dead)", () => {
  // Even rotating repeatedly never collides with the previous token — each rotate is a
  // fresh crypto mint, so the old link is permanently dead (C-004).
  let prev = mintCapabilityToken();
  for (let i = 0; i < 1000; i++) {
    const next = rotateCapabilityTokenFor("anyone_with_link", prev)!;
    expect(next).not.toBe(prev);
    expect(isWellFormedCapabilityToken(next)).toBe(true);
    prev = next;
  }
});

test("C-004 (edge): rotating a doc that is NOT anyone_with_link is a no-op — no token (no crash, nothing to rotate)", () => {
  // A restricted / anyone_in_workspace doc has no capability link, so there is nothing to
  // rotate. The pure decision refuses by returning null (the route turns this into a 409/no-op),
  // whether or not a stale token value is passed in.
  expect(rotateCapabilityTokenFor("restricted", null)).toBeNull();
  expect(rotateCapabilityTokenFor("anyone_in_workspace", null)).toBeNull();
  expect(rotateCapabilityTokenFor("restricted", mintCapabilityToken())).toBeNull();
});
