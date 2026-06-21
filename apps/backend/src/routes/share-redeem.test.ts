import { test, expect } from "bun:test";
import { Elysia } from "elysia";
import { shareRedeemRoutes, type RedeemTarget } from "./share-redeem";
import {
  mintCapabilityToken,
  capabilityTokenFor,
  rotateCapabilityTokenFor,
} from "../sharing/share-token";
import { verifyAdmissionCookie, ADMISSION_COOKIE_NAME } from "../sharing/capability-cookie";

// capability-share-link S-002: opening a doc through its capability link.
//
// These UNIT tests drive the redeem route with an injected `resolveCapabilityToken` fake (no
// DB). They prove the route's contract: a valid token → an admission cookie bound to the doc +
// link role + the slug returned for SPA load (but NOT in the URL — C-009/AS-004); an unknown
// token → 404 with no doc/title (existence-hiding, AS-005); the raw token never re-leaks via a
// Referer (C-008). The cross-SURFACE seams (cookie authorizes the WRITE path — AS-006; cookie
// for doc A refused on doc B — AS-020) are integration tests against the real app + DB.

const SECRET = "test-secret-at-least-16-chars-long";

/** Build the route with a fake resolver that returns `target` for `goodToken`, null otherwise. */
function appFor(goodToken: string, target: RedeemTarget | null, now?: () => number) {
  const resolveCapabilityToken = async (token: string): Promise<RedeemTarget | null> =>
    token === goodToken ? target : null;
  return new Elysia().use(
    shareRedeemRoutes({ resolveCapabilityToken, secret: SECRET, secure: false, now }),
  );
}

function redeem(app: ReturnType<typeof appFor>, token: string) {
  return app.handle(new Request(`http://localhost/s/${token}/redeem`, { method: "POST" }));
}

test("AS-004: an anon opens a viewer-role capability link → doc served at the link role, slug returned for SPA load (not the URL)", async () => {
  // Given an anon visitor with a valid capability link to an anyone_with_link doc, link role viewer.
  const token = mintCapabilityToken();
  const target: RedeemTarget = { docId: "doc_A", slug: "refund-spec-9f3a1c", role: "viewer" };
  const res = await redeem(appFor(token, target), token);

  // Then the redeem succeeds and returns ONLY { slug, role } — the SPA loads by slug WITHOUT
  // putting it in the address bar (C-009/AS-004). The link role is viewer → no comment affordance.
  expect(res.status).toBe(200);
  const body = (await res.json()) as { slug: string; role: string };
  expect(body).toEqual({ slug: "refund-spec-9f3a1c", role: "viewer" });

  // And an admission cookie is set, bound (on verify) to THIS doc at the viewer role.
  const setCookie = res.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain(`${ADMISSION_COOKIE_NAME}=`);
  const value = setCookie.split(";")[0]!.split("=").slice(1).join("=");
  const claims = verifyAdmissionCookie(value, SECRET);
  expect(claims).not.toBeNull();
  expect(claims!.docId).toBe("doc_A");
  expect(claims!.role).toBe("viewer");
});

