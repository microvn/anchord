// Unit tests for sharing S-004 — apply link controls (password / expiry / view-limit).
// Pure decision logic against fakes; the ATOMIC view-limit under concurrency is proven
// separately in test/integration/share-link.itest.ts (AS-017, real Postgres).

import { describe, expect, test } from "bun:test";
import {
  checkLinkAccess,
  checkLinkExpiry,
  decideConsumeView,
  LinkPasswordRateLimiter,
  LINK_PW_RATE_LIMIT_MAX,
  LINK_PW_RATE_LIMIT_WINDOW_SECONDS,
  setPassword,
  verifyLinkPassword,
  type CheckLinkAccessDeps,
  type LinkControls,
} from "./link-controls";
import { SIGNIN_RATE_LIMIT_MAX, SIGNIN_RATE_LIMIT_WINDOW_SECONDS } from "../auth/auth";

const NOW = new Date("2026-06-07T12:00:00Z");

function deps(over: Partial<CheckLinkAccessDeps> = {}): CheckLinkAccessDeps {
  return {
    rateLimiter: new LinkPasswordRateLimiter(),
    verifyPassword: verifyLinkPassword,
    ...over,
  };
}

// ── AS-009 — password link: wrong denied (no leak), correct gets in ──────────
describe("AS-009: password link — wrong denied, correct gets in", () => {
  test("AS-009: WRONG password is denied with no content (allowed:false), CORRECT password gets in", async () => {
    const hash = await setPassword("correct horse battery");
    const link: LinkControls = { id: "lnk1", passwordHash: hash, expiresAt: null };

    const wrong = await checkLinkAccess(
      { link, now: NOW, ip: "1.1.1.1", providedPassword: "guess" },
      deps(),
    );
    expect(wrong).toEqual({ allowed: false, reason: "password_incorrect" });
    // No content field on the decision — the function never carries the doc (no leak).
    expect("content" in wrong).toBe(false);

    const right = await checkLinkAccess(
      { link, now: NOW, ip: "1.1.1.1", providedPassword: "correct horse battery" },
      deps(),
    );
    expect(right).toEqual({ allowed: true });
  });

  test("AS-009.T1: a password link with NO password supplied → password_required (not a leak)", async () => {
    const hash = await setPassword("s3cret-pw");
    const link: LinkControls = { id: "lnk2", passwordHash: hash, expiresAt: null };
    const d = await checkLinkAccess({ link, now: NOW, ip: "2.2.2.2" }, deps());
    expect(d).toEqual({ allowed: false, reason: "password_required" });
  });

  test("AS-009.T2: a link with NO password set is allowed without one", async () => {
    const link: LinkControls = { id: "lnk3", passwordHash: null, expiresAt: null };
    const d = await checkLinkAccess({ link, now: NOW, ip: "3.3.3.3" }, deps());
    expect(d).toEqual({ allowed: true });
  });
});

// ── C-010 — password hashed with a KDF ───────────────────────────────────────
describe("C-010: link password is hashed with a KDF (argon2id)", () => {
  test("C-010: setPassword returns an argon2id hash (not plaintext), verify round-trips", async () => {
    const plain = "my-link-password";
    const hash = await setPassword(plain);
    expect(hash).not.toBe(plain);
    expect(hash).toContain("argon2id"); // PHC-string prefix proves the KDF used
    expect(await verifyLinkPassword(hash, plain)).toBe(true);
    expect(await verifyLinkPassword(hash, "wrong")).toBe(false);
  });

  test("C-010.T1: setPassword rejects an empty password (owner must set a real one)", async () => {
    await expect(setPassword("")).rejects.toThrow();
  });

  test("C-010.T2: verifyLinkPassword returns false (never throws) on a malformed/empty hash — special chars safe", async () => {
    expect(await verifyLinkPassword("", "x")).toBe(false);
    expect(await verifyLinkPassword("not-a-valid-phc-string", "x")).toBe(false);
    // Unicode / special-char password round-trips through the KDF.
    const h = await setPassword("pä$$wörd-🔐-' OR 1=1");
    expect(await verifyLinkPassword(h, "pä$$wörd-🔐-' OR 1=1")).toBe(true);
  });
});

// ── AS-010 — expired link stops working ──────────────────────────────────────
describe("AS-010: expired link stops working", () => {
  const created = new Date("2026-06-01T00:00:00Z");
  const sevenDays = new Date(created.getTime() + 7 * 24 * 60 * 60 * 1000); // 2026-06-08

  test("AS-010: a 7-day expiry → opened AFTER expiry is denied (expired)", () => {
    const after = new Date(sevenDays.getTime() + 1000);
    expect(checkLinkExpiry(sevenDays, after)).toEqual({ allowed: false, reason: "expired" });
  });

  test("AS-010.T1: before expiry → still allowed", () => {
    const before = new Date(sevenDays.getTime() - 1000);
    expect(checkLinkExpiry(sevenDays, before)).toEqual({ allowed: true });
  });

  test("AS-020: expiry boundary — valid at exactly the expiry instant, denied one moment after", () => {
    expect(checkLinkExpiry(sevenDays, sevenDays)).toEqual({ allowed: true });
    expect(checkLinkExpiry(sevenDays, new Date(sevenDays.getTime() + 1))).toEqual({
      allowed: false,
      reason: "expired",
    });
  });

  test("AS-010.T3 (null): no expiry set → always allowed", () => {
    expect(checkLinkExpiry(null, NOW)).toEqual({ allowed: true });
    expect(checkLinkExpiry(undefined, NOW)).toEqual({ allowed: true });
  });

  test("AS-021 / C-005 / C-013: an expired link is refused before any password check (expiry→lockout→password)", async () => {
    const link: LinkControls = {
      id: "lnk-exp",
      passwordHash: await setPassword("pw"),
      expiresAt: new Date(NOW.getTime() - 1000),
    };
    // Even with the CORRECT password, expiry short-circuits → "expired" (not available).
    const d = await checkLinkAccess(
      { link, now: NOW, ip: "9.9.9.9", providedPassword: "pw" },
      deps(),
    );
    expect(d).toEqual({ allowed: false, reason: "expired" });
  });
});

