// Multi-workspace tenancy service (workspaces S-001..S-005).
//
// This REPLACES the single-workspace bootstrap (setup.ts): there is no longer ONE
// instance workspace. Every account auto-creates its OWN workspace named "default"
// (creator = admin) + a default project on sign-up; it never joins an existing
// workspace (S-001 / C-001). Users create more workspaces (S-002), see + switch
// among the ones they belong to (S-003), invite by email + accept/reject (S-004),
// and admins remove/change-role with a ≥1-admin invariant (S-005).
//
// All logic lives here behind an injectable TenancyRepo (mirrors the project/share
// fake-repo pattern), unit-testable without a DB. The Drizzle glue is in
// tenancy-repo.ts and is integration-verified against real Postgres.
//
// WORKSPACE ROLE is `admin | member` (the creator is admin). "owner" is NEVER a
// workspace role — it is reserved for the per-doc role in sharing-permissions.

import { generateSlug } from "../publish/slug";
import { normalizeEmail } from "../auth/invite";
import { ensureDefaultProject, type ProjectRepo } from "./projects";

export type WorkspaceRole = "admin" | "member";
export type InvitationStatus = "pending" | "accepted" | "rejected" | "revoked";

/** A workspace as the bootstrap/switcher lists it (S-003, AS-006). */
export interface WorkspaceListItem {
  id: string;
  /** The stored name (always "default" for an auto-created one; user-chosen otherwise). */
  name: string;
  slug: string;
  /** The caller's role in THIS workspace. */
  role: WorkspaceRole;
  /** The creating admin's display name — so two "default"s disambiguate (GAP-002/AS-006). */
  adminName: string | null;
}

/** A pending/active member as the members surface lists it (S-005, AS-021). */
export interface MemberDirectoryRow {
  userId: string;
  email: string;
  name: string;
  role: WorkspaceRole;
}

/** A pending invitation as the members surface lists it (S-005, AS-021). */
export interface InvitationRow {
  id: string;
  email: string;
  role: WorkspaceRole;
  status: InvitationStatus;
}

/** Thrown when a tenancy operation is refused. `code` maps to an HTTP status. */
export class TenancyRejected extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_name"
      | "not_found"
      | "forbidden"
      | "not_member"
      | "sole_admin"
      | "email_mismatch"
      | "not_pending",
  ) {
    super(message);
    this.name = "TenancyRejected";
  }
}

/**
 * Persistence port for tenancy. The real impl (tenancy-repo.ts) is thin Drizzle glue
 * over workspaces / workspace_members / workspace_invitations + the better-auth user.
 */
export interface TenancyRepo {
  /** Insert a workspaces row; return its id/slug/name. */
  createWorkspace(input: { name: string; slug: string }): Promise<{ id: string; slug: string; name: string }>;
  /** Insert a workspace_members row (idempotent on (workspace,user)). */
  addMember(workspaceId: string, userId: string, role: WorkspaceRole): Promise<void>;
  /** Rename a workspace. */
  setWorkspaceName(workspaceId: string, name: string): Promise<void>;
  /** A single workspace's name/slug, or null. */
  findWorkspace(workspaceId: string): Promise<{ id: string; name: string; slug: string } | null>;
  /** Every workspace the user belongs to, with the caller's role + the creating admin's name. */
  listMyWorkspaces(userId: string): Promise<WorkspaceListItem[]>;
  /** The user's role in a workspace, or null when not a member. */
  findMemberRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null>;
  /** Set an existing member's role. */
  setMemberRole(workspaceId: string, userId: string, role: WorkspaceRole): Promise<void>;
  /** Delete a membership row; returns whether one was removed. */
  removeMember(workspaceId: string, userId: string): Promise<boolean>;
  /** How many admins the workspace has (the ≥1-admin invariant reads this). */
  countAdmins(workspaceId: string): Promise<number>;
  /** The member directory (joined to user for name/email). */
  listMembers(workspaceId: string): Promise<MemberDirectoryRow[]>;
  /** Pending invitations for a workspace. */
  listInvitations(workspaceId: string): Promise<InvitationRow[]>;
  /** Create a pending invitation; return its id + token. */
  createInvitation(input: {
    workspaceId: string;
    email: string;
    role: WorkspaceRole;
    token: string;
    invitedBy: string;
    expiresAt: Date;
  }): Promise<{ id: string; token: string }>;
  /** Load an invitation by id, or null. */
  findInvitation(id: string): Promise<{
    id: string;
    workspaceId: string;
    email: string;
    role: WorkspaceRole;
    token: string;
    status: InvitationStatus;
    expiresAt: Date;
  } | null>;
  /** Set an invitation's status. */
  setInvitationStatus(id: string, status: InvitationStatus): Promise<void>;
  /** A user's display name, for the default-project name + admin-qualified label. */
  userName(userId: string): Promise<string | null>;
}

