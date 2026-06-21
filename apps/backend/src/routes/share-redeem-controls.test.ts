import { test, expect, describe } from "bun:test";
import { Elysia } from "elysia";
import { shareRedeemRoutes, type RedeemTarget } from "./share-redeem";
import { mintCapabilityToken } from "../sharing/share-token";
import { ADMISSION_COOKIE_NAME, verifyAdmissionCookie } from "../sharing/capability-cookie";
import {
  setPassword,
  LinkPasswordRateLimiter,
  LINK_PW_RATE_LIMIT_MAX,
  type ConsumeViewResult,
} from "../sharing/link-controls";

// capability-share-link S-006: the redeem route ENFORCES the owner's link controls (expiry /
// view-limit / password) BEFORE the doc is served (C-003). These UNIT tests drive the real
// redeem route with an injected token resolver + an injected `consumeView` spy, so they prove
// the ORDER of checks and the view-accounting seams without a DB:
//   shape → resolve → expiry → password (rate-limited) → CONSUME one view → mint + serve.
// The atomic-under-concurrency consume itself is the share-link integration test; here we count
// how many times the spy is called to prove "one open = one view" / "wrong pw = no view".
//
// AS-015 (one-open-one-view despite multi-load + refocus) and AS-023 (no phantom view on a
// failed serve) are the view-accounting seams; the real redeem + real viewer-load version is
// share-redeem.itest.ts (integration). Here we prove the route consumes exactly once per
// redemption and only after every other gate passes.

const SECRET = "test-secret-at-least-16-chars-long";

/** A consumeView spy: counts calls, returns allowed unless a fixed `denyAfter` cap is hit. */
function consumeSpy(opts: { limit?: number } = {}) {
  let count = 0;
  const calls: string[] = [];
  const fn = async (docId: string): Promise<ConsumeViewResult> => {
    calls.push(docId);
    if (opts.limit != null && count >= opts.limit) return { allowed: false };
    count += 1;
    return { allowed: true, viewCount: count };
  };
  return {
    fn,
    get count() {
      return calls.length;
    },
    get consumed() {
      return count;
    },
  };
}

function appWith(
  target: RedeemTarget | null,
  extra: Partial<Parameters<typeof shareRedeemRoutes>[0]> = {},
) {
  const goodToken = (target as { _token?: string })?._token ?? mintCapabilityToken();
  const resolveCapabilityToken = async (token: string): Promise<RedeemTarget | null> =>
    token === goodToken && target ? target : null;
  const app = new Elysia().use(
    shareRedeemRoutes({ resolveCapabilityToken, secret: SECRET, secure: false, ...extra }),
  );
  return { app, token: goodToken };
}