// ── AS-011 / C-008 — over view-limit → stops working; counts TOTAL opens ──────
describe("AS-011: over view-limit → stops working (C-008 counts TOTAL opens)", () => {
  test("AS-011: no row returned from the atomic consume (limit reached) → denied", () => {
    expect(decideConsumeView(undefined)).toEqual({ allowed: false });
  });

  test("C-008: a returned row → allowed, carrying the new TOTAL open count", () => {
    expect(decideConsumeView({ viewCount: 1 })).toEqual({ allowed: true, viewCount: 1 });
    // Each open increments the same total regardless of who opened it (TOTAL, not unique).
    expect(decideConsumeView({ viewCount: 5 })).toEqual({ allowed: true, viewCount: 5 });
  });
});

// ── AS-016 — password link rate-limited ──────────────────────────────────────
describe("AS-016: password link rate-limited / locked after a threshold", () => {
  test("AS-016: after MAX wrong attempts the (link, ip) is locked", () => {
    const rl = new LinkPasswordRateLimiter();
    let locked = false;
    for (let i = 0; i < LINK_PW_RATE_LIMIT_MAX; i++) {
      expect(rl.isLocked("L", "ip", NOW)).toBe(false); // not locked until the threshold hit
      locked = rl.recordFailure("L", "ip", NOW);
    }
    expect(locked).toBe(true);
    expect(rl.isLocked("L", "ip", NOW)).toBe(true);
  });

  test("AS-016.T1: a locked link refuses checkLinkAccess BEFORE hashing — no HTTP-speed guessing, no leak", async () => {
    const rl = new LinkPasswordRateLimiter();
    for (let i = 0; i < LINK_PW_RATE_LIMIT_MAX; i++) rl.recordFailure("L", "ip", NOW);
    const link: LinkControls = { id: "L", passwordHash: await setPassword("pw"), expiresAt: null };
    let verifyCalls = 0;
    const d = await checkLinkAccess(
      { link, now: NOW, ip: "ip", providedPassword: "pw" }, // even the right pw is refused while locked
      deps({
        rateLimiter: rl,
        verifyPassword: async (...a) => {
          verifyCalls++;
          return verifyLinkPassword(...a);
        },
      }),
    );
    expect(d).toEqual({ allowed: false, reason: "rate_limited" });
    expect(verifyCalls).toBe(0); // refused before the KDF runs
  });

  test("AS-019 / C-014: a correct password resets the wrong-attempt counter (honest typos don't compound)", async () => {
    const rl = new LinkPasswordRateLimiter();
    rl.recordFailure("L", "ip", NOW);
    rl.recordFailure("L", "ip", NOW);
    const link: LinkControls = { id: "L", passwordHash: await setPassword("pw"), expiresAt: null };
    const d = await checkLinkAccess(
      { link, now: NOW, ip: "ip", providedPassword: "pw" },
      deps({ rateLimiter: rl }),
    );
    expect(d).toEqual({ allowed: true });
    // After success the counter is cleared.
    for (let i = 0; i < LINK_PW_RATE_LIMIT_MAX - 1; i++) rl.recordFailure("L", "ip", NOW);
    expect(rl.isLocked("L", "ip", NOW)).toBe(false);
  });

  test("AS-016.T3: the lock lapses after the window — a fresh attempt past the window is not locked", () => {
    const rl = new LinkPasswordRateLimiter();
    for (let i = 0; i < LINK_PW_RATE_LIMIT_MAX; i++) rl.recordFailure("L", "ip", NOW);
    expect(rl.isLocked("L", "ip", NOW)).toBe(true);
    const past = new Date(NOW.getTime() + (LINK_PW_RATE_LIMIT_WINDOW_SECONDS * 1000 + 1));
    expect(rl.isLocked("L", "ip", past)).toBe(false);
  });

  test("C-010: link rate-limit reuses login's threshold/window (no separate magic number)", () => {
    expect(LINK_PW_RATE_LIMIT_MAX).toBe(SIGNIN_RATE_LIMIT_MAX);
    expect(LINK_PW_RATE_LIMIT_WINDOW_SECONDS).toBe(SIGNIN_RATE_LIMIT_WINDOW_SECONDS);
  });
});

// ── C-011 — checked server-side on EVERY request (composition order) ──────────
describe("C-011: expiry + password enforced server-side every request", () => {
  test("C-011: checkLinkAccess is a pure server-side decision returning {allowed,reason} with no content", async () => {
    const link: LinkControls = { id: "x", passwordHash: null, expiresAt: null };
    const d = await checkLinkAccess({ link, now: NOW, ip: "ip" }, deps());
    expect(Object.keys(d)).toEqual(["allowed"]); // allowed:true carries nothing else
  });
});
