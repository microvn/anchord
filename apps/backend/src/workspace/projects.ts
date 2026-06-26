// Project service (workspace-project S-003). Pure logic behind an injectable
// ProjectRepo (mirrors setup.ts's WorkspaceRepo / publish's DocRepo), so create /
// list / archive / unarchive / rename / delete + ensureDefaultProject + the
// browse access-filter are unit-testable without a DB.
//
// Decisions locked here (documented + tested):
//  - PROJECT DELETE: blocked when the project still has docs (do NOT silently
//    orphan). Empty, non-default project → deletable by its owner or a workspace
//    admin. The default project is NEVER deletable (it is the MCP fallback, C-009).
//  - ARCHIVE/UNARCHIVE: any member who is the project owner (or a workspace admin)
//    may archive/unarchive; a non-owner member cannot touch someone else's project.
//    The default project is NEVER archivable (C-009 — it must stay a valid fallback).
//  - MANAGE PERMISSION: project create is open to any member (C-002); rename /
//    archive / delete require owner-or-admin.
//
// The real Drizzle glue lives in repo.ts (createProjectRepo) and is
// integration-verified against real Postgres; this file is the logic the unit
// suite drives with a fake repo.

/** project-visibility S-001 / C-001: a project's visibility ∈ private | public. */
export type ProjectVisibility = "private" | "public";

/** A project row as the service sees it. */
export interface ProjectRow {
  id: string;
  workspaceId: string;
  name: string;
  ownerId: string | null;
  isDefault: boolean;
  /** project-visibility S-001 / C-001: private | public (NOT NULL). */
  visibility: ProjectVisibility;
  archivedAt: Date | null;
}

/** Thrown when a project operation is refused. The route maps `code` → HTTP status. */
export class ProjectRejected extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_name"
      | "not_found"
      | "forbidden"
      | "not_empty"
      | "default_protected",
  ) {
    super(message);
    this.name = "ProjectRejected";
  }
}

/** Max project-name length (Zod also enforces this at the route boundary). */
export const MAX_PROJECT_NAME_LENGTH = 120;

/**
 * Persistence port for projects. The real impl (repo.ts) is thin Drizzle glue.
 * `ensureDefaultProject` is the one method with a built-in idempotency contract:
 * it MUST be a no-op when a default project already exists for (workspace, owner).
 */
export interface ProjectRepo {
  insert(input: {
    workspaceId: string;
    name: string;
    ownerId: string | null;
    isDefault: boolean;
    /** project-visibility S-001: the caller (createProject / ensureDefaultProject) decides. */
    visibility: ProjectVisibility;
  }): Promise<ProjectRow>;
  /** A project by id within the workspace, or null. */
  findById(workspaceId: string, projectId: string): Promise<ProjectRow | null>;
  /** The user's default project in this workspace, or null. */
  findDefaultFor(workspaceId: string, ownerId: string): Promise<ProjectRow | null>;
  /** Non-archived projects in the workspace (browse list excludes archived). */
  listActive(workspaceId: string): Promise<ProjectRow[]>;
  /** All projects (incl. archived) — for an explicit includeArchived browse. */
  listAll(workspaceId: string): Promise<ProjectRow[]>;
  setName(projectId: string, name: string): Promise<void>;
  setArchivedAt(projectId: string, archivedAt: Date | null): Promise<void>;
  /** project-visibility S-003 / C-008: flip a project's visibility. Touches NOTHING else
   *  (no share_links) — the toggle affects only the default of docs created AFTERWARD. */
  setVisibility(projectId: string, visibility: ProjectVisibility): Promise<void>;
  /** How many docs reference this project (for the block-delete-when-non-empty rule). */
  countDocs(projectId: string): Promise<number>;
  delete(projectId: string): Promise<void>;
}

export interface ProjectDeps {
  repo: ProjectRepo;
  now?: () => Date;
}

/** Trim + length-validate a project name. Throws ProjectRejected("invalid_name"). */
function cleanName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new ProjectRejected("project name is required", "invalid_name");
  }
  if (trimmed.length > MAX_PROJECT_NAME_LENGTH) {
    throw new ProjectRejected("project name is too long", "invalid_name");
  }
  return trimmed;
}

/**
 * Create a project (C-002 — any member). `ownerId` is the SERVER session actor,
 * never a body field. The project is non-default (default projects are created
 * only by ensureDefaultProject).
 */
export async function createProject(
  input: { workspaceId: string; name: string; ownerId: string; visibility?: ProjectVisibility },
  deps: ProjectDeps,
): Promise<ProjectRow> {
  const name = cleanName(input.name);
  return deps.repo.insert({
    workspaceId: input.workspaceId,
    name,
    ownerId: input.ownerId,
    isDefault: false,
    // project-visibility S-001 / C-001 / AS-001: a deliberately-created project is PUBLIC by
    // default. MCP create_project may override (AS-003/AS-004) by passing `visibility`.
    visibility: input.visibility ?? "public",
  });
}