test("C-002.a: a commenter capability link admits the anon at the link role via capability-link-open", async () => {
  // The link role IS the grant (Google-Docs model): a commenter link admits the guest at commenter,
  // so the WRITE path is later authorized (the seam itself is the AS-006 integration test).
  const token = mintCapabilityToken();
  const res = await redeem(
    appFor(token, { docId: "doc_C", slug: "plan-7a2b", role: "commenter" }),
    token,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { role: string };
  expect(body.role).toBe("commenter");
  const value = (res.headers.get("set-cookie") ?? "").split(";")[0]!.split("=").slice(1).join("=");
  expect(verifyAdmissionCookie(value, SECRET)!.role).toBe("commenter");
});

test("AS-005: an unknown token → 404 not-found, no doc content and no title served", async () => {
  // Given an anon visitor; When they open a capability link whose token matches no doc.
  // Data: a well-formed but unmatched token → not found.
  const token = mintCapabilityToken();
  const res = await redeem(appFor(token, { docId: "x", slug: "x", role: "viewer" }), mintCapabilityToken());
  expect(res.status).toBe(404);
  const body = (await res.json()) as Record<string, unknown>;
  // No doc/title leaked — only the error code.
  expect(body.slug).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain("title");
  // And no admission cookie is minted for a non-match.
  expect(res.headers.get("set-cookie")).toBeNull();
});

test("AS-005: the literal spec token 'deadbeefdeadbeefdeadbe' matches no doc → 404", async () => {
  // Data (spec): token = "deadbeefdeadbeefdeadbe" (22 chars, well-formed but no match) → not found.
  const res = await redeem(
    appFor(mintCapabilityToken(), { docId: "x", slug: "x", role: "viewer" }),
    "deadbeefdeadbeefdeadbe",
  );
  expect(res.status).toBe(404);
});

test("AS-005: a malformed (too-short) token → 404 without a DB lookup, indistinguishable from no-match", async () => {
  // A bad shape can't match the unique index; it 404s the same as an unknown token (no 400 leak).
  let lookups = 0;
  const app = new Elysia().use(
    shareRedeemRoutes({
      resolveCapabilityToken: async () => {
        lookups++;
        return null;
      },
      secret: SECRET,
      secure: false,
    }),
  );
  const res = await app.handle(new Request("http://localhost/s/short/redeem", { method: "POST" }));
  expect(res.status).toBe(404);
  expect(lookups).toBe(0); // the shape gate refused before any lookup.
});

test("C-009: the redeem response never carries the readable slug in a redirect/Location — the URL stays the token", async () => {
  // C-009: a capability visitor is never bounced to /d/:slug. The route returns 200 JSON with the
  // slug in the BODY (for SPA load), NOT a 3xx redirect to the slug — so the address bar can't change.
  const token = mintCapabilityToken();
  const res = await redeem(appFor(token, { docId: "d", slug: "secret-title-abc", role: "viewer" }), token);
  expect(res.status).toBe(200);
  expect(res.headers.get("location")).toBeNull();
});

test("C-008: every redeem response sets Referrer-Policy: no-referrer so the /s/<token> URL can't leak via Referer", async () => {
  const token = mintCapabilityToken();
  const ok = await redeem(appFor(token, { docId: "d", slug: "s", role: "viewer" }), token);
  expect(ok.headers.get("referrer-policy")).toBe("no-referrer");
  // Also on the 404 path — a probe's Referer is just as sensitive.
  const miss = await redeem(appFor(token, { docId: "d", slug: "s", role: "viewer" }), mintCapabilityToken());
  expect(miss.headers.get("referrer-policy")).toBe("no-referrer");
});

// ── S-004: off kills the link; re-enable / rotate issues a fresh one ─────────
//
// These drive the REAL redeem route against a small in-memory "doc" whose level + token are
// mutated by the SAME pure decision functions the production repo uses (capabilityTokenFor /
// rotateCapabilityTokenFor) — so "old token no longer resolves at /s/:token, new one does" is
// proven through the production redeem path, not a hand-rolled stub. The cookie-invalidation
// half (AS-021) is the cross-surface integration test (capability-rotate.itest.ts).

/** A mutable single-doc store whose resolver mirrors createCapabilityTokenRepo's guard:
 *  a token resolves ONLY when it equals the doc's CURRENT token AND the doc is anyone_with_link. */
function lifecycleApp() {
  const doc = {
    docId: "doc_L",
    slug: "lifecycle-spec-1a2b",
    role: "commenter" as const,
    level: "anyone_with_link" as "anyone_with_link" | "restricted",
    token: capabilityTokenFor("anyone_with_link", null), // freshly minted on enter
  };
  const resolveCapabilityToken = async (token: string): Promise<RedeemTarget | null> => {
    if (doc.level !== "anyone_with_link" || !doc.token || token !== doc.token) return null;
    return { docId: doc.docId, slug: doc.slug, role: doc.role };
  };
  const app = new Elysia().use(
    shareRedeemRoutes({ resolveCapabilityToken, secret: SECRET, secure: false }),
  );
  return { app, doc };
}

test("AS-009: setting access back to restricted clears the token → the old capability link no longer resolves at /s/:token", async () => {
  const { app, doc } = lifecycleApp();
  const old = doc.token!;
  // Live link resolves first.
  expect((await redeem(app, old)).status).toBe(200);

  // Owner sets general access back to restricted → token cleared (the production transition).
  doc.level = "restricted";
  doc.token = capabilityTokenFor("restricted", old); // → null

  // The previously-shared link no longer serves the doc.
  const res = await redeem(app, old);
  expect(res.status).toBe(404);
  expect(res.headers.get("set-cookie")).toBeNull();
});

test("AS-010: re-enabling anyone_with_link mints a NEW token (≠ old) that resolves, while the old token stays dead", async () => {
  const { app, doc } = lifecycleApp();
  const old = doc.token!;
  // Turn it off (old link dead)…
  doc.level = "restricted";
  doc.token = capabilityTokenFor("restricted", old);
  expect((await redeem(app, old)).status).toBe(404);

  // …then re-enable. Re-entering from no token mints a fresh one, NOT the resurrected old.
  doc.level = "anyone_with_link";
  doc.token = capabilityTokenFor("anyone_with_link", doc.token);
  const fresh = doc.token!;
  expect(fresh).not.toBe(old);

  // The new link works; the old one is permanently dead (C-004).
  expect((await redeem(app, fresh)).status).toBe(200);
  expect((await redeem(app, old)).status).toBe(404);
});

test("AS-011: rotating while sharing stays ON → old token stops resolving, the new token serves, link role UNCHANGED", async () => {
  const { app, doc } = lifecycleApp();
  const old = doc.token!;
  const roleBefore = doc.role;
  expect((await redeem(app, old)).status).toBe(200);

  // Explicit rotate while still anyone_with_link.
  doc.token = rotateCapabilityTokenFor("anyone_with_link", old);
  const fresh = doc.token!;
  expect(fresh).not.toBe(old);

  // Old refused, new serves, generalAccess + role unchanged.
  expect((await redeem(app, old)).status).toBe(404);
  const res = await redeem(app, fresh);
  expect(res.status).toBe(200);
  expect((await res.json()).role).toBe(roleBefore);
  expect(doc.level).toBe("anyone_with_link");
});

test("S-006-shape: the admission cookie lifetime is capped at the link's own expiry when sooner", async () => {
  // The cookie shape carries a bounded absolute expiry capped at the link expiry (GAP-001). Built now
  // so S-006 can lean on it. A link expiring in 1h caps the 24h default.
  const token = mintCapabilityToken();
  const fixedNow = 1_000_000_000_000;
  const linkExpiry = new Date(fixedNow + 60 * 60 * 1000); // +1h
  const res = await redeem(
    appFor(token, { docId: "d", slug: "s", role: "viewer", expiresAt: linkExpiry }, () => fixedNow),
    token,
  );
  const value = (res.headers.get("set-cookie") ?? "").split(";")[0]!.split("=").slice(1).join("=");
  const claims = verifyAdmissionCookie(value, SECRET, fixedNow);
  expect(claims!.exp).toBe(linkExpiry.getTime()); // capped at the link expiry, not now+24h.
});
