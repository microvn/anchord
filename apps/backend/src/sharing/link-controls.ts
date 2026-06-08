// Link controls (sharing S-004): an owner attaches a password / expiry / open-count
// limit to a doc's share link; once expired or over the limit, the link stops working.
//
// AS-009: password link — WRONG password denied (no content leaked); CORRECT gets in.
// AS-010: a 7-day expiry → after expiry the link is "no longer available".
// AS-011: view-limit = N total opens → opens beyond N → "no longer available".
// AS-016: a password link is rate-limited — past a threshold of wrong tries the attempt
//         is temporarily locked (no HTTP-speed guessing).
// C-005:  expired or over view-limit → stops working ("not available" page).
// C-008:  view-limit counts TOTAL opens (every open consumes one), not unique viewers —
//         enforced by the atomic increment in link-controls-repo.ts (tryConsumeView).
// C-010:  the password is HASHED with a KDF (argon2id via Bun.password — the same KDF
//         family better-auth uses for user passwords) and attempts are rate-limited /
//         locked out like login (reusing auth's threshold/window constants).
// C-011:  view-limit is enforced via an ATOMIC increment (see link-controls-repo.ts);
//         expiry + limit are checked server-side on EVERY request before serving.
//
// Pure decision logic + an injectable repo (mirrors share.ts / access.ts). The atomic
// view-limit increment is real-DB and is integration-verified in
// test/integration/share-link.itest.ts (AS-017) — NOT here.

import { SIGNIN_RATE_LIMIT_MAX, SIGNIN_RATE_LIMIT_WINDOW_SECONDS } from "../auth/auth";

// ── Password hashing (C-010) ────────────────────────────────────────────────
// Bun.password defaults to argon2id; no extra dependency, same KDF family better-auth
// uses internally for user passwords. We pin argon2id explicitly so the choice is not
// silently dependent on a Bun default change.

/** Hash a link password with argon2id (C-010). Returns the encoded hash to store in
 *  share_links.password_hash. Throws on empty input (an owner must set a real password). */
export async function setPassword(plain: string): Promise<string> {
  if (typeof plain !== "string" || plain.length === 0) {
    throw new Error("Link password must be a non-empty string");
  }
  return Bun.password.hash(plain, { algorithm: "argon2id" });
}

/** Verify a candidate password against the stored hash (C-010). False on any mismatch
 *  or malformed hash — never throws to the caller, so a bad hash can't leak by error. */
export async function verifyLinkPassword(hash: string, plain: string): Promise<boolean> {
  if (typeof hash !== "string" || hash.length === 0) return false;
  if (typeof plain !== "string" || plain.length === 0) return false;
  try {
    return await Bun.password.verify(plain, hash);
  } catch {
    return false;
  }
}

// ── Expiry (AS-010, C-005) ───────────────────────────────────────────────────

export type ExpiryDecision = { allowed: true } | { allowed: false; reason: "expired" };

/**
 * Decide whether a link is still within its expiry window. `now` is injected (no
 * reliance on Date.now()) so the rule is deterministically testable.
 *   - expiresAt null/undefined → no expiry set, always allowed.
 *   - now strictly AFTER expiresAt → denied ("expired"). At exactly expiresAt the link
 *     is still allowed (the instant of expiry is the last valid moment; it lapses after).
 */
export function checkLinkExpiry(expiresAt: Date | null | undefined, now: Date): ExpiryDecision {
  if (expiresAt == null) return { allowed: true };
  return now.getTime() > expiresAt.getTime()
    ? { allowed: false, reason: "expired" }
    : { allowed: true };
}

// ── Password-attempt rate limiter (AS-016, C-010) ────────────────────────────
// In-memory sliding-ish window keyed by linkId+ip, reusing auth's login threshold /
// window so a password link is no easier to brute-force than a login. Pure, testable
// counter: `now` is injected. This is the same lock-after-threshold shape as sign-in.

/** Max wrong attempts before lockout — same as login (C-010, reuse not a magic number). */
export const LINK_PW_RATE_LIMIT_MAX = SIGNIN_RATE_LIMIT_MAX;
/** Lockout / counting window in seconds — same as login. */
export const LINK_PW_RATE_LIMIT_WINDOW_SECONDS = SIGNIN_RATE_LIMIT_WINDOW_SECONDS;

type AttemptEntry = { count: number; windowStart: number };

export class LinkPasswordRateLimiter {
  private readonly entries = new Map<string, AttemptEntry>();

  constructor(
    private readonly max = LINK_PW_RATE_LIMIT_MAX,
    private readonly windowSeconds = LINK_PW_RATE_LIMIT_WINDOW_SECONDS,
  ) {}

  private static key(linkId: string, ip: string): string {
    return `${linkId}::${ip}`;
  }

  /** True if this (linkId, ip) is currently locked out — at or over `max` within the
   *  window. The window resets after `windowSeconds` of no activity past its start. */
  isLocked(linkId: string, ip: string, now: Date): boolean {
    const entry = this.entries.get(LinkPasswordRateLimiter.key(linkId, ip));
    if (!entry) return false;
    if (this.windowExpired(entry, now)) return false;
    return entry.count >= this.max;
  }