export interface TenancyDeps {
  repo: TenancyRepo;
  /** Default project persistence — supplied so signup/create get a default project. */
  projectRepo?: ProjectRepo;
  slugGen?: (name: string) => string;
  /** Random token generator (injectable for deterministic tests). */
  tokenGen?: () => string;
  now?: () => Date;
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new TenancyRejected("workspace name is required", "invalid_name");
  }
  return trimmed;
}

/** Ensure the user has a default project in the workspace (idempotent). No-op without projectRepo. */
async function ensureDefaultProjectFor(
  workspaceId: string,
  userId: string,
  deps: TenancyDeps,
): Promise<void> {
  if (!deps.projectRepo) return;
  const name = (await deps.repo.userName(userId)) ?? "My";
  await ensureDefaultProject({ workspaceId, ownerId: userId, userName: name }, { repo: deps.projectRepo });
}

/**
 * S-001 (AS-001/AS-002 / C-001): create the user's OWN workspace named "default" with
 * them as admin + a default project. Called from the better-auth onUserCreated hook for
 * EVERY signup. It NEVER joins an existing workspace — each account is isolated and
 * reaches others only by invite. Idempotent on (workspace, user) at the membership layer.
 */
export async function createOwnWorkspaceOnSignup(
  userId: string,
  deps: TenancyDeps,
): Promise<{ workspaceId: string; role: WorkspaceRole }> {
  const slugGen = deps.slugGen ?? generateSlug;
  const ws = await deps.repo.createWorkspace({ name: "default", slug: slugGen(`default-${userId}`) });
  await deps.repo.addMember(ws.id, userId, "admin");
  await ensureDefaultProjectFor(ws.id, userId, deps);
  return { workspaceId: ws.id, role: "admin" };
}

/**
 * S-002 (AS-003): create an additional workspace; the creator becomes its admin and a
 * default project is created. The name is the user's choice (validated non-empty).
 */
export async function createWorkspace(
  input: { name: string; actorId: string },
  deps: TenancyDeps,
): Promise<{ id: string; name: string; slug: string; role: WorkspaceRole }> {
  const name = cleanName(input.name);
  const slugGen = deps.slugGen ?? generateSlug;
  const ws = await deps.repo.createWorkspace({ name, slug: slugGen(name) });
  await deps.repo.addMember(ws.id, input.actorId, "admin");
  await ensureDefaultProjectFor(ws.id, input.actorId, deps);
  return { id: ws.id, name: ws.name, slug: ws.slug, role: "admin" };
}

/** Gate: throw forbidden unless the actor is an admin of the workspace; return the role. */
async function requireAdmin(
  workspaceId: string,
  actorId: string,
  deps: TenancyDeps,
): Promise<void> {
  const role = await deps.repo.findMemberRole(workspaceId, actorId);
  if (role !== "admin") {
    throw new TenancyRejected("admin only", "forbidden");
  }
}

/**
 * S-002 (AS-004/AS-005 / C-003): rename a workspace. Admin-only — a non-admin (member or
 * non-member) is refused. The actor's adminness is the SERVER read, never a body field.
 */
