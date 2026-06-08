// Workspace bootstrap service (workspace-project S-001).
//
// v0 is a SINGLE workspace = the instance. Two responsibilities, both pure logic
// behind an injectable WorkspaceRepo (mirrors publish's DocRepo / sharing's
// ShareRepo) so they are unit-testable without a DB:
//
//   createWorkspaceWithAdmin — the FIRST-RUN claim. Allowed ONLY when zero
//     workspaces exist (C-001 single-workspace guard). Creates the one workspaces
//     row + inserts the running user as `admin`. The admin identity is the SERVER
//     session actor passed in by the route, NEVER the request body (anti-forgery).
//     A second call once a workspace exists → SetupRejected("already_set_up") so
//     the route maps it to 409 (idempotent: no second workspace, no second admin).
//
//   addMemberOnSignup — the LATER-SIGNUP path. When a user is created via
//     better-auth AND a workspace already exists, add them as `member` (C-001:
//     first user = admin, later users = member). No workspace yet → no-op (the
//     installer becomes a member by running setup, not by this hook). Idempotent:
//     a user already a member is left untouched (composite-unique backstop).
//
// The real Drizzle glue (check-count + inserts in one transaction) lives in
// repo.ts and is integration-verified against real Postgres; this file is the
// logic the unit suite drives with a fake repo.

import { generateSlug } from "../publish/slug";

/** Workspace `settings` payload — providers/branding/default-access (validated at the route boundary via Zod). */
export interface WorkspaceSettings {
  providers: { github: boolean; google: boolean };
  defaultAccess?: "restricted" | "anyone_in_workspace" | "anyone_with_link";
  branding?: { logoUrl?: string; primaryColor?: string };
}

export interface CreateWorkspaceInput {
  name: string;
  settings: WorkspaceSettings;
  /**
   * The admin's user id — the SERVER-resolved session actor (a better-auth TEXT
   * id). NEVER read from the request body (anti-forgery): the route threads
   * actor.userId here, so a body trying to set someone else as admin is ignored.
   */
  adminUserId: string;
}

export interface CreatedWorkspace {
  workspaceId: string;
  slug: string;
  name: string;
  adminUserId: string;
}

/** Thrown when first-run is refused (the instance is already set up — C-001). */
export class SetupRejected extends Error {
  constructor(
    message: string,
    readonly code: "already_set_up" | "invalid_name",
  ) {
    super(message);
    this.name = "SetupRejected";
  }
}

/**
 * Persistence port. The real implementation (repo.ts) is thin Drizzle glue that
 * runs the count-check + inserts inside ONE transaction so concurrent setup calls
 * cannot create two workspaces (C-001).
 */
export interface WorkspaceRepo {
  /** How many workspaces exist. v0: 0 (not set up) or 1 (set up). */
  countWorkspaces(): Promise<number>;
  /**
   * Atomically: re-check zero workspaces exist, insert the one workspaces row, and
   * insert `adminUserId` as `admin`. Returns the created workspace. MUST throw
   * SetupRejected("already_set_up") if a workspace already exists when it runs (the
   * in-transaction guard that makes concurrent setup race-safe — the second loser
   * sees a row and refuses).
   */
  createWorkspaceWithAdmin(input: {
    name: string;
    slug: string;
    settings: WorkspaceSettings;
    adminUserId: string;
  }): Promise<CreatedWorkspace>;
  /** The single workspace's id, or null when none exists yet. */
  currentWorkspaceId(): Promise<string | null>;
  /**
   * Add `userId` as `member` of `workspaceId` if not already a member (idempotent:
   * a re-run on an existing membership is a no-op, backed by the composite unique).
   */
  addMember(workspaceId: string, userId: string, role: "member"): Promise<void>;
}

export interface SetupDeps {
  repo: WorkspaceRepo;
  /** Slug generator (defaults to the publish slug helper) — injectable for deterministic tests. */
  slugGen?: (name: string) => string;
}

/**
 * First-run claim: create the single workspace + make the running user its admin.
 * Refuses (SetupRejected "already_set_up") when a workspace already exists — the
 * instance is set up once (C-001). The admin is `input.adminUserId` (the session
 * actor), never anything from the request body.
 */
export async function createWorkspaceWithAdmin(
  input: CreateWorkspaceInput,
  deps: SetupDeps,
): Promise<CreatedWorkspace> {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new SetupRejected("workspace name is required", "invalid_name");
  }
  const slugGen = deps.slugGen ?? generateSlug;

  // Cheap pre-check (fast refusal for the common "already set up" case). The
  // AUTHORITATIVE guard is inside repo.createWorkspaceWithAdmin's transaction
  // (C-001): two concurrent callers can both pass this pre-check, but only one
  // wins the in-tx insert; the loser gets SetupRejected("already_set_up").
  if ((await deps.repo.countWorkspaces()) > 0) {
    throw new SetupRejected("instance already set up", "already_set_up");
  }

  return deps.repo.createWorkspaceWithAdmin({
    name,
    slug: slugGen(name),
    settings: input.settings,
    adminUserId: input.adminUserId,
  });
}

/**
 * Later-signup path: when a user is created and a workspace already exists, add
 * them as `member` (C-001). No workspace yet → no-op (a signed-up-but-no-workspace
 * user is not yet a member; the installer joins by running setup, later users join
 * here). Returns whether a membership was added (for observability/tests).
 */
export async function addMemberOnSignup(
  userId: string,
  deps: SetupDeps,
): Promise<{ added: boolean; role?: "member" }> {
  const workspaceId = await deps.repo.currentWorkspaceId();
  if (!workspaceId) {
    // Pre-setup signup: deterministic no-op (AS-002 only applies once a workspace exists).
    return { added: false };
  }
  await deps.repo.addMember(workspaceId, userId, "member");
  return { added: true, role: "member" };
}
