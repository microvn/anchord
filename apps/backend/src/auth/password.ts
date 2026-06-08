// Password policy (auth C-006). NIST-style: a single minimum-length floor, no
// rigid composition rules. better-auth enforces the same floor via
// `minPasswordLength`; this is the same number as a pure, unit-testable function
// so the policy is asserted in isolation and reused as the config's source of truth.

/** Minimum password length (auth C-006). better-auth hashes; we only gate length. */
export const MIN_PASSWORD_LENGTH = 8;

/** True when `pw` meets the minimum-length policy (C-006). Non-strings are rejected. */
export function isPasswordAcceptable(pw: unknown): pw is string {
  return typeof pw === "string" && pw.length >= MIN_PASSWORD_LENGTH;
}