/**
 * C-009 / AS-014: ensure the user has exactly one default project ("<name>'s docs")
 * in the workspace. Idempotent — if one already exists it is returned unchanged, so
 * a re-fired signup hook / a second join never creates a second default project.
 */
export async function ensureDefaultProject(
  input: { workspaceId: string; ownerId: string; userName: string },
  deps: ProjectDeps,
): Promise<ProjectRow> {
  const existing = await deps.repo.findDefaultFor(input.workspaceId, input.ownerId);
  if (existing) return existing;
  const display = input.userName.trim() || "My";
  return deps.repo.insert({
    workspaceId: input.workspaceId,
    name: `${display}'s docs`,
    ownerId: input.ownerId,
    isDefault: true,
    // project-visibility S-001 / C-001 / AS-002: the auto per-member default project is PRIVATE
    // (its shell is owner-only). Its NEW docs still default workspace-shared — that decouple
    // carve-out lives in the publish derivation (S-004), not here.
    visibility: "private",
  });
}

// ── project-visibility S-002 — the ONE shared project-visibility predicate (C-002) ──────
// project-visibility S-002 / C-002: a PROJECT is visible to user U IFF
//   - U is its OWNER (project.ownerId === U), OR
//   - the project is PUBLIC (visibility === "public").
// There is NO admin exception (C-003) — an admin runs the exact same predicate (own + public
// only), so a workspace admin never sees another member's private project. This is the SINGLE
// predicate every project-FETCH + name + write-target surface must apply identically: the
// projects list, the new-doc picker, the move/copy target picker, MCP list_projects /
// read_project, and the move-target authorization. A project the user can't view is ABSENT
// from a list and indistinguishable from not-found on a by-id fetch (existence-hiding).

/** Whether `userId` may SEE `project` (the ONE shared C-002 / C-003 rule above). */
export function canViewProject(
  userId: string,
  project: Pick<ProjectRow, "ownerId" | "visibility">,
): boolean {
  return project.ownerId === userId || project.visibility === "public";
}

/**
 * project-visibility S-006 / C-004 / AS-026 — gate a project's NAME wherever it could surface beside
 * a doc the viewer can otherwise see (the doc-list card, the viewer breadcrumb). A PRIVATE project's
 * name is suppressed (→ null) for a NON-owner; the owner (and anyone on a public project) keeps the
 * real name. This reuses the SAME `canViewProject` predicate as the project LIST/shell, so the name
 * gate can never drift from the shell gate. The doc itself stays fully accessible (per-doc access,
 * C-005) — only the private project's NAME is hidden.
 */
export function projectNameForViewer(
  userId: string,
  project: { name: string; ownerId: string | null; visibility: ProjectVisibility },
): string | null {
  return canViewProject(userId, project) ? project.name : null;
}

// ── project-visibility S-004 — the ONE new-doc access derivation (C-007) ───────────────
/** A doc's two-axis access config (doc-access-two-axis): the workspace + link roles. */
export interface NewDocAccess {
  workspaceRole: "viewer" | "commenter" | "editor" | null;
  linkRole: "viewer" | "commenter" | "editor" | null;
}

/**
 * project-visibility S-004 / C-007 — derive a NEW doc's initial share_links axes from its
 * TARGET project. This is the keystone that replaces the doc-access-two-axis FIXED default
 * (`{commenter, null}`) with a project-derived one, applied identically at EVERY doc-creation
 * surface (web publish, MCP create_document, copy):
 *
 *   - default project (`isDefault === true`)  → `{ commenter, null }` ALWAYS, regardless of its
 *     (private) visibility — THE CARVE-OUT. The per-member default project's shell is private
 *     but its new docs stay workspace-shared, so the quick-publish / MCP-no-projectId agent
 *     round-trip is never reviewer-invisible (AS-018/AS-019). This preserves doc-access-two-axis
 *     C-007's shared default for the default project (NOT reversed).
 *   - non-default PUBLIC project                → `{ commenter, null }` (the shared default — AS-016).
 *   - non-default PRIVATE project               → `{ null, null }` (derived restricted — AS-017/AS-020):
 *     the doc is private, only the owner + individually-invited reach it.
 *
 * PURE — no DB. The caller reads `{ isDefault, visibility }` from the target project (in the same
 * transaction as the doc/version/share_links insert) and feeds it here.
 */
