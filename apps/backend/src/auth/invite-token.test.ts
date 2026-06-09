import { test, expect } from "bun:test";
import { mintInviteToken, verifyInviteToken } from "./invite-token";

const SECRET = "x".repeat(32);

test("AS-011: a minted token verifies for its invite id (deterministic, stateless)", () => {
  const token = mintInviteToken("inv_1", SECRET);
  expect(token.length).toBeGreaterThan(0);
  // Re-derivation matches → the accept-link works on every retry (email-independent path).
  expect(mintInviteToken("inv_1", SECRET)).toBe(token);
  expect(verifyInviteToken("inv_1", token, SECRET)).toBe(true);
});

test("AS-011: a token for one invite does NOT verify against another id (bound to the id)", () => {
  const token = mintInviteToken("inv_1", SECRET);
  expect(verifyInviteToken("inv_2", token, SECRET)).toBe(false);
});

test("AS-011: an unforgeable token — wrong secret / garbage token is refused", () => {
  const token = mintInviteToken("inv_1", SECRET);
  expect(verifyInviteToken("inv_1", token, "different-secret")).toBe(false);
  expect(verifyInviteToken("inv_1", "garbage", SECRET)).toBe(false);
  expect(verifyInviteToken("inv_1", "", SECRET)).toBe(false);
});
