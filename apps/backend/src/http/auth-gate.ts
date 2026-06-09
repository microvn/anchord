import { Elysia } from "elysia";
import { UnauthenticatedError, ForbiddenError, NotFoundError } from "./errors";
import { can, type Role, type Action } from "../sharing/roles";

export type WorkspaceRole = "admin" | "member";

/**
 * S-003: the session auth gate for protected `/api/*` routes.
 *
 * Two guarantees, both keyed on the SERVER, never on client input (C-005):
 *   1. A protected route never runs its handler without a valid better-auth
 *      session — no/expired/invalid session → 401 UNAUTHENTICATED, and the gate
 *      runs in a `resolve` step BEFORE the handler, so the handler is never
 *      reached (AS-007).
 *   2. The caller's identity AND role are resolved from that session and exposed
 *      to the handler as `ctx.actor`. The handler reads identity/role ONLY from
 *      `ctx.actor`; anything the client sends in the body/headers (a forged
 *      `role: "owner"` / `userId`) is NEVER the auth source (AS-008).
 *
 * The session lookup is INJECTED via `resolveSession`, so unit tests drive the
 * gate with a fake and never need a real cookie/DB. The concrete wiring (below)
 * wraps better-auth `auth.api.getSession({ headers })` — that live resolution
 * over real HTTP is integration-verified-later ([→E2E]).
 */

/** The server-resolved caller. Identity + role come from the session, never the client. */
export type Actor = {
  userId: string;
  /**
   * Role resolved from the session. Absent → treated as least-privileged
   * (`viewer`) for capability checks, so a session without an explicit role can
   * never be silently granted more than view access.
   */
  role?: Role;
};

/**
 * Resolve a session from the request headers (cookie). Returns the
 * server-resolved `{ userId, role? }`, or `null` when there is no valid session
 * (no cookie, expired, or garbage). INJECTED so the gate is testable without a
 * real better-auth cookie/DB.
 */
export type SessionResolver = (headers: Headers) => Promise<Actor | null>;

/**
 * The actor's role for capability checks: the session role, or `viewer` when the
 * session carries no role. NEVER derived from client input.
 */
function actorRole(actor: Actor): Role {
  return actor.role ?? "viewer";
}

/**
 * Elysia plugin: gate a protected route group on a valid session.
 *
 * Mounted after `apiEnvelope` so a thrown `UnauthenticatedError` is wrapped by
 * the envelope's onError into the 401 error envelope. The gate is a `resolve`
 * step (runs before the handler): no session → throw `UnauthenticatedError`
 * (→401) and the handler never runs (AS-007/C-005). On success it injects
 * `ctx.actor` — the ONLY auth source the handler may read (AS-008).
 */
export function requireSession(opts: { resolveSession: SessionResolver }) {
  return new Elysia({ name: "auth-gate" }).resolve(
    { as: "scoped" },
    async ({ request }): Promise<{ actor: Actor }> => {
      const session = await opts.resolveSession(request.headers);
      if (!session) {
        // Gate fails BEFORE the handler — handler is never reached.
        throw new UnauthenticatedError();
      }
      return { actor: session };
    },
  );
}

/**
 * Throw `ForbiddenError` (→403) when the actor's server-resolved role lacks the
 * capability for `action`; otherwise return (no-op). Uses `can(role, action)`
 * from sharing/roles with the SERVER role (AS-009). A roleless session is
 * checked as `viewer`, so it can never satisfy more than view.
 */
export function requireCapability(actor: Actor, action: Action): void {
  if (!can(actorRole(actor), action)) {
    throw new ForbiddenError();
  }
}

/**
 * Resolve whether `userId` is an admin of the single workspace — keyed on the SERVER's
 * workspace_members.role read, NEVER a body-supplied role (anti-forgery). Injected so the
 * member-management routes are testable without a DB; prod wires the real Drizzle read.
 */
export type IsWorkspaceAdmin = (userId: string) => Promise<boolean>;

/**
 * workspace-project S-002 (C-002, the admin-gate half): only admins manage
 * settings/members. Throw `ForbiddenError` (→403) when the SESSION actor is not a
 * workspace admin; otherwise return (no-op). The actor's adminness comes from the
 * server-resolved workspace_members.role (via `isWorkspaceAdmin`), so a member sending
 * `{role:"admin"}` in the body is ignored — they are still gated out (AS-004). Gate
 * BEFORE the handler runs so a non-admin's call never reaches member-management logic.
 */
export async function requireWorkspaceAdmin(
  actor: Actor,
  isWorkspaceAdmin: IsWorkspaceAdmin,
): Promise<void> {
  if (!(await isWorkspaceAdmin(actor.userId))) {
    throw new ForbiddenError();
  }
}

/**
 * Resolve the actor's WORKSPACE role for `workspaceId` (workspaces C-002): the role
 * from the SERVER's workspace_members read, or null when the actor is not a member.
 * Injected so the path-scoped gate is testable without a DB.
 */
export type WorkspaceRoleResolver = (
  workspaceId: string,
  userId: string,
) => Promise<WorkspaceRole | null>;

/** What requireWorkspaceMember injects: the resolved workspace scope + the caller's role. */
export type WorkspaceScope = { workspaceId: string; role: WorkspaceRole };

/**
 * workspaces S-006 (C-002/C-005): the path-scoped tenancy gate for every data API under
 * `/api/w/:workspaceId/…`. Runs AFTER requireSession (needs `actor`). Reads `:workspaceId`
 * from the path, confirms the actor holds a workspace_members row there, and injects
 * `ctx.ws = { workspaceId, role }`. A non-member is refused as 404 NOT_FOUND
 * (existence-hiding: indistinguishable from "no such workspace" — AS-008/AS-018). The
 * scope is keyed on the PATH + the SERVER membership read, never a body field.
 */
export function requireWorkspaceMember(opts: { resolveWorkspaceRole: WorkspaceRoleResolver }) {
  return new Elysia({ name: "workspace-gate" }).resolve(
    { as: "scoped" },
    async (ctx): Promise<{ ws: WorkspaceScope }> => {
      const { params } = ctx as { params: Record<string, string | undefined> };
      // `actor` is injected by requireSession (mounted before this gate). It is not in the
      // base Elysia context type here, so read it through the augmented shape.
      const actor = (ctx as unknown as { actor: Actor }).actor;
      const workspaceId = params.workspaceId;
      if (!workspaceId) throw new NotFoundError();
      const role = await opts.resolveWorkspaceRole(workspaceId, actor.userId);
      if (!role) {
        // Existence-hiding: a non-member sees the same 404 as a non-existent workspace.
        throw new NotFoundError();
      }
      return { ws: { workspaceId, role } };
    },
  );
}

/**
 * Concrete `SessionResolver` wrapping better-auth's server-side session getter.
 *
 * `auth.api.getSession({ headers })` resolves the DB-backed session from the
 * request cookie and yields its user; we project that to `{ userId, role? }`.
 * The role mapping (doc-scoped role vs the session user) is resolved by the
 * route's authz, not here — this resolver only proves WHO the caller is.
 *
 * Live behaviour over real HTTP/cookie is integration-verified-later ([→E2E]);
 * the gate logic above is unit-tested with an injected fake.
 */
export function betterAuthSessionResolver(auth: {
  api: { getSession: (args: { headers: Headers }) => Promise<{ user: { id: string } } | null> };
}): SessionResolver {
  return async (headers) => {
    const session = await auth.api.getSession({ headers });
    if (!session?.user) return null;
    return { userId: session.user.id };
  };
}