export function deriveNewDocAccess(project: {
  isDefault: boolean;
  visibility: ProjectVisibility;
}): NewDocAccess {
  // Carve-out: the default project always shares its new docs (agent-loop-safe), even though
  // its shell is private. A non-default project follows its visibility.
  if (project.isDefault || project.visibility === "public") {
    return { workspaceRole: "commenter", linkRole: null };
  }
  return { workspaceRole: null, linkRole: null };
}

/**
 * Browse list (C-005 doc-list boundary preserved): non-archived projects by default; all when
 * includeArchived. project-visibility S-002 / C-002: the list is then filtered to the projects
 * `userId` may VIEW (own + public) — a private project of another member is ABSENT (no admin
 * exception, C-003). One predicate (canViewProject), applied here so EVERY consumer of
 * listProjects (the projects-list route AND the move/copy target picker payload) inherits it.
 */
export async function listProjects(
  input: { workspaceId: string; userId: string; includeArchived?: boolean },
  deps: ProjectDeps,
): Promise<ProjectRow[]> {
  const all = input.includeArchived
    ? await deps.repo.listAll(input.workspaceId)
    : await deps.repo.listActive(input.workspaceId);
  return all.filter((p) => canViewProject(input.userId, p));
}

/**
 * Load a project the actor may MANAGE (rename/archive/delete): it must exist in the
 * workspace AND the actor must be its owner OR a workspace admin. A missing project
 * and an unauthorized actor BOTH surface as the same outcome would at the route
 * (not_found vs forbidden) — here we distinguish so the route can map, but existence
 * is not leaked to a non-member by the browse path (that is the access filter's job).
 */
async function loadManageable(
  input: { workspaceId: string; projectId: string; actorId: string; isAdmin: boolean },
  deps: ProjectDeps,
): Promise<ProjectRow> {
  const project = await deps.repo.findById(input.workspaceId, input.projectId);
  if (!project) throw new ProjectRejected("project not found", "not_found");
  if (!input.isAdmin && project.ownerId !== input.actorId) {
    throw new ProjectRejected("not allowed to manage this project", "forbidden");
  }
  return project;
}

/** Rename a project (owner-or-admin). */
export async function renameProject(
  input: {
    workspaceId: string;
    projectId: string;
    actorId: string;
    isAdmin: boolean;
    name: string;
  },
  deps: ProjectDeps,
): Promise<ProjectRow> {
  const project = await loadManageable(input, deps);
  const name = cleanName(input.name);
  await deps.repo.setName(project.id, name);
  return { ...project, name };
}

/**
 * Archive a project (owner-or-admin) — sets archived_at so it drops out of the
 * default browse list (C-005). The default project is NEVER archivable (C-009).
 */
export async function archiveProject(
  input: { workspaceId: string; projectId: string; actorId: string; isAdmin: boolean },
  deps: ProjectDeps,
): Promise<ProjectRow> {
  const project = await loadManageable(input, deps);
  if (project.isDefault) {
    throw new ProjectRejected("the default project cannot be archived", "default_protected");
  }
  const at = (deps.now ?? (() => new Date()))();
  await deps.repo.setArchivedAt(project.id, at);
  return { ...project, archivedAt: at };
}

/** Unarchive a project (owner-or-admin) — clears archived_at so it reappears. */
export async function unarchiveProject(
  input: { workspaceId: string; projectId: string; actorId: string; isAdmin: boolean },
  deps: ProjectDeps,
): Promise<ProjectRow> {
  const project = await loadManageable(input, deps);
  await deps.repo.setArchivedAt(project.id, null);
  return { ...project, archivedAt: null };
}

/**
 * project-visibility S-003 / C-008: change a project's visibility (private ↔ public).
 *
 * Authorization is NOT the plain owner-or-admin manage gate — it is the C-008 rule:
 *   - the OWNER may always toggle (including their own private project), AND
 *   - a workspace ADMIN may toggle ONLY a project they can SEE (canViewProject) — and since an
 *     admin cannot see another member's PRIVATE project (C-003, no admin exception), an admin
 *     effectively toggles only PUBLIC projects (or their own).
 *   - anyone else (a non-owner non-admin) is refused.
 * We reuse `canViewProject` for the admin arm rather than inventing a new admin exception. A
 * missing project surfaces as not_found (the route maps it; existence-hiding is the browse
 * filter's job, but a by-id toggle on a project an admin can't see is refused as forbidden —
 * indistinguishable in effect from "you can't touch it").
 *
 * This path touches ONLY `projects.visibility` — it NEVER reads or writes `share_links`, so an
 * existing doc's access (workspace_role + link_role) is unchanged; the new visibility only feeds
 * the default of docs created AFTERWARD (the derivation lives in S-004).
 */
