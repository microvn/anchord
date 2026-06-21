import { test, expect } from "bun:test";
import {
  mintAdmissionCookie,
  verifyAdmissionCookie,
  resolveAdmission,
  hashCapabilityToken,
} from "./capability-cookie";
import { mintCapabilityToken } from "./share-token";

// capability-share-link S-002: the admission cookie crypto primitive (C-006 carries the role;
// C-007 binds docId + token-hash). UNIT tests of the pure sign/verify/bind logic — no DB, no HTTP.
// The cross-surface "the SAME cookie works on the write path" / "doc A's cookie is refused on doc
// B over real routes" seams are integration tests (share-redeem.itest.ts).

const SECRET = "test-secret-at-least-16-chars-long";

function mint(docId: string, token: string, role: "viewer" | "commenter" | "editor" = "viewer", exp = Date.now() + 3_600_000) {
  return mintAdmissionCookie({ docId, token, role, pwdCleared: true, exp }, SECRET);
}

test("C-006: a verified admission cookie carries the admitted link role so follow-up writes are authorized", async () => {
  const token = mintCapabilityToken();
  const claims = verifyAdmissionCookie(mint("doc_A", token, "commenter"), SECRET);
  expect(claims).not.toBeNull();
  expect(claims!.role).toBe("commenter"); // the role that authorizes the WRITE path, not just read.
  expect(claims!.pwdCleared).toBe(true);
});

test("C-007.a: resolveAdmission accepts a cookie bound to THIS doc + the CURRENT token", async () => {
  const token = mintCapabilityToken();
  const cookie = mint("doc_A", token, "commenter");
  const claims = resolveAdmission(cookie, "doc_A", token, SECRET);
  expect(claims).not.toBeNull();
  expect(claims!.docId).toBe("doc_A");
});

test("AS-020 / C-007.a: a cookie minted for doc A is refused on doc B (cross-doc replay)", async () => {
  const token = mintCapabilityToken();
  const cookieForA = mint("doc_A", token, "commenter");
  // Even though the cookie itself is validly signed, binding to doc B fails (docId mismatch).
  expect(verifyAdmissionCookie(cookieForA, SECRET)).not.toBeNull(); // signature is fine...
  expect(resolveAdmission(cookieForA, "doc_B", token, SECRET)).toBeNull(); // ...but it's bound to A.
});

test("C-007: a cookie minted from the OLD token is refused after the token rotates (stale token-hash)", async () => {
  const oldToken = mintCapabilityToken();
  const cookie = mint("doc_A", oldToken, "commenter");
  expect(resolveAdmission(cookie, "doc_A", oldToken, SECRET)).not.toBeNull(); // current token → ok
  // Rotate: the doc's current token is now different → the bound token-hash no longer matches (AS-021's
  // mechanism, built here so S-004 can rely on it).
  const newToken = mintCapabilityToken();
  expect(resolveAdmission(cookie, "doc_A", newToken, SECRET)).toBeNull();
});

test("C-007: resolveAdmission refuses when the doc has no current token (link sharing turned off)", async () => {
  const token = mintCapabilityToken();
  const cookie = mint("doc_A", token);
  // currentToken null (S-004 cleared it) → no admission possible even with a valid old cookie.
  expect(resolveAdmission(cookie, "doc_A", null, SECRET)).toBeNull();
});

test("C-007: a forged/tampered cookie signature is refused (not minted by APP_SECRET)", async () => {
  const token = mintCapabilityToken();
  const cookie = mint("doc_A", token);
  // Tamper the signature segment.
  const tampered = cookie.slice(0, cookie.lastIndexOf(".") + 1) + "forgedsignature";
  expect(verifyAdmissionCookie(tampered, SECRET)).toBeNull();
  // A different secret can't verify it either.
  expect(verifyAdmissionCookie(cookie, "another-secret-16-characters")).toBeNull();
});

test("C-007 (boundary): an expired admission cookie is refused (absolute expiry, not renewed)", async () => {
  const token = mintCapabilityToken();
  const past = Date.now() - 1000;
  const cookie = mint("doc_A", token, "viewer", past);
  expect(verifyAdmissionCookie(cookie, SECRET)).toBeNull();
  expect(resolveAdmission(cookie, "doc_A", token, SECRET)).toBeNull();
});

test("C-007 (null/empty/garbled input): missing/garbled cookie → null, never throws", async () => {
  const token = mintCapabilityToken();
  expect(verifyAdmissionCookie(undefined, SECRET)).toBeNull();
  expect(verifyAdmissionCookie(null, SECRET)).toBeNull();
  expect(verifyAdmissionCookie("", SECRET)).toBeNull();
  expect(verifyAdmissionCookie("no-dot-segment", SECRET)).toBeNull();
  expect(verifyAdmissionCookie(".onlysig", SECRET)).toBeNull();
  // resolveAdmission tolerates the same garbage.
  expect(resolveAdmission(undefined, "doc_A", token, SECRET)).toBeNull();
});

test("C-008: the cookie stores a token HASH, never the raw token (the secret can't re-leak via the cookie)", async () => {
  const token = mintCapabilityToken();
  const cookie = mint("doc_A", token);
  // The raw token never appears in the cookie value; only its HMAC hash does.
  expect(cookie).not.toContain(token);
  const claims = verifyAdmissionCookie(cookie, SECRET)!;
  expect(claims.tokenHash).toBe(hashCapabilityToken(token, SECRET));
  expect(claims.tokenHash).not.toBe(token);
});
