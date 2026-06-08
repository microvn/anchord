import { test, expect } from "bun:test";
import { Elysia } from "elysia";
import { apiEnvelope } from "./envelope";
import { requireSession, requireCapability, type SessionResolver } from "./auth-gate";
import type { Role } from "../sharing/roles";

/**
 * S-003: protected routes require a valid better-auth session, and the caller's
 * identity AND role are resolved server-side from that session — never trusted
 * from client input.
 *
 * The gate is exercised in-process via `app.handle(new Request(...))` against a
 * mounted `/api/*` group wrapped with `apiEnvelope` (so the 401/403 we assert is
 * the real envelope onError path, S-001). The better-auth session is INJECTED via
 * a `resolveSession` fake — the live better-auth `auth.api.getSession` resolution
 * over real HTTP/cookie is integration-verified-later ([→E2E]).
 *
 * Each test flips a `handlerRan` sentinel inside the protected handler; for the
 * rejection cases we assert it stays false, proving the gate ran BEFORE the
 * handler (the handler is never reached).
 */

/** A resolver that always yields the given session (or null for "no session"). */
function fixedResolver(session: { userId: string; role?: Role } | null): SessionResolver {
  return async () => session;
}

/**
 * Build an app with one protected route. `resolveSession` is injected; `action`
 * (when set) makes the route require that capability via `requireCapability`.
 * The route records whether its handler body executed via the shared `state`.
 */
function buildApp(opts: {
  resolveSession: SessionResolver;
  action?: Parameters<typeof requireCapability>[1];
  state: { handlerRan: boolean; seenUserId?: string; seenRole?: Role };
}) {
  return new Elysia().group("/api", (api) =>
    apiEnvelope(api)
      .use(requireSession({ resolveSession: opts.resolveSession }))
      .post("/thing", ({ actor }) => {
        if (opts.action) requireCapability(actor, opts.action);
        opts.state.handlerRan = true;
        opts.state.seenUserId = actor.userId;
        opts.state.seenRole = actor.role;
        return { ok: true, userId: actor.userId, role: actor.role };
      }),
  );
}

function call(app: ReturnType<typeof buildApp>, body?: unknown) {
  return app.handle(
    new Request("http://localhost/api/thing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

// ── AS-007: no/invalid session → 401 UNAUTHENTICATED; handler never reached ────
test("AS-007: a protected route with NO session is rejected 401 UNAUTHENTICATED and the handler is never reached", async () => {
  const state = { handlerRan: false };
  const app = buildApp({ resolveSession: fixedResolver(null), state });
  const res = await call(app, {});
  expect(res.status).toBe(401);
  const body = await res.json();
  expect(body.success).toBe(false);
  expect(body.error.code).toBe("UNAUTHENTICATED");
  // The sentinel proves the handler body did not execute.
  expect(state.handlerRan).toBe(false);
});

test("AS-007: a protected route with an INVALID/garbage cookie (resolver yields null) is rejected 401 and the handler is never reached", async () => {
  const state = { handlerRan: false };
  // A garbage cookie resolves to no session — better-auth returns null for it.
  const resolver: SessionResolver = async (headers) => {
    const cookie = headers.get("cookie") ?? "";
    return cookie.includes("valid-session") ? { userId: "u1", role: "commenter" } : null;
  };
  const app = buildApp({ resolveSession: resolver, state });
  const res = await app.handle(
    new Request("http://localhost/api/thing", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "better-auth.session_token=GARBAGE" },
      body: "{}",
    }),
  );
  expect(res.status).toBe(401);
  const body = await res.json();
  expect(body.error.code).toBe("UNAUTHENTICATED");
  expect(state.handlerRan).toBe(false);
});

// ── AS-008: identity+role from session; client-supplied role/identity ignored ──
test("AS-008: identity and role come from the SERVER-resolved session, not from a forged body (commenter resolved despite role:owner/userId in body)", async () => {
  const state: { handlerRan: boolean; seenUserId?: string; seenRole?: Role } = { handlerRan: false };
  const app = buildApp({ resolveSession: fixedResolver({ userId: "real-commenter", role: "commenter" }), state });
  // Body forges an owner role and an attacker userId — both must be ignored.
  const res = await call(app, { role: "owner", userId: "attacker", payload: "x" });
  expect(res.status).toBe(200);
  const body = await res.json();
  // ctx.actor is the resolver's commenter, NOT the body's owner/attacker.
  expect(body.data.role).toBe("commenter");
  expect(body.data.userId).toBe("real-commenter");
  expect(state.seenRole).toBe("commenter");
  expect(state.seenUserId).toBe("real-commenter");
});

test("AS-008: a forged role:owner in the body cannot satisfy an owner-only capability — the resolved commenter is forbidden 403", async () => {
  const state = { handlerRan: false };
  // Resolver says commenter; body forges owner. The owner-only action must use
  // the resolved role (commenter) → FORBIDDEN, despite the forged body.
  const app = buildApp({
    resolveSession: fixedResolver({ userId: "real-commenter", role: "commenter" }),
    action: "manage_sharing",
    state,
  });
  const res = await call(app, { role: "owner", userId: "attacker" });
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.error.code).toBe("FORBIDDEN");
  // The capability check fired before the handler completed its work.
  expect(state.handlerRan).toBe(false);
});

// ── AS-009: authenticated caller lacking capability → 403 FORBIDDEN ────────────
test("AS-009: an authenticated viewer lacking the comment capability is forbidden 403 FORBIDDEN", async () => {
  const state = { handlerRan: false };
  const app = buildApp({
    resolveSession: fixedResolver({ userId: "v1", role: "viewer" }),
    action: "comment",
    state,
  });
  const res = await call(app, {});
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.success).toBe(false);
  expect(body.error.code).toBe("FORBIDDEN");
  expect(state.handlerRan).toBe(false);
});

test("AS-009: an authenticated caller WITH the capability passes the gate and reaches the handler", async () => {
  const state = { handlerRan: false };
  const app = buildApp({
    resolveSession: fixedResolver({ userId: "c1", role: "commenter" }),
    action: "comment",
    state,
  });
  const res = await call(app, {});
  expect(res.status).toBe(200);
  expect(state.handlerRan).toBe(true);
});

// ── C-005: protected route needs a valid session; identity+role server-side ────
test("C-005: the handler is NEVER reached without a valid session (gate runs before the handler)", async () => {
  const state = { handlerRan: false };
  const app = buildApp({ resolveSession: fixedResolver(null), state });
  await call(app, { role: "owner" });
  expect(state.handlerRan).toBe(false);
});

test("C-005: an actor with no role on the session is treated as least-privileged (viewer) for capability checks", async () => {
  const state = { handlerRan: false };
  // A session that carries identity but no explicit role must NOT be able to
  // comment — the gate must not silently grant more than viewer.
  const app = buildApp({
    resolveSession: fixedResolver({ userId: "norole" }),
    action: "comment",
    state,
  });
  const res = await call(app, {});
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.error.code).toBe("FORBIDDEN");
  expect(state.handlerRan).toBe(false);
});

// ── requireCapability unit contract (the helper the routes call) ───────────────
test("AS-009: requireCapability throws ForbiddenError when the actor's role lacks the action", () => {
  expect(() => requireCapability({ userId: "v1", role: "viewer" }, "comment")).toThrow();
});

test("AS-009: requireCapability is a no-op (returns) when the actor's role has the action", () => {
  expect(() => requireCapability({ userId: "o1", role: "owner" }, "manage_sharing")).not.toThrow();
});