export async function setProjectVisibility(
  input: {
    workspaceId: string;
    projectId: string;
    actorId: string;
    isAdmin: boolean;
    visibility: ProjectVisibility;
  },
  deps: ProjectDeps,
): Promise<ProjectRow> {
  const project = await deps.repo.findById(input.workspaceId, input.projectId);
  if (!project) throw new ProjectRejected("project not found", "not_found");
  const isOwner = project.ownerId === input.actorId;
  // Owner always; admin only on a project they can SEE (own + public — canViewProject); else no.
  const allowed = isOwner || (input.isAdmin && canViewProject(input.actorId, project));
  if (!allowed) {
    throw new ProjectRejected("not allowed to change this project's visibility", "forbidden");
  }
  await deps.repo.setVisibility(project.id, input.visibility);
  return { ...project, visibility: input.visibility };
}

/**
 * Delete a project (owner-or-admin). Blocked when:
 *  - it is the default project (C-009 — the MCP fallback must always exist), or
 *  - it still has docs (do NOT silently orphan; the safe v0 choice is block).
 */
export async function deleteProject(
  input: { workspaceId: string; projectId: string; actorId: string; isAdmin: boolean },
  deps: ProjectDeps,
): Promise<void> {
  const project = await loadManageable(input, deps);
  if (project.isDefault) {
    throw new ProjectRejected("the default project cannot be deleted", "default_protected");
  }
  const docCount = await deps.repo.countDocs(project.id);
  if (docCount > 0) {
    throw new ProjectRejected("project is not empty (move or delete its docs first)", "not_empty");
  }
  await deps.repo.delete(project.id);
}

// ── browse access filter — the ONE shared workspace-visibility predicate (C-006) ─────
// doc-access-two-axis S-004 / C-006: a doc is visible in the workspace to user X iff
//   - X is the doc OWNER, OR
//   - X is individually invited (an ACTIVE doc_members row), OR
//   - the doc's WORKSPACE axis is on (share_links.workspace_role IS NOT NULL) AND X is a
//     workspace member.
// The LINK axis is IRRELEVANT to workspace visibility: turning a doc's public link on (or
// off) never adds it to, nor removes it from, the workspace browse — that independence is
// the bug this redesign fixes (AS-013). Keying on the raw `workspaceShared` axis (not the
// derived `generalAccess` level) is what makes this correct: a doc shared with BOTH the
// workspace AND a link derives to "anyone_with_link" (the lossy legacy level — the link axis
// dominates), which would WRONGLY drop it from the workspace if we keyed on the level. We key
// on the axis instead. A doc the user can't browse is ABSENT — not a 403 row — so "no access"
// is indistinguishable from "does not exist" (existence-hiding; no title/metadata leak).
//
// This is the SINGLE predicate every workspace-listing surface (dashboard list, search,
// project doc counts, MCP browse, list payload) must apply identically — in SQL the same
// rule is inlined as `sl.workspace_role IS NOT NULL` (search-repo, repo stats, MCP wiring).

/** A doc as the browse filter sees it (only what the visibility decision needs). */
export interface BrowseDoc {
  id: string;
  ownerId: string | null;
  /** The WORKSPACE axis: true iff `share_links.workspace_role IS NOT NULL` (C-006). The
   *  doc is shared with its own workspace. The link axis plays NO part in this decision. */
  workspaceShared: boolean;
}

export interface BrowseFilterDeps {
  /** True if the viewer is individually invited to (has an active membership on) the doc. */
  isInvited(docId: string, userId: string): boolean | Promise<boolean>;
  /** True if the viewer is a member of the workspace. */
  isWorkspaceMember(userId: string): boolean | Promise<boolean>;
}

/** Whether `userId` may SEE `doc` in the workspace (the ONE shared C-006 rule above). */
export async function canBrowseDoc(
  userId: string,
  doc: BrowseDoc,
  deps: BrowseFilterDeps,
): Promise<boolean> {
  if (doc.ownerId != null && doc.ownerId === userId) return true;
  // Individually invited → visible regardless of either axis.
  if (await deps.isInvited(doc.id, userId)) return true;
  // Workspace axis on AND the caller is a member → visible. The link axis is ignored here.
  if (doc.workspaceShared) return !!(await deps.isWorkspaceMember(userId));
  return false;
}

/** Filter a doc list down to the ones `userId` may see in browse (existence-hiding). */
export async function filterBrowsableDocs(
  userId: string,
  docs: BrowseDoc[],
  deps: BrowseFilterDeps,
): Promise<BrowseDoc[]> {
  const out: BrowseDoc[] = [];
  for (const doc of docs) {
    if (await canBrowseDoc(userId, doc, deps)) out.push(doc);
  }
  return out;
}