export async function renameWorkspace(
  input: { workspaceId: string; actorId: string; name: string },
  deps: TenancyDeps,
): Promise<{ id: string; name: string }> {
  const name = cleanName(input.name);
  await requireAdmin(input.workspaceId, input.actorId, deps);
  await deps.repo.setWorkspaceName(input.workspaceId, name);
  return { id: input.workspaceId, name };
}

/** S-003 (AS-006): every workspace the user belongs to, with role + admin-qualified name. */
export async function listMyWorkspaces(
  userId: string,
  deps: TenancyDeps,
): Promise<WorkspaceListItem[]> {
  return deps.repo.listMyWorkspaces(userId);
}

/** S-005 (AS-021): the workspace's member directory + pending invitations (admin-only). */
export async function listWorkspaceMembers(
  input: { workspaceId: string; actorId: string },
  deps: TenancyDeps,
): Promise<{ members: MemberDirectoryRow[]; invitations: InvitationRow[] }> {
  await requireAdmin(input.workspaceId, input.actorId, deps);
  const members = await deps.repo.listMembers(input.workspaceId);
  const invitations = await deps.repo.listInvitations(input.workspaceId);
  return { members, invitations };
}

/**
 * S-004 (AS-009/AS-013 / C-004): invite an email as a member (admin-only). Records a
 * PENDING invitation with a random accept token + expiry. The mail send is the route's
 * concern (enqueue) — this returns the invitation so the route can build the link.
 */
export async function inviteToWorkspace(
  input: { workspaceId: string; actorId: string; email: string; role?: WorkspaceRole },
  deps: TenancyDeps,
): Promise<{ id: string; token: string; status: "pending" }> {
  await requireAdmin(input.workspaceId, input.actorId, deps);
  const email = normalizeEmail(input.email);
  const token = (deps.tokenGen ?? defaultToken)();
  const now = (deps.now ?? (() => new Date()))();
  const created = await deps.repo.createInvitation({
    workspaceId: input.workspaceId,
    email,
    role: input.role ?? "member",
    token,
    invitedBy: input.actorId,
    expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
  });
  return { id: created.id, token: created.token, status: "pending" };
}

function defaultToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * S-004 (AS-010/AS-012 / C-004): accept a pending invitation. The accepting email +
 * id come from the SERVER session, never the body. Guards:
 *   - the invitation must exist + be pending + unexpired (else not_pending),
 *   - the presented token must match (else not_found — no enumeration oracle),
 *   - the accepting email MUST equal the invited email (else email_mismatch, AS-012).
 * On success: a workspace_members row + the invitation marked accepted.
 */
export async function acceptInvitation(
  input: { invitationId: string; token: string; actorId: string; actorEmail: string },
  deps: TenancyDeps,
): Promise<{ workspaceId: string; role: WorkspaceRole }> {
  const inv = await deps.repo.findInvitation(input.invitationId);
  const now = (deps.now ?? (() => new Date()))();
  if (!inv || inv.token !== input.token) {
    throw new TenancyRejected("invitation not found", "not_found");
  }
  if (inv.status !== "pending" || inv.expiresAt.getTime() < now.getTime()) {
    throw new TenancyRejected("invitation is not pending", "not_pending");
  }
  if (normalizeEmail(inv.email) !== normalizeEmail(input.actorEmail)) {
    throw new TenancyRejected("the accepting email must match the invited email", "email_mismatch");
  }
  await deps.repo.addMember(inv.workspaceId, input.actorId, inv.role);
  await deps.repo.setInvitationStatus(inv.id, "accepted");
  await ensureDefaultProjectFor(inv.workspaceId, input.actorId, deps);
  return { workspaceId: inv.workspaceId, role: inv.role };
}

/**
 * S-004 (AS-011 / C-004): reject a pending invitation. The session email must match the
 * invited email (same anti-forgery as accept). Leaves NO membership; marks the
 * invitation rejected.
 */
