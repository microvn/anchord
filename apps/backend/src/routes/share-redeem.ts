// Capability-link redeem route (capability-share-link S-002 + S-006).
//
// `POST /s/:token/redeem` (and the SPA-friendly `GET /s/:token/resolve`) is how an
// anonymous visitor TURNS a capability link into an admission. It:
//   1. validates the token shape, then looks up the doc whose share_links.capability_token
//      matches (AS-005: an unknown token → 404, NO doc/title served — existence-hiding);
//   2. ENFORCES the owner's link controls BEFORE serving (S-006 / C-003): expiry (AS-014),
//      password (AS-017/AS-018), then the atomic view-limit consume (AS-016) — exactly once
//      per OPEN, after every other gate passes so a denied request never burns a view
//      (AS-022/AS-023);
//   3. mints a signed admission cookie bound to that docId + the current token-hash + the
//      admitted link role (capability-cookie.ts), so every later anon-reachable request for
//      THIS doc rides the cookie, not the raw token (C-006/C-007) — the cookie carries the
//      pwdCleared marker so follow-up reads in the same session never re-prompt (AS-017);
//   4. returns ONLY { slug, role } so the SPA can load the doc by slug WITHOUT putting the
//      slug in the address bar — the URL stays `/s/<token>` (C-009/AS-004).
//
// Order of checks (S-006 — load-bearing for AS-022/AS-023):
//   shape → resolve token → expiry → password (rate-limited) → CONSUME one view → mint+serve.
// Password is checked BEFORE the view consume, so a wrong password (or a rate-limited one)
// short-circuits and consumes no view (AS-022). The view consume is the LAST gate before the
// (infallible, pure-crypto) cookie mint, so a passing redemption that then fails to serve
// can't leave a phantom view — there is nothing fallible between consume and serve (AS-023).
//
// Token hygiene (C-008): the raw token is NEVER logged here, and every response sets
// `Referrer-Policy: no-referrer` so the `/s/<token>` URL can't leak via the Referer header.
// This route simply never passes the token to any logger (GAP-003 — the simplest correct
// redaction: don't log it at all; there is no request logger emitting the path here).
//
// This is a BARE Elysia (no apiEnvelope): it sets a Set-Cookie + a Referrer-Policy header on
// a raw Response, like the /v/:id content surface. It does NOT depend on a better-auth
// session — an anon visitor is the whole point.

import { Elysia } from "elysia";
import {
  ADMISSION_COOKIE_NAME,
  DEFAULT_ADMISSION_TTL_MS,
  mintAdmissionCookie,
  type AdmissionRole,
} from "../sharing/capability-cookie";
import { isWellFormedCapabilityToken } from "../sharing/share-token";
import {
  checkLinkExpiry,
  LinkPasswordRateLimiter,
  verifyLinkPassword,
  type ConsumeViewResult,
} from "../sharing/link-controls";

/** What the redeem route needs resolved from a capability token. */
export interface RedeemTarget {
  docId: string;
  /** The doc's readable slug — returned so the SPA loads by slug (NOT shown in the URL). */
  slug: string;
  /** The admitted link role (the share_links.role for the matched doc). */
  role: AdmissionRole;
  /** The doc's link expiry, if any — caps the cookie lifetime (S-006); null = no cap. */
  expiresAt?: Date | null;
  /**
   * The argon2id password hash an owner set on the link, if any (S-006 / AS-017/AS-018).
   * null/absent → no password gate. The plaintext is never resolved here; the route verifies
   * the visitor-supplied password against this hash.
   */
  passwordHash?: string | null;
  /**
   * The link's total-open limit, if any (S-006 / AS-016). null/absent → unlimited. The actual
   * enforcement is the atomic `consumeView` op (so concurrent opens can't overshoot); this is
   * only carried so the route knows whether a consume is even gated.
   */
  viewLimit?: number | null;
}