  /** Record one WRONG attempt. Call only on a failed password (a correct one should
   *  reset). Returns whether the caller is now locked. */
  recordFailure(linkId: string, ip: string, now: Date): boolean {
    const key = LinkPasswordRateLimiter.key(linkId, ip);
    const entry = this.entries.get(key);
    if (!entry || this.windowExpired(entry, now)) {
      this.entries.set(key, { count: 1, windowStart: now.getTime() });
      return 1 >= this.max;
    }
    entry.count += 1;
    return entry.count >= this.max;
  }

  /** Clear the counter for a (linkId, ip) — call after a CORRECT password so a genuine
   *  user is never punished for earlier typos. */
  reset(linkId: string, ip: string): void {
    this.entries.delete(LinkPasswordRateLimiter.key(linkId, ip));
  }

  private windowExpired(entry: AttemptEntry, now: Date): boolean {
    return now.getTime() - entry.windowStart >= this.windowSeconds * 1000;
  }
}

// ── Composed access check (AS-009, AS-010, AS-016) ───────────────────────────
// Composes expiry + password + rate-limit into one server-side decision. The
// view-limit is NOT decided here — it is the atomic consume in link-controls-repo.ts,
// which the route calls separately (and only once expiry/password have passed) so the
// counter is never burned on a denied request.

/** The persisted link controls this decision needs (subset of share_links). */
export interface LinkControls {
  id: string;
  passwordHash: string | null;
  expiresAt: Date | null;
}

export type LinkAccessReason =
  | "expired"
  | "password_required"
  | "password_incorrect"
  | "rate_limited";

export type LinkAccessDecision =
  | { allowed: true }
  | { allowed: false; reason: LinkAccessReason };

export interface CheckLinkAccessArgs {
  link: LinkControls;
  now: Date;
  /** Requester IP (rate-limit key). */
  ip: string;
  /** The password the requester supplied, if any. */
  providedPassword?: string;
}

export interface CheckLinkAccessDeps {
  rateLimiter: LinkPasswordRateLimiter;
  verifyPassword: (hash: string, plain: string) => Promise<boolean>;
}

/**
 * Server-side access decision for a share link's controls, run on EVERY request
 * (C-011) before any content is served. Order:
 *   1. expiry (AS-010 / C-005) — cheapest, no secret involved.
 *   2. password gate (AS-009 / C-010): if a hash is set, a password is required;
 *      a wrong one is denied (no content leaked) and counts toward the rate limit;
 *      once locked (AS-016) further tries are refused outright (no hash work, no leak).
 * Returns a clean `{ allowed, reason }` — NEVER content. The route serves the page.
 * view-limit is enforced by the atomic repo op AFTER this returns allowed.
 */
export async function checkLinkAccess(
  args: CheckLinkAccessArgs,
  deps: CheckLinkAccessDeps,
): Promise<LinkAccessDecision> {
  const { link, now, ip, providedPassword } = args;

  // 1. Expiry — server-side, every request (C-005).
  const expiry = checkLinkExpiry(link.expiresAt, now);
  if (!expiry.allowed) return { allowed: false, reason: "expired" };

  // 2. Password gate.
  if (link.passwordHash != null) {
    // AS-016: refuse before doing hash work once locked — no HTTP-speed guessing.
    if (deps.rateLimiter.isLocked(link.id, ip, now)) {
      return { allowed: false, reason: "rate_limited" };
    }
    if (providedPassword == null || providedPassword.length === 0) {
      return { allowed: false, reason: "password_required" };
    }
    const ok = await deps.verifyPassword(link.passwordHash, providedPassword);
    if (!ok) {
      // AS-009: wrong password denied, no content. Count the failure (AS-016).
      deps.rateLimiter.recordFailure(link.id, ip, now);
      return { allowed: false, reason: "password_incorrect" };
    }
    // Correct: clear the counter so honest typos don't compound (AS-016).
    deps.rateLimiter.reset(link.id, ip);
  }

  return { allowed: true };
}

// ── View-limit decision (AS-011, C-008, C-011) ───────────────────────────────
// The DECISION logic that maps the atomic UPDATE's result to allow/deny — unit-tested
// with a fake; the real atomic SQL lives in link-controls-repo.ts and is integration-
// verified (AS-017). Keeping the decision pure lets the unit suite prove the rule
// without a DB while the repo proves the atomicity.

export type ConsumeViewResult = { allowed: true; viewCount: number } | { allowed: false };

/**
 * Interpret the result of the atomic `tryConsumeView` UPDATE.
 *   - `row` present (the conditional UPDATE matched and incremented) → allowed; the
 *     returned viewCount is the new total opens (C-008 counts TOTAL opens).
 *   - `row` undefined (no row matched: view_count was already at view_limit) → denied,
 *     the link is over its limit (AS-011 / C-005 "not available").
 */
export function decideConsumeView(row: { viewCount: number } | undefined): ConsumeViewResult {
  return row ? { allowed: true, viewCount: row.viewCount } : { allowed: false };
}