export async function rejectInvitation(
  input: { invitationId: string; token: string; actorEmail: string },
  deps: TenancyDeps,
): Promise<void> {
  const inv = await deps.repo.findInvitation(input.invitationId);
  if (!inv || inv.token !== input.token) {
    throw new TenancyRejected("invitation not found", "not_found");
  }
  if (inv.status !== "pending") {
    throw new TenancyRejected("invitation is not pending", "not_pending");
  }
  if (normalizeEmail(inv.email) !== normalizeEmail(input.actorEmail)) {
    throw new TenancyRejected("the accepting email must match the invited email", "email_mismatch");
  }
  await deps.repo.setInvitationStatus(inv.id, "rejected");
}

/**
 * S-005 (AS-017 / C-002): revoke a PENDING invite (admin-only). Unlike reject (the invitee's
 * own action, token-gated), revoke is the admin withdrawing an invite they sent — so it is
 * authorized by workspace-admin, not the invite token. Marks the invitation `revoked` so it
 * drops from the pending list (listInvitations is pending-only) and its link no longer accepts
 * (acceptInvitation guards `status === pending`). Mirrors reject/accept (status transition, no
 * row delete) and uses the pre-existing `revoked` enum value. Scoped to the workspace: an
 * invitation belonging to another workspace is not_found (no cross-workspace revoke).
 */
export async function revokeWorkspaceInvitation(
  input: { workspaceId: string; actorId: string; invitationId: string },
  deps: TenancyDeps,
): Promise<void> {
  await requireAdmin(input.workspaceId, input.actorId, deps);
  const inv = await deps.repo.findInvitation(input.invitationId);
  if (!inv || inv.workspaceId !== input.workspaceId) {
    throw new TenancyRejected("invitation not found", "not_found");
  }
  if (inv.status !== "pending") {
    throw new TenancyRejected("invitation is not pending", "not_pending");
  }
  await deps.repo.setInvitationStatus(inv.id, "revoked");
}

/**
 * S-005 (AS-014/AS-017 / C-003): remove a member (admin-only). Deletes ONLY the
 * workspace_members row. Guards: the target must be a member (not_member); the SOLE
 * admin cannot be removed (sole_admin — the workspace must keep ≥1 admin, AS-016).
 */
export async function removeWorkspaceMember(
  input: { workspaceId: string; actorId: string; targetUserId: string },
  deps: TenancyDeps,
): Promise<void> {
  await requireAdmin(input.workspaceId, input.actorId, deps);
  const role = await deps.repo.findMemberRole(input.workspaceId, input.targetUserId);
  if (role === null) {
    throw new TenancyRejected("user is not a member of this workspace", "not_member");
  }
  if (role === "admin" && (await deps.repo.countAdmins(input.workspaceId)) <= 1) {
    throw new TenancyRejected("cannot remove the last admin", "sole_admin");
  }
  await deps.repo.removeMember(input.workspaceId, input.targetUserId);
}

/**
 * S-005 (AS-015/AS-016/AS-017 / C-003): change a member's role (admin-only). Promoting a
 * member to admin transfers/shares admin (AS-015, more than one admin allowed).
 * Demoting the SOLE admin is refused (sole_admin, AS-016). Target must be a member.
 */
export async function changeMemberRole(
  input: { workspaceId: string; actorId: string; targetUserId: string; role: WorkspaceRole },
  deps: TenancyDeps,
): Promise<{ userId: string; role: WorkspaceRole }> {
  await requireAdmin(input.workspaceId, input.actorId, deps);
  const current = await deps.repo.findMemberRole(input.workspaceId, input.targetUserId);
  if (current === null) {
    throw new TenancyRejected("user is not a member of this workspace", "not_member");
  }
  if (current === "admin" && input.role === "member" && (await deps.repo.countAdmins(input.workspaceId)) <= 1) {
    throw new TenancyRejected("cannot demote the last admin", "sole_admin");
  }
  await deps.repo.setMemberRole(input.workspaceId, input.targetUserId, input.role);
  return { userId: input.targetUserId, role: input.role };
}