export interface ShareRedeemRoutesDeps {
  /**
   * Resolve a capability token to its doc, or null when no doc carries that token (AS-005).
   * Keyed on share_links.capability_token (the partial-unique index); a no-match returns
   * null so the route 404s — no doc content and no title are served.
   */
  resolveCapabilityToken: (token: string) => Promise<RedeemTarget | null>;
  /**
   * S-006 / AS-016 / AS-015 / AS-023: atomically consume ONE view for the doc's link, returning
   * `{ allowed: true, viewCount }` when a slot remained, or `{ allowed: false }` when the link
   * is at/over its view limit. The atomic `WHERE view_count < view_limit RETURNING` shape lives
   * in link-controls-repo.tryConsumeView (the DB is the arbiter — no read-then-write race). The
   * route calls this exactly ONCE per redemption, AFTER expiry + password pass, so a denied open
   * never burns a view (AS-022) and follow-up SPA reads riding the admission cookie never each
   * consume a view (AS-015). Omit (tests / a no-limit deployment) → no view accounting.
   */
  consumeView?: (docId: string) => Promise<ConsumeViewResult>;
  /** APP_SECRET — signs the admission cookie + hashes the token (capability-cookie.ts). */
  secret: string;
  /** Whether to mark the cookie `Secure`. Default true (prod over HTTPS); off for local HTTP. */
  secure?: boolean;
  /** Injected clock for deterministic expiry tests. */
  now?: () => number;
  /**
   * S-006 / AS-018: the IP-keyed password-attempt rate limiter (reused, same threshold/window as
   * login — link-controls.LinkPasswordRateLimiter). Injectable for deterministic tests; defaults
   * to a per-route singleton so a real deployment throttles brute-force across requests.
   */
  rateLimiter?: LinkPasswordRateLimiter;
  /** Injectable password verifier (defaults to the argon2id verifyLinkPassword). */
  verifyPassword?: (hash: string, plain: string) => Promise<boolean>;
}

/** Build the `Set-Cookie` value for the admission cookie: HTTP-only, Secure, SameSite=Lax,
 *  Path=/, with an absolute Max-Age matching the signed `exp`. SameSite=Lax (not Strict) so a
 *  top-level navigation into the doc still carries it; the cookie is never read cross-site. */
