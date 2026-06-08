// Workspace membership service (workspace-project S-002).
//
// S-002 is "an admin invites and removes members; members cannot manage membership".
// The ADMIN-GATE (who may call these) lives at the route boundary (requireWorkspaceAdmin
// in src/http/auth-gate.ts) — by the time these functions run, the caller is already a
// confirmed admin. This module owns the membership LOGIC behind an injectable
// WorkspaceMembersRepo (mirrors setup.ts), unit-testable without a DB:
//
//   listMembers   — the member directory (AS-003 "opens the member directory").
//   inviteMember  — AS-003. In single-workspace v0 there is no separate invite table:
//                   EVERYONE who signs up becomes a `member` via the live
//                   onUserCreated hook (auth.ts → addMemberOnSignup). So "invite
//                   dev@acme.com as a member" = record the invite intent (and
//                   optionally enqueue an invite email); the membership row
//                   materializes when that person signs up. Inviting an email that is
//                   already a member is idempotent (already_member, no enqueue).
//   removeMember  — AS-012/C-007. Deletes ONLY the workspace_members row — never the
//                   user, never their docs/projects (the FKs are owner-id SET NULL /
//                   the doc belongs to the workspace, C-007). Guards:
//                     · the target must be a member (else not_member → 404),
//                     · the SOLE admin cannot remove themselves (sole_admin → 409),
//                       so the workspace is never orphaned with zero admins.
//
// The real Drizzle glue (the same reads/deletes over workspace_members) lives in
// repo.ts and is integration-verified in test/integration/members.itest.ts.

import { normalizeEmail } from "../auth/invite";

export type WorkspaceRole = "admin" | "member";

/** A member as the directory lists them. */
export interface MemberRow {
  userId: string;
  role: WorkspaceRole;
  name: string;
  email: string;
}

/** The invite intent enqueued for a not-yet-member email (AS-003). */
export interface EnqueuedWorkspaceInvite {
  workspaceId: string;
  email: string;
  invitedBy: string;
}

/**
 * Persistence port for membership management. The real impl (repo.ts) is thin Drizzle
 * glue over workspace_members + the better-auth user table (for name/email).
 */
export interface WorkspaceMembersRepo {
  /** The member directory for a workspace (AS-003). */
  listMembers(workspaceId: string): Promise<MemberRow[]>;
  /** The user's workspace role, or null when they are not a member. */
  findMemberRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null>;
  /** A member matched by (normalized) email — for invite idempotency. */
  findMemberByEmail(
    workspaceId: string,
    email: string,
  ): Promise<{ userId: string; role: WorkspaceRole } | null>;
  /** How many admins the workspace has — the sole-admin guard reads this. */
  countAdmins(workspaceId: string): Promise<number>;
  /** Delete the membership row; returns whether a row was actually removed. */
  removeMember(workspaceId: string, userId: string): Promise<boolean>;
}

/** Thrown when a membership operation is refused. Each code maps to one HTTP status. */
export class MemberRejected extends Error {
  constructor(
    message: string,
    readonly code: "not_member" | "sole_admin",
  ) {
    super(message);
    this.name = "MemberRejected";
  }
}

export interface MembersDeps {
  repo: WorkspaceMembersRepo;
  /**
   * Records the invite intent (and may send an invite email). Optional: omit to make
   * invite a pure "record idempotency" check (the membership still materializes on
   * signup via the live onUserCreated hook). In prod this reuses the mail queue.
   */
  enqueueInvite?: (msg: EnqueuedWorkspaceInvite) => void;
}

/** AS-003: the member directory. */
export async function listMembers(
  input: { workspaceId: string },
  deps: { repo: WorkspaceMembersRepo },
): Promise<MemberRow[]> {
  return deps.repo.listMembers(input.workspaceId);
}

export type InviteStatus = "invited" | "already_member";

/**
 * AS-003: invite `email` as a member. In single-workspace v0 the membership row is
 * created by the live onUserCreated hook when the invitee signs up (everyone becomes a
 * member); this records the invite intent (and optionally emails it). Inviting an email
 * that is ALREADY a member is idempotent — returns `already_member`, enqueues nothing.
 * The admin-gate (only admins may invite, AS-004) is the route's job, upstream of here.
 */
export async function inviteMember(
  input: { workspaceId: string; email: string; invitedBy: string },
  deps: MembersDeps,
): Promise<{ status: InviteStatus }> {
  const email = normalizeEmail(input.email);
  const existing = await deps.repo.findMemberByEmail(input.workspaceId, email);
  if (existing) {
    return { status: "already_member" };
  }
  deps.enqueueInvite?.({ workspaceId: input.workspaceId, email, invitedBy: input.invitedBy });
  return { status: "invited" };
}

/**
 * AS-012 / C-007: remove a member. Deletes ONLY the workspace_members row — the user,
 * their docs, and their projects are untouched (the doc belongs to the workspace, not
 * the person; owner_id stays but a non-member owner can no longer act, and the admin
 * overrides — see the sharing admin-override). Guards:
 *   - the target must be a member (else not_member → 404),
 *   - the SOLE admin cannot remove themselves (sole_admin → 409) so the workspace never
 *     ends up with zero admins. Removing a non-sole admin, or any member, is allowed.
 */
export async function removeMember(
  input: { workspaceId: string; targetUserId: string; actorId: string },
  deps: { repo: WorkspaceMembersRepo },
): Promise<void> {
  const role = await deps.repo.findMemberRole(input.workspaceId, input.targetUserId);
  if (role === null) {
    throw new MemberRejected("user is not a member of this workspace", "not_member");
  }
  // Sole-admin guard: refuse to remove the last admin (only relevant when the target is
  // an admin — removing a member never touches the admin count).
  if (role === "admin") {
    const admins = await deps.repo.countAdmins(input.workspaceId);
    if (admins <= 1) {
      throw new MemberRejected("cannot remove the sole admin of the workspace", "sole_admin");
    }
  }
  await deps.repo.removeMember(input.workspaceId, input.targetUserId);
}
