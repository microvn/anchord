// Capability-link redeem route (capability-share-link S-002).
//
// `POST /s/:token/redeem` (and the SPA-friendly `GET /s/:token/resolve`) is how an
// anonymous visitor TURNS a capability link into an admission. It:
//   1. validates the token shape, then looks up the doc whose share_links.capability_token
//      matches (AS-005: an unknown token → 404, NO doc/title served — existence-hiding);
//   2. mints a signed admission cookie bound to that docId + the current token-hash + the
//      admitted link role (capability-cookie.ts), so every later anon-reachable request for
//      THIS doc rides the cookie, not the raw token (C-006/C-007);
//   3. returns ONLY { slug, role } so the SPA can load the doc by slug WITHOUT putting the
//      slug in the address bar — the URL stays `/s/<token>` (C-009/AS-004).
//
// Token hygiene (C-008): the raw token is NEVER logged here, and every response sets
// `Referrer-Policy: no-referrer` so the `/s/<token>` URL can't leak via the Referer header.
// (The structured-logging redaction-list mechanism is GAP-003, deferred to S-006 — this
// route simply never logs the token.)
//
// This is a BARE Elysia (no apiEnvelope): it sets a Set-Cookie + a Referrer-Policy header on
// a raw Response, like the /v/:id content surface. It does NOT depend on a better-auth
// session — an anon visitor is the whole point.
//
// NOTE: turning OFF the readable `/d/:slug` anon entry point and making the anon access
// branch REQUIRE this cookie is S-003 (it rewrites resolve-access.ts's anon branch to call
// resolveAdmission). The cookie minted here is exactly what S-003 will check — they are the
// two halves of the same seam (C-002).

import { Elysia } from "elysia";
import {
  ADMISSION_COOKIE_NAME,
  DEFAULT_ADMISSION_TTL_MS,
  mintAdmissionCookie,
  type AdmissionRole,
} from "../sharing/capability-cookie";
import { isWellFormedCapabilityToken } from "../sharing/share-token";

/** What the redeem route needs resolved from a capability token. */
export interface RedeemTarget {
  docId: string;
  /** The doc's readable slug — returned so the SPA loads by slug (NOT shown in the URL). */
  slug: string;
  /** The admitted link role (the share_links.role for the matched doc). */
  role: AdmissionRole;
  /** The doc's link expiry, if any — caps the cookie lifetime (S-006); null = no cap. */
  expiresAt?: Date | null;
}

export interface ShareRedeemRoutesDeps {
  /**
   * Resolve a capability token to its doc, or null when no doc carries that token (AS-005).
   * Keyed on share_links.capability_token (the partial-unique index); a no-match returns
   * null so the route 404s — no doc content and no title are served.
   */
  resolveCapabilityToken: (token: string) => Promise<RedeemTarget | null>;
  /** APP_SECRET — signs the admission cookie + hashes the token (capability-cookie.ts). */
  secret: string;
  /** Whether to mark the cookie `Secure`. Default true (prod over HTTPS); off for local HTTP. */
  secure?: boolean;
  /** Injected clock for deterministic expiry tests. */
  now?: () => number;
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

export function shareRedeemRoutes(deps: ShareRedeemRoutesDeps) {
  const secure = deps.secure ?? true;
  const now = deps.now ?? (() => Date.now());

  /**
   * The core handler shared by both verbs. Resolves the token, mints the cookie, and returns
   * { slug, role }. A bad shape or unknown token → 404 with NO body content (existence-hiding,
   * AS-005). The raw token is never logged.
   */
  async function redeem(token: string): Promise<Response> {
    // Cheap shape gate BEFORE any DB hit — a malformed token can't match the index anyway,
    // and this keeps obviously-bogus values from touching the lookup. 404, not 400, so a
    // probe can't distinguish "wrong shape" from "no such doc" (existence-hiding, AS-005).
    if (!isWellFormedCapabilityToken(token)) {
      return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), {
        status: 404,
        headers: { ...baseHeaders(), "content-type": "application/json" },
      });
    }
    const target = await deps.resolveCapabilityToken(token);
    if (!target) {
      // AS-005: unknown token → not-found; no doc content, no title served.
      return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), {
        status: 404,
        headers: { ...baseHeaders(), "content-type": "application/json" },
      });
    }

    // Cookie lifetime: default 24h, capped at the link's own expiry when sooner (GAP-001/S-006).
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
        // S-002: a passwordless link is "password-cleared" by definition. S-006 will set this
        // only after a correct password; the marker shape exists now so that's a one-field change.
        pwdCleared: true,
        exp,
      },
      deps.secret,
    );

    return new Response(JSON.stringify({ slug: target.slug, role: target.role }), {
      status: 200,
      headers: {
        ...baseHeaders(),
        "content-type": "application/json",
        "Set-Cookie": buildSetCookie(cookieValue, Math.max(0, exp - t), secure),
      },
    });
  }

  return new Elysia()
    // POST is the canonical redeem (a state-changing admission grant). The SPA calls it on
    // mounting `/s/:token`, then renders the doc by the returned slug WITHOUT navigating, so
    // the address bar keeps showing the token, never the slug (C-009/AS-004).
    .post("/s/:token/redeem", ({ params }) => redeem(params.token))
    // GET alias so a direct top-level navigation to the resolve endpoint also works (some
    // SPA shells prefer a GET on first paint). Same existence-hiding + cookie behaviour.
    .get("/s/:token/resolve", ({ params }) => redeem(params.token));
}