function post(
  app: { handle: (req: Request) => Promise<Response> },
  token: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return app.handle(
    new Request(`http://localhost/s/${token}/redeem`, {
      method: "POST",
      headers: body !== undefined ? { "content-type": "application/json", ...headers } : headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
}

// ── AS-014 — an expired link does not open ───────────────────────────────────
describe("AS-014: an expired link does not open", () => {
  test("AS-014: expiresAt = yesterday → refused (not served), the visitor is told it expired; NO view consumed", async () => {
    const fixedNow = 1_700_000_000_000;
    const yesterday = new Date(fixedNow - 24 * 60 * 60 * 1000);
    const spy = consumeSpy();
    const { app, token } = appWith(
      { docId: "d", slug: "s", role: "viewer", expiresAt: yesterday, viewLimit: 5 },
      { now: () => fixedNow, consumeView: spy.fn },
    );
    const res = await post(app, token);
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("LINK_EXPIRED");
    // No doc/title/slug served, no cookie minted.
    expect(JSON.stringify(body)).not.toContain("slug");
    expect(res.headers.get("set-cookie")).toBeNull();
    // C-003 ordering: expiry short-circuits BEFORE the view consume — count unchanged.
    expect(spy.count).toBe(0);
  });

  test("AS-014.T1 (boundary): a link expiring in the future still opens and serves", async () => {
    const fixedNow = 1_700_000_000_000;
    const tomorrow = new Date(fixedNow + 24 * 60 * 60 * 1000);
    const { app, token } = appWith(
      { docId: "d", slug: "live-spec", role: "viewer", expiresAt: tomorrow },
      { now: () => fixedNow },
    );
    const res = await post(app, token);
    expect(res.status).toBe(200);
    expect((await res.json()).slug).toBe("live-spec");
  });
});

// ── AS-016 — a link past its view limit no longer opens ──────────────────────
describe("AS-016: a link past its view limit no longer opens", () => {
  test("AS-016: consume returns not-allowed (limit reached) → refused, no-longer-available, no cookie", async () => {
    const spy = consumeSpy({ limit: 0 }); // already at limit → first consume denies
    const { app, token } = appWith(
      { docId: "d", slug: "s", role: "viewer", viewLimit: 5 },
      { consumeView: spy.fn },
    );
    const res = await post(app, token);
    expect(res.status).toBe(410);
    expect((await res.json()).error.code).toBe("LINK_NO_LONGER_AVAILABLE");
    expect(res.headers.get("set-cookie")).toBeNull();
    // It DID attempt the atomic consume (the DB is the arbiter); the consume returned no slot.
    expect(spy.count).toBe(1);
    expect(spy.consumed).toBe(0); // the spy's internal limit means no increment happened
  });

  test("AS-016.T1: under the limit → exactly one consume, the doc is served", async () => {
    const spy = consumeSpy({ limit: 5 });
    const { app, token } = appWith(
      { docId: "d", slug: "s", role: "viewer", viewLimit: 5 },
      { consumeView: spy.fn },
    );
    const res = await post(app, token);
    expect(res.status).toBe(200);
    expect(spy.count).toBe(1);
    expect(spy.consumed).toBe(1); // viewCount becomes 1 after a single open (AS-015 data)
  });
});

// ── AS-015 — opening counts exactly one view despite multiple loads ──────────
describe("AS-015: one OPEN = one view (the route consumes once per redemption)", () => {
  test("AS-015: a single redemption calls consumeView exactly once (not once per later SPA load)", async () => {
    const spy = consumeSpy({ limit: 5 });
    const { app, token } = appWith(
      { docId: "d", slug: "s", role: "viewer", viewLimit: 5 },
      { consumeView: spy.fn },
    );
    await post(app, token);
    expect(spy.count).toBe(1);
    // The doc read / annotations / versions / refocus reads ride the admission cookie, NOT this
    // route — so they never re-redeem and never re-consume. Proven end-to-end in the itest.
  });

  test("AS-015.T1: a SECOND redemption (a new session re-open) consumes another view", async () => {
    const spy = consumeSpy({ limit: 5 });
    const { app, token } = appWith(
      { docId: "d", slug: "s", role: "viewer", viewLimit: 5 },
      { consumeView: spy.fn },
    );
    await post(app, token);
    await post(app, token);
    expect(spy.count).toBe(2);
    expect(spy.consumed).toBe(2);
  });
});

// ── AS-017 — a correct password opens the link and is not re-asked ───────────
describe("AS-017: a correct password opens the link and is not re-asked", () => {
  test("AS-017: correct password → doc served, admission cookie carries pwdCleared=true (no re-prompt in session)", async () => {
    const hash = await setPassword("letmein");
    const spy = consumeSpy({ limit: 5 });
    const { app, token } = appWith(
      { docId: "d", slug: "secret-spec", role: "commenter", passwordHash: hash, viewLimit: 5 },
      { consumeView: spy.fn },
    );
    const res = await post(app, token, { password: "letmein" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string; role: string };
    expect(body).toEqual({ slug: "secret-spec", role: "commenter" });
    // The cookie marks the session password-cleared → later reads riding it never re-prompt.
    const setCookie = res.headers.get("set-cookie") ?? "";
    const value = setCookie.split(";")[0]!.split("=").slice(1).join("=");
    const claims = verifyAdmissionCookie(value, SECRET);
    expect(claims).not.toBeNull();
    expect(claims!.pwdCleared).toBe(true);
    expect(claims!.docId).toBe("d");
    // One view consumed only on the successful admission (AS-022 inverse).
    expect(spy.consumed).toBe(1);
  });

  test("AS-017.T1: no password supplied on a protected link → 401 prompt, NOT served, no view consumed", async () => {
    const hash = await setPassword("letmein");
    const spy = consumeSpy({ limit: 5 });
    const { app, token } = appWith(
      { docId: "d", slug: "s", role: "viewer", passwordHash: hash, viewLimit: 5 },
      { consumeView: spy.fn },
    );
    const res = await post(app, token); // no body
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("LINK_PASSWORD_REQUIRED");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(spy.count).toBe(0);
  });
});

// ── AS-018 — a wrong password does not open, repeats are throttled ───────────
describe("AS-018: a wrong password does not open, and repeats are throttled", () => {
  test("AS-018: wrong password → 401 not served; after MAX failed attempts → 429 throttled", async () => {
    const hash = await setPassword("letmein");
    const rl = new LinkPasswordRateLimiter();
    const { app, token } = appWith(
      { docId: "doc-pw", slug: "s", role: "viewer", passwordHash: hash, viewLimit: 5 },
      { rateLimiter: rl },
    );
    // Each wrong attempt is refused (not served).
    for (let i = 0; i < LINK_PW_RATE_LIMIT_MAX; i++) {
      const res = await post(app, token, { password: "nope" }, { "x-forwarded-for": "9.9.9.9" });
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("LINK_PASSWORD_INCORRECT");
    }
    // The (MAX+1)th attempt from the same IP is now throttled — even the CORRECT password.
    const throttled = await post(app, token, { password: "letmein" }, { "x-forwarded-for": "9.9.9.9" });
    expect(throttled.status).toBe(429);
    expect((await throttled.json()).error.code).toBe("LINK_PASSWORD_RATE_LIMITED");
    expect(throttled.headers.get("set-cookie")).toBeNull();
  });
});

// ── AS-022 — a wrong password does not consume a view ────────────────────────
describe("AS-022: a wrong password does not consume a view", () => {
  test("AS-022: wrong password on a view-limited link → NOT served AND consumeView never called", async () => {
    const hash = await setPassword("letmein");
    const spy = consumeSpy({ limit: 5 });
    const { app, token } = appWith(
      { docId: "d", slug: "s", role: "viewer", passwordHash: hash, viewLimit: 5 },
      { consumeView: spy.fn },
    );
    const res = await post(app, token, { password: "wrong" });
    expect(res.status).toBe(401);
    // The view consume sits AFTER the password gate, so a wrong password short-circuits before it.
    expect(spy.count).toBe(0);
    expect(spy.consumed).toBe(0);
  });

  test("AS-022.T1: a rate-limited (locked) attempt also consumes no view", async () => {
    const hash = await setPassword("letmein");
    const rl = new LinkPasswordRateLimiter();
    const spy = consumeSpy({ limit: 5 });
    const { app, token } = appWith(
      { docId: "d", slug: "s", role: "viewer", passwordHash: hash, viewLimit: 5 },
      { rateLimiter: rl, consumeView: spy.fn },
    );
    for (let i = 0; i < LINK_PW_RATE_LIMIT_MAX; i++) {
      await post(app, token, { password: "nope" }, { "x-forwarded-for": "1.2.3.4" });
    }
    const throttled = await post(app, token, { password: "letmein" }, { "x-forwarded-for": "1.2.3.4" });
    expect(throttled.status).toBe(429);
    expect(spy.count).toBe(0); // never reached the consume on any of the attempts
  });
});

// ── C-008 — raw token never logged; Referrer-Policy: no-referrer on served-doc responses ──
describe("C-008: token hygiene on the served + control-denied responses", () => {
  test("C-008: every control-outcome response sets Referrer-Policy: no-referrer (served, expired, limit, password)", async () => {
    const fixedNow = 1_700_000_000_000;
    const hash = await setPassword("pw");
    // expired
    const exp = appWith(
      { docId: "d", slug: "s", role: "viewer", expiresAt: new Date(fixedNow - 1000) },
      { now: () => fixedNow },
    );
    expect((await post(exp.app, exp.token)).headers.get("referrer-policy")).toBe("no-referrer");
    // view-limit denied
    const lim = appWith(
      { docId: "d", slug: "s", role: "viewer", viewLimit: 1 },
      { consumeView: consumeSpy({ limit: 0 }).fn },
    );
    expect((await post(lim.app, lim.token)).headers.get("referrer-policy")).toBe("no-referrer");
    // password prompt
    const pw = appWith({ docId: "d", slug: "s", role: "viewer", passwordHash: hash });
    expect((await post(pw.app, pw.token)).headers.get("referrer-policy")).toBe("no-referrer");
    // served
    const ok = appWith({ docId: "d", slug: "s", role: "viewer" });
    expect((await post(ok.app, ok.token)).headers.get("referrer-policy")).toBe("no-referrer");
  });
});
