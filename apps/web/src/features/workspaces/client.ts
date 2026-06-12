import { api } from "@/lib/api";
import type { EdenResult } from "@/lib/api/use-api-query";
import type { Bootstrap, MembersDirectory, WorkspaceRole } from "./types";

// Typed request thunks for the workspaces backend (`/api/me`, `/api/workspaces`,
// `/api/w/:id/members`, `/api/invitations/:id/{accept,reject}`).
//
// WHY a wrapper and not raw `api.api.me.get()` at each call site: the backend composes these
// routes CONDITIONALLY (`if (deps.me) app.use(meRoutes(...))` in apps/backend/src/app.ts), so
// `App = typeof app` cannot statically widen to include them — the exported treaty type only
// exposes `/health`. `App` is still the REAL type (never `any`); it just doesn't surface the
// conditional routes through chaining. We therefore reach them through the same runtime treaty
// client (it resolves paths dynamically) and annotate the return ourselves. This is the ONE
// place that cast lives; every screen imports these typed thunks. Component tests MOCK this
// module, so the cast is never exercised under test.
//
// Eden runtime path convention: static segments are property access, a `:param` segment is a
// function call carrying that param, and the verb (get/post/patch/delete) is the leaf call.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const treaty = api as any;

// Read thunks are typed to their POST-peel payload (useApiQuery's peelEnvelope strips the envelope),
// so screens get `Bootstrap` / `MembersDirectory` directly. The runtime body is the envelope; the
// annotation is the same benign cast as the treaty wrapper above.

/** GET /api/me — the bootstrap (S-001). */
export function fetchBootstrap(): Promise<EdenResult<Bootstrap>> {
  return treaty.api.me.get() as Promise<EdenResult<Bootstrap>>;
}

/** POST /api/me/active-workspace — persist the active workspace (S-001 switch / C-005). */
export function setActiveWorkspace(workspaceId: string): Promise<EdenResult<unknown>> {
  return treaty.api.me["active-workspace"].post({ workspaceId }) as Promise<EdenResult<unknown>>;
}

/** POST /api/workspaces — create a workspace; creator becomes admin (S-002, AS-004). */
export function createWorkspace(name: string): Promise<EdenResult<unknown>> {
  return treaty.api.workspaces.post({ name }) as Promise<EdenResult<unknown>>;
}

/** PATCH /api/workspaces/:id — rename (admin-only, S-002 AS-005). */
export function renameWorkspace(workspaceId: string, name: string): Promise<EdenResult<unknown>> {
  return treaty.api.workspaces({ id: workspaceId }).patch({ name }) as Promise<EdenResult<unknown>>;
}

/** GET /api/w/:workspaceId/members — member directory + pending invites (S-003, AS-007). */
export function fetchMembers(workspaceId: string): Promise<EdenResult<MembersDirectory>> {
  return treaty.api.w({ workspaceId }).members.get() as Promise<EdenResult<MembersDirectory>>;
}

/** POST /api/workspaces/:id/invitations — invite by email (S-003, AS-008). */
export function inviteMember(
  workspaceId: string,
  email: string,
  role: WorkspaceRole,
): Promise<EdenResult<unknown>> {
  return treaty.api.workspaces({ id: workspaceId }).invitations.post({ email, role }) as Promise<
    EdenResult<unknown>
  >;
}

/** DELETE /api/w/:workspaceId/members/:userId — remove a member (S-003, AS-009). */
export function removeMember(workspaceId: string, userId: string): Promise<EdenResult<unknown>> {
  return treaty.api.w({ workspaceId }).members({ userId }).delete() as Promise<EdenResult<unknown>>;
}

/** PATCH /api/w/:workspaceId/members/:userId — change a member's role (S-003, AS-010). */
export function changeMemberRole(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<EdenResult<unknown>> {
  return treaty.api.w({ workspaceId }).members({ userId }).patch({ role }) as Promise<
    EdenResult<unknown>
  >;
}

/** POST /api/invitations/:id/accept — accept an invite (S-004, AS-013). */
export function acceptInvitation(invitationId: string, token: string): Promise<EdenResult<unknown>> {
  return treaty.api.invitations({ id: invitationId }).accept.post({ token }) as Promise<
    EdenResult<unknown>
  >;
}

/** POST /api/invitations/:id/reject — reject an invite (S-004, AS-014). */
export function rejectInvitation(invitationId: string, token: string): Promise<EdenResult<unknown>> {
  return treaty.api.invitations({ id: invitationId }).reject.post({ token }) as Promise<
    EdenResult<unknown>
  >;
}

// Re-exported payload types so screens import them from one place alongside the thunks.
export type { Bootstrap, MembersDirectory };
