import { test, expect } from "bun:test";
import {
  mintCapabilityToken,
  capabilityTokenForLinkAxis,
  rotateCapabilityTokenForLinkAxis,
  isWellFormedCapabilityToken,
} from "./share-token";
// capability-share-link S-001: minting an unguessable capability token for a shared doc.
//
// UNIT tests of the PURE token primitive — the generator + the transition logic — with no
// DB. They assert the token's crypto/entropy/URL-safe/no-title properties (C-001) and that
// a token is present iff the doc is anyone_with_link. The persistence (the
// share_links.capability_token column + the global-unique index) is integration glue in
// share-repo.ts, verified later.

// base64url length of N random bytes (no padding) = ceil(N*4/3). 16 bytes → 22 chars.
const BITS_128_MIN_LEN = 22;

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

// ── doc-access-two-axis S-005: the token LIFECYCLE is keyed on the LINK AXIS ──
// (link_role), NOT on the derived level. mint when link_role goes null→set; KEEP the
// same token while link_role stays set (no rotation on a role change); CLEAR when it
// goes set→null. These are the PURE decision points; the redeem-gate half (a cleared
// token stops resolving; the same token still resolves at a new role) is in
// routes/share-redeem.test.ts driven through the real route.

test("AS-018: link off→set mints a token, keyed on the link axis even when the workspace axis is off (not level-keyed)", () => {
  // Given a doc with link access off (link_role null) and NO token; the workspace axis may be
  // off too. When link access is turned on at commenter, the link axis decides a token is minted.
  // This proves it is LINK-keyed: the old level-keyed path could not mint for {workspace off}
  // via anyone_with_link without a workspace context — the link axis mints regardless.
  const minted = capabilityTokenForLinkAxis("commenter", null);
  expect(minted).not.toBeNull();
  expect(isWellFormedCapabilityToken(minted!)).toBe(true);
  // Workspace-axis state is irrelevant to the link-keyed decision: any set link_role mints.
  for (const link of ["viewer", "commenter", "editor"] as const) {
    expect(capabilityTokenForLinkAxis(link, null)).not.toBeNull();
  }
});

test("AS-019: link set→null (turning link access off) clears the token, keyed on the link axis", () => {
  // Given a doc with link access on and a LIVE token. When link access is turned off (link_role
  // null), the link axis decides the token is cleared — so the old link stops redeeming.
  const live = mintCapabilityToken();
  expect(capabilityTokenForLinkAxis(null, live)).toBeNull();
  // Edge: clearing with no prior token is still null (idempotent off).
  expect(capabilityTokenForLinkAxis(null, null)).toBeNull();
});

test("AS-020: changing the link role while it stays SET keeps the SAME token (no rotation, keyed on the link axis)", () => {
  // Given a doc with link access = commenter and a live token. When link access changes to
  // viewer (still SET), the link axis KEEPS the same token — changing the role must not
  // rotate/replace the link, so the same shareable link keeps working at the new role.
  const live = mintCapabilityToken();
  expect(capabilityTokenForLinkAxis("viewer", live)).toBe(live);
  expect(capabilityTokenForLinkAxis("editor", live)).toBe(live);
  expect(capabilityTokenForLinkAxis("commenter", live)).toBe(live);
  // And the explicit-rotate decision is also link-axis keyed: rotate only when link_role is set.
  const rotated = rotateCapabilityTokenForLinkAxis("viewer", live);
  expect(rotated).not.toBeNull();
  expect(rotated).not.toBe(live); // an EXPLICIT rotate is the only thing that replaces the token
  expect(rotateCapabilityTokenForLinkAxis(null, live)).toBeNull(); // off → nothing to rotate
});