function buildSetCookie(value: string, ttlMs: number, secure: boolean): string {
  const maxAgeSec = Math.max(0, Math.floor(ttlMs / 1000));
  const attrs = [
    `${ADMISSION_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** Common headers on every redeem response: no-referrer so the token can't leak (C-008). */
function baseHeaders(): Record<string, string> {
  return { "Referrer-Policy": "no-referrer" };
}

function jsonResponse(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...baseHeaders(), "content-type": "application/json", ...extra },
  });
}

/**
 * Best-effort client IP for the password rate-limit key (C-008-adjacent — same shape as the
 * comment rate-limiter). Prefers the first `x-forwarded-for` hop (the real client behind a
 * reverse proxy), then `x-real-ip`, then a literal "unknown" so a missing header still buckets.
 */
function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/** The visitor-supplied password from the redeem POST body (S-006). Tolerant: a missing/garbled
 *  body is "no password supplied", not a 500 — the password gate then prompts. */
async function readProvidedPassword(request: Request): Promise<string | undefined> {
  if (request.method !== "POST") return undefined;
  try {
    const ct = request.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) return undefined;
    const body = (await request.json()) as { password?: unknown };
    return typeof body?.password === "string" && body.password.length > 0 ? body.password : undefined;
  } catch {
    return undefined;
  }
}

export function shareRedeemRoutes(deps: ShareRedeemRoutesDeps) {
  const secure = deps.secure ?? true;
  const now = deps.now ?? (() => Date.now());
  const rateLimiter = deps.rateLimiter ?? new LinkPasswordRateLimiter();
  const verifyPassword = deps.verifyPassword ?? verifyLinkPassword;

  /**
   * The core handler shared by both verbs. Resolves the token, enforces the link controls
   * (S-006), mints the cookie, and returns { slug, role }. A bad shape or unknown token → 404
   * with NO body content (existence-hiding, AS-005). The raw token is never logged.
   */
  async function redeem(token: string, request: Request): Promise<Response> {
    // Cheap shape gate BEFORE any DB hit — a malformed token can't match the index anyway,
    // and this keeps obviously-bogus values from touching the lookup. 404, not 400, so a
    // probe can't distinguish "wrong shape" from "no such doc" (existence-hiding, AS-005).
    if (!isWellFormedCapabilityToken(token)) {
      return jsonResponse(404, { error: { code: "NOT_FOUND" } });
    }
    const target = await deps.resolveCapabilityToken(token);
    if (!target) {
      // AS-005: unknown token → not-found; no doc content, no title served.
      return jsonResponse(404, { error: { code: "NOT_FOUND" } });
    }

    const nowDate = new Date(now());

    // ── 1. Expiry (S-006 / AS-014 / C-003.expiry) — cheapest gate, no secret involved. An
    //    expired link is refused BEFORE any password work or view consume; the visitor is told
    //    the link has expired. No view is consumed (we never reach the consume).
    if (!checkLinkExpiry(target.expiresAt ?? null, nowDate).allowed) {
      return jsonResponse(410, { error: { code: "LINK_EXPIRED" } });
    }

    // ── 2. Password (S-006 / AS-017 / AS-018 / C-003.password). When the link is password-
    //    protected, a correct password is required BEFORE the view consume (so a wrong password
    //    burns no view — AS-022). Repeated wrong tries are throttled by the IP-keyed limiter
    //    (reused from login — AS-018). A correct password resets the counter.
    let pwdCleared = true;
    if (target.passwordHash != null) {
      const ip = clientIp(request);
      // AS-018: once locked, refuse BEFORE any hash work — no HTTP-speed guessing, and crucially
      // no view consume (429, distinct from the 401 prompt so the FE can back off).
      if (rateLimiter.isLocked(target.docId, ip, nowDate)) {
        return jsonResponse(429, { error: { code: "LINK_PASSWORD_RATE_LIMITED" } });
      }
      const provided = await readProvidedPassword(request);
      if (provided == null) {
        // AS-017: no password supplied → prompt (the FE password gate). No view consumed.
        return jsonResponse(401, { error: { code: "LINK_PASSWORD_REQUIRED" } });
      }
      const ok = await verifyPassword(target.passwordHash, provided);
      if (!ok) {
        // AS-018/AS-022: wrong password → denied, counted toward the rate limit, NO view consumed.
        rateLimiter.recordFailure(target.docId, ip, nowDate);
        return jsonResponse(401, { error: { code: "LINK_PASSWORD_INCORRECT" } });
      }
      // Correct: clear the counter so honest typos don't compound.
      rateLimiter.reset(target.docId, ip);
      pwdCleared = true;
    }

    // ── 3. View-limit consume (S-006 / AS-016 / AS-015 / AS-023 / C-003.viewlimit). The LAST
    //    gate before serving: an atomic increment-while-under-limit. A link at/over its limit
    //    gets no slot → refused, viewCount unchanged (AS-016). Exactly ONE consume per redemption
    //    (AS-015) — follow-up SPA reads ride the admission cookie, never this route. It runs only
    //    AFTER expiry + password pass, so a denied open never burns a view (AS-022). Nothing
    //    fallible sits between this consume and the (pure-crypto) cookie mint below, so a passing
    //    redemption can't strand a phantom view (AS-023).
    if (deps.consumeView) {
      const consumed = await deps.consumeView(target.docId);
      if (!consumed.allowed) {
        return jsonResponse(410, { error: { code: "LINK_NO_LONGER_AVAILABLE" } });
      }
    }

    // ── 4. Serve: mint the admission cookie + return { slug, role }. Cookie lifetime: default
    //    24h, capped at the link's own expiry when sooner (GAP-001/S-006). The pwdCleared marker
    //    rides the cookie so follow-up reads in the same session never re-prompt (AS-017).
    const t = now();
    let exp = t + DEFAULT_ADMISSION_TTL_MS;
    if (target.expiresAt) {
      exp = Math.min(exp, target.expiresAt.getTime());
    }
    const cookieValue = mintAdmissionCookie(
      {
        docId: target.docId,
        token,
        role: target.role,
        pwdCleared,
        exp,
      },
      deps.secret,
    );

    return jsonResponse(
      200,
      { slug: target.slug, role: target.role },
      { "Set-Cookie": buildSetCookie(cookieValue, Math.max(0, exp - t), secure) },
    );
  }

  return new Elysia()
    // POST is the canonical redeem (a state-changing admission grant). The SPA calls it on
    // mounting `/s/:token`, then renders the doc by the returned slug WITHOUT navigating, so
    // the address bar keeps showing the token, never the slug (C-009/AS-004). The optional
    // JSON body carries `{ password }` for a password-protected link (S-006).
    .post("/s/:token/redeem", ({ params, request }) => redeem(params.token, request), {
      // The route reads the body itself (readProvidedPassword); keep Elysia from draining it.
      parse: "none",
    })
    // GET alias so a direct top-level navigation to the resolve endpoint also works (some
    // SPA shells prefer a GET on first paint). Same existence-hiding + cookie behaviour. A GET
    // carries no body, so a password-protected link via GET always prompts (the POST is the
    // password path).
    .get("/s/:token/resolve", ({ params, request }) => redeem(params.token, request));
}
