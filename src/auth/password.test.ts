import { test, expect } from "bun:test";
import { isPasswordAcceptable, MIN_PASSWORD_LENGTH } from "./password";

// C-006: password minimum 8 chars (NIST-style). isPasswordAcceptable is the pure
// policy function; better-auth enforces the same MIN_PASSWORD_LENGTH at the config.

test("C-006: password shorter than 8 chars is rejected", () => {
  expect(isPasswordAcceptable("1234567")).toBe(false); // 7 chars, just under
  expect(isPasswordAcceptable("a")).toBe(false);
});

test("C-006: password of exactly 8 chars is accepted (boundary)", () => {
  expect(MIN_PASSWORD_LENGTH).toBe(8);
  expect(isPasswordAcceptable("12345678")).toBe(true); // boundary: == min
  expect(isPasswordAcceptable("a-long-enough-passphrase")).toBe(true);
});

test("C-006: empty password is rejected (empty-string edge)", () => {
  expect(isPasswordAcceptable("")).toBe(false);
});

test("C-006: non-string / null / undefined inputs are rejected (invalid-type edge)", () => {
  expect(isPasswordAcceptable(undefined)).toBe(false);
  expect(isPasswordAcceptable(null)).toBe(false);
  expect(isPasswordAcceptable(12345678)).toBe(false); // number long enough but not a string
  expect(isPasswordAcceptable({ length: 99 })).toBe(false);
});
