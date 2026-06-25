// Soft-delete a doc into Trash (doc-delete-trash S-001). Pure logic behind injectable
// ports (mirrors doc-move.ts / projects.ts), so the composed gate, the workspace-id
// capture, the conditional (idempotent) tombstone write, and the emit-on-change decision
// are unit-testable without a DB.
//
// Decisions locked here (documented + tested):
//  - GATE (net-new, NOT "mirror project delete" — S-001 § Gate / C-003): project delete
//    gates on owner-or-admin with no per-doc role concept; doc delete ADDITIONALLY grants
//    the per-doc EDITOR destructive rights. The gate composes two orthogonal resolvers:
//      (resolveAccess(docId, actor).role ∈ {owner, editor}) OR (workspaceRole === "admin").
//    The two are OR'd — either arm alone admits. A workspace admin with NO per-doc grant
//    (resolveAccess → role: null) is STILL admitted via the workspace-admin arm (AS-021); a
//    null per-doc role with a non-admin workspace role is refused (AS-004).
//  - EXISTENCE-HIDING (C-007-adjacent): a source the actor cannot even SEE collapses to
//    NOT_FOUND. A VISIBLE doc whose role/workspace-role is too low → FORBIDDEN
//    ("insufficient permission", AS-004).
//  - SOFT-DELETE (C-001): only `deleted_at` + `deleted_workspace_id` are written. Versions,
//    annotations, comments are NEVER removed — the repo exposes no path to remove them, so
//    restore is lossless. The doc's workspace is CAPTURED AT DELETE TIME (C-005) from the
//    repo's project → workspace resolution, never the caller's path.
//  - IDEMPOTENCY (C-006): the tombstone write is conditional — `UPDATE … WHERE deleted_at
//    IS NULL`. A second delete changes 0 rows (the doc is already tombstoned), so the
//    `doc_deleted` activity is emitted ONLY when the conditional update actually changed a
//    row (AS-022). No double-emit on retry / double-click.

import { can, type Role } from "../sharing/roles";
import { emitActivity, type ActivityEmitDeps } from "../activity/emit";

/** Thrown when a delete is refused. The route maps `code` → HTTP status. */
export class DocDeleteRejected extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "forbidden",
  ) {
    super(message);
    this.name = "DocDeleteRejected";
  }
}

/** The target doc, as the delete logic needs it. `null` when no such slug exists. */
export interface DeletableDoc {
  id: string;
  slug: string;
}

/**
 * A deleted doc, as the RESTORE logic needs it (doc-delete-trash S-003). Resolved by id and
 * ALWAYS scoped to the path workspace via `deleted_workspace_id` (C-007) — a deleted row escapes
 * the normal browse access filter, so this workspace match is the ONLY thing keeping a restore
 * from reaching another workspace's Trash. `projectId`/`ownerId` may be null (the project was
 * deleted / the owner was removed) — that drives the C-004 fallback.
 */
export interface RestorableDoc {
  id: string;
  slug: string;
  projectId: string | null;
  ownerId: string | null;
  deletedWorkspaceId: string;
}

/** One Trash row for the workspace Trash list (doc-delete-trash S-003, AS-013 empty state). */
export interface TrashEntry {
  id: string;
  slug: string;
  title: string;
  deletedAt: Date;
  // doc-delete-trash S-007: the doc's owner (nullable — the owner may have been removed). The
  // Trash UI uses it to decide whether to OFFER "Delete forever" (owner-or-admin only, AS-035);
  // the server gate (permanentlyDeleteDoc) is authoritative regardless.
  ownerId: string | null;
}

/**
 * Persistence port. The real impl (doc-delete-repo.ts) is thin Drizzle glue. Reads:
 *  - findDocBySlug   — resolve the target (active docs only — a doc already in Trash is
 *                      excluded so a stale grid retry collapses to not-found, not a re-delete).
 *  - workspaceOfDoc  — the doc's OWN workspace (project_id → projects.workspace_id), captured
 *                      at delete time (C-005). Null when unresolvable (project-less / vanished).
 * Writes:
 *  - softDelete      — the CONDITIONAL tombstone: set deleted_at + deleted_workspace_id WHERE
 *                      deleted_at IS NULL. Returns the number of rows changed (0 when the doc
 *                      was already tombstoned — the idempotency / emit-on-change signal, C-006).
 *                      Touches ONLY the two tombstone columns; versions/annotations/comments are
 *                      never removed (C-001).
 */
export interface DocDeleteRepo {
  findDocBySlug(slug: string): Promise<DeletableDoc | null>;
  workspaceOfDoc(docId: string): Promise<string | null>;
  softDelete(docId: string, deletedAt: Date, deletedWorkspaceId: string): Promise<number>;

  // ── doc-delete-trash S-003: Trash list + restore ──────────────────────────────────────
  /**
   * The workspace Trash: every deleted doc whose `deleted_workspace_id` = the path workspace
   * (C-007 scoping), most-recent first. Active docs (deleted_at IS NULL) and other workspaces'
   * tombstones are excluded in SQL. Empty list → the AS-013 empty state.
   */
  listTrash(workspaceId: string): Promise<TrashEntry[]>;
  /**
   * Resolve a DELETED doc by id, scoped to the path workspace (`deleted_at IS NOT NULL AND
   * deleted_workspace_id = :workspaceId`). Null when no such tombstone exists in THIS workspace —
   * a doc in another workspace's Trash is unreachable (AS-025), and an active doc is not found here
   * (the idempotent no-op of AS-027 is enforced by the conditional UPDATE in `restore`, not here,
   * so an active doc still resolves for the gate via `findActiveById`). Used for the restore gate.
   */
  findDeletedById(workspaceId: string, docId: string): Promise<RestorableDoc | null>;
  /**
   * The CONDITIONAL un-tombstone (C-006): clear deleted_at + deleted_workspace_id, set project_id
   * to `targetProjectId`, WHERE id = :id AND deleted_at IS NOT NULL. Returns rows changed (0 when
   * the doc was already active — the idempotency / emit-on-change signal for AS-027). Touches only
   * the tombstone columns + project_id; versions/annotations/comments are untouched (C-001).
   */
  restore(docId: string, targetProjectId: string): Promise<number>;
  /**
   * C-008: reset the doc PRIVATE — set BOTH share_links axes off (workspace_role = null,
   * link_role = null) AND rotate the capability token, so the pre-delete public link is dead until
   * re-shared. Idempotent shape (an upsert on the doc's share_links row). Called only after a
   * restore actually changed a row.
   */
  resetShareAxesPrivate(docId: string): Promise<void>;
  /**
   * C-004 fallback target: the RESTORING actor's default project in `workspaceId`
   * (ensureDefaultProject — created if absent). Used when the doc's original project is gone or
   * its project_id is null. Returns the project id to restore into.
   */
  ensureDefaultProject(input: {
    workspaceId: string;
    ownerId: string;
    userName: string;
  }): Promise<string>;
  /** Whether `projectId` still exists in `workspaceId` (C-004: original project may be deleted). */
  projectExists(workspaceId: string, projectId: string): Promise<boolean>;

  // ── doc-delete-trash S-007: permanent (hard) delete from Trash ─────────────────────────
  /**
   * HARD-delete a doc whose `deleted_at IS NOT NULL AND deleted_workspace_id = :workspaceId`
   * (C-007), CASCADING its versions / annotations / comments / share_links. The doc MUST already
   * be in Trash — an active doc is unreachable here (returns 0). Runs inside a single transaction
   * so a partial purge can't happen. Returns rows changed (0 when no such tombstone exists in THIS
   * workspace — the not-found / already-purged signal for the route).
   */
  purgeDeleted(workspaceId: string, docId: string): Promise<number>;
}

export interface DocDeleteDeps {
  repo: DocDeleteRepo;
  /** The actor's effective per-doc role (resolveAccess seam). Null = no per-doc grant. */
  resolveDocRole: (docId: string, userId: string) => Promise<Role | null>;
  /**
   * Whether the actor is an admin of THE DOC'S workspace — the workspace-admin arm of the
   * composed gate (C-003). Web-only (MCP resolves no workspace-admin — that surface is a later
   * story). Scoped to (workspaceId, userId) by the route, never "any".
   */
  isWorkspaceAdmin?: (userId: string) => boolean | Promise<boolean>;
  /**
   * Best-effort post-commit activity emit (C-006 / AS-005). When provided, a SUCCESSFUL
   * tombstone (the conditional update changed a row) logs ONE `doc_deleted` event with the
   * actor + the doc as subject. Omitted → no emit (the delete still succeeds). The emit is
   * swallowed on failure (emitActivity never throws) so it can't fail the delete.
   */
  activity?: ActivityEmitDeps;
  now?: () => Date;
}

export interface DeleteResult {
  docId: string;
  slug: string;
}

/**
 * Soft-delete a doc into Trash (AS-001..AS-005, AS-021, AS-022).
 *
 * Gate (C-003): (per-doc role ∈ {owner, editor}) OR (workspace admin). A source the actor
 * cannot see → 404 (existence-hiding); a visible doc with too-low role + non-admin → 403.
 * The tombstone is idempotent (C-006): a second delete is a no-op and emits nothing.
 */
export async function deleteDoc(
  input: { slug: string; actorId: string },
  deps: DocDeleteDeps,
): Promise<DeleteResult> {
  const doc = await deps.repo.findDocBySlug(input.slug);
  if (!doc) {
    throw new DocDeleteRejected("doc not found", "not_found");
  }

  // The two orthogonal gate arms (C-003). Resolve both, OR them.
  const role = await deps.resolveDocRole(doc.id, input.actorId);
  const isAdmin = deps.isWorkspaceAdmin ? !!(await deps.isWorkspaceAdmin(input.actorId)) : false;

  // Existence-hiding: an actor with NO per-doc role AND not an admin cannot tell the doc
  // apart from a non-existent one → 404 (matches the doc-move / browse existence-hiding rule).
  if (role === null && !isAdmin) {
    throw new DocDeleteRejected("doc not found", "not_found");
  }

  // The composed gate: per-doc role must carry EDIT capability (editor or owner — both `can`
  // edit; commenter/viewer cannot), OR the actor is a workspace admin. Either arm admits.
  const perDocAdmits = role !== null && can(role, "edit");
  if (!perDocAdmits && !isAdmin) {
    throw new DocDeleteRejected("insufficient permission to delete this doc", "forbidden");
  }

  // C-005: capture the doc's OWN workspace at delete time. A doc with no resolvable workspace
  // (project-less / vanished) cannot be placed in any Trash → treat as not-found (nothing to
  // anchor the tombstone to). The route should never hit this for a published doc.
  const workspaceId = await deps.repo.workspaceOfDoc(doc.id);
  if (workspaceId == null) {
    throw new DocDeleteRejected("doc not found", "not_found");
  }

  // C-006: the CONDITIONAL tombstone (UPDATE … WHERE deleted_at IS NULL). Returns rows changed.
  const deletedAt = (deps.now ?? (() => new Date()))();
  const changed = await deps.repo.softDelete(doc.id, deletedAt, workspaceId);

  // Emit ONLY when the conditional update actually tombstoned the doc (no double-emit on a
  // retry — the second delete changes 0 rows, C-006 / AS-022). Best-effort post-commit.
  if (changed > 0 && deps.activity) {
    await emitActivity(
      {
        type: "doc_deleted",
        actorUserId: input.actorId,
        docId: doc.id,
        // The owning workspace is the captured one (a doc-scoped event; emitActivity would
        // otherwise re-resolve via workspaceOfDoc, but the doc is now tombstoned).
        workspaceId,
        summary: "deleted doc",
      },
      deps.activity,
    );
  }

  return { docId: doc.id, slug: doc.slug };
}

// ── doc-delete-trash S-003: Trash list + restore ─────────────────────────────────────────────

/** Deps for the Trash list (a thin read; the workspace gate is the route's `requireWorkspaceMember`). */
export interface ListTrashDeps {
  repo: Pick<DocDeleteRepo, "listTrash">;
}

/**
 * The workspace Trash (AS-013, AS-026, C-007). SCOPED to the path workspace in SQL — a deleted
 * row escapes the browse access filter, so this workspace match is the only thing keeping another
 * workspace's tombstones out (AS-026). An empty list is the AS-013 empty state.
 */
export async function listTrash(
  input: { workspaceId: string },
  deps: ListTrashDeps,
): Promise<TrashEntry[]> {
  return deps.repo.listTrash(input.workspaceId);
}

export interface RestoreResult {
  docId: string;
  slug: string;
  /** The project the doc was restored into (original when it still exists, else the actor's default). */
  projectId: string;
}

export interface RestoreDocDeps {
  repo: Pick<
    DocDeleteRepo,
    | "findDeletedById"
    | "restore"
    | "resetShareAxesPrivate"
    | "ensureDefaultProject"
    | "projectExists"
  >;
  /** The actor's effective per-doc role (resolveAccess seam) — one arm of the composed gate. */
  resolveDocRole: (docId: string, userId: string) => Promise<Role | null>;
  /** Whether the actor is an admin of the path workspace — the other gate arm (web-only, C-003). */
  isWorkspaceAdmin?: (userId: string) => boolean | Promise<boolean>;
  /** The restoring actor's display name — names their default project on the C-004 fallback. */
  resolveActorName?: (userId: string) => Promise<string | null>;
  /** Best-effort post-restore activity emit (AS-012). Emitted ONLY when a row actually changed. */
  activity?: ActivityEmitDeps;
}

/**
 * Restore a deleted doc from Trash (AS-010..AS-013, AS-020, AS-023..AS-027).
 *
 * Scoping (C-007): the doc is resolved by id AND `deleted_workspace_id = path workspace` — a doc
 * in another workspace's Trash is unreachable (404, AS-025). Gate (C-003): the SAME composed gate
 * as delete — (per-doc role ∈ {owner, editor}) OR (workspace admin). Target project (C-004): the
 * original project when it still exists, else the RESTORING actor's default project in the doc's
 * deleted_workspace_id (ensureDefaultProject). Private-on-restore (C-008): both axes off + token
 * rotated, applied only when the un-tombstone actually changed a row. Idempotent (C-006): an
 * already-active doc changes 0 rows and emits no `doc_restored` (AS-027).
 */
export async function restoreDoc(
  input: { workspaceId: string; docId: string; actorId: string },
  deps: RestoreDocDeps,
): Promise<RestoreResult> {
  // C-007: resolve the tombstone within THIS workspace only. A missing/other-workspace/active doc
  // is not found here → existence-hiding 404 (AS-025 / AS-027 stale-active retry).
  const doc = await deps.repo.findDeletedById(input.workspaceId, input.docId);
  if (!doc) {
    throw new DocDeleteRejected("doc not found", "not_found");
  }

  // The composed gate (C-003) — same as delete. Resolve both arms, OR them.
  const role = await deps.resolveDocRole(doc.id, input.actorId);
  const isAdmin = deps.isWorkspaceAdmin ? !!(await deps.isWorkspaceAdmin(input.actorId)) : false;
  const perDocAdmits = role !== null && can(role, "edit");
  if (!perDocAdmits && !isAdmin) {
    // A VISIBLE-in-Trash doc the actor may not restore → 403 (commenter/viewer + non-admin, AS-020).
    throw new DocDeleteRejected("insufficient permission to restore this doc", "forbidden");
  }

  // C-004: target the ORIGINAL project when it still exists, else the RESTORING actor's default
  // project in the doc's deleted_workspace_id (NOT the original owner's default — the owner may be
  // gone, AS-011/AS-024). The fallback runs whenever project_id is null OR the project vanished.
  let targetProjectId: string | null = null;
  if (doc.projectId != null && (await deps.repo.projectExists(input.workspaceId, doc.projectId))) {
    targetProjectId = doc.projectId;
  }
  if (targetProjectId == null) {
    const name = (deps.resolveActorName ? await deps.resolveActorName(input.actorId) : null) ?? "";
    targetProjectId = await deps.repo.ensureDefaultProject({
      workspaceId: input.workspaceId,
      ownerId: input.actorId,
      userName: name,
    });
  }

  // C-006: the CONDITIONAL un-tombstone (UPDATE … WHERE deleted_at IS NOT NULL). Returns rows changed.
  const changed = await deps.repo.restore(doc.id, targetProjectId);

  if (changed > 0) {
    // C-008: restore comes back PRIVATE — both axes off + capability token rotated, so the
    // pre-delete public link is dead until re-shared (AS-023). Only after a real un-tombstone.
    await deps.repo.resetShareAxesPrivate(doc.id);

    // AS-012 / C-006: emit ONE `doc_restored` ONLY when a row actually changed (no emit on the
    // AS-027 idempotent no-op). Best-effort post-commit (emitActivity never throws).
    if (deps.activity) {
      await emitActivity(
        {
          type: "doc_restored",
          actorUserId: input.actorId,
          docId: doc.id,
          workspaceId: input.workspaceId,
          summary: "restored doc",
        },
        deps.activity,
      );
    }
  }

  return { docId: doc.id, slug: doc.slug, projectId: targetProjectId };
}

// ── doc-delete-trash S-007: permanently delete a doc from Trash ────────────────────────────────

export interface PermanentDeleteResult {
  docId: string;
  slug: string;
}

export interface PermanentDeleteDocDeps {
  repo: Pick<DocDeleteRepo, "findDeletedById" | "purgeDeleted">;
  /** The actor's effective per-doc role (resolveAccess seam) — the OWNER arm of the S-007 gate. */
  resolveDocRole: (docId: string, userId: string) => Promise<Role | null>;
  /** Whether the actor is an admin of the path workspace — the other gate arm (web-only, C-003). */
  isWorkspaceAdmin?: (userId: string) => boolean | Promise<boolean>;
}

/**
 * Permanently (HARD) delete a doc from Trash (AS-034, AS-035).
 *
 * Scoping (C-007): the doc is resolved by id AND `deleted_workspace_id = path workspace` — a doc in
 * another workspace's Trash is unreachable (404), and an ACTIVE (not-in-Trash) doc is not found here
 * (findDeletedById requires deleted_at IS NOT NULL), so this route can never hard-delete a live doc.
 *
 * Gate (C-003, NARROWED for S-007): permanent delete is OWNER-OR-ADMIN only — strictly narrower than
 * the soft-delete/restore gate, which also admits a per-doc EDITOR. The data-removal escape hatch is
 * reserved for the doc's owner or a workspace admin; a per-doc editor (or commenter/viewer) is
 * refused (AS-035). Predicate = (per-doc role === "owner") OR (workspace admin) — NOT can(role,
 * "edit"), which would let an editor through.
 *
 * Purge: a single transactional hard-delete of the doc row, which CASCADES its versions /
 * annotations / comments / share_links via the schema FKs (on delete cascade). Nothing is left
 * orphaned; the doc is gone from Trash and unrecoverable.
 */
export async function permanentlyDeleteDoc(
  input: { workspaceId: string; docId: string; actorId: string },
  deps: PermanentDeleteDocDeps,
): Promise<PermanentDeleteResult> {
  // C-007: resolve the tombstone within THIS workspace only. A missing / other-workspace / ACTIVE
  // doc is not found here → existence-hiding 404. (An active doc has deleted_at IS NULL, so
  // findDeletedById returns null — a live doc can never be purged through this route.)
  const doc = await deps.repo.findDeletedById(input.workspaceId, input.docId);
  if (!doc) {
    throw new DocDeleteRejected("doc not found", "not_found");
  }

  // The S-007 gate (C-003, narrowed): OWNER-OR-ADMIN only. Resolve both arms, OR them. Unlike the
  // soft-delete gate this does NOT use can(role, "edit") — a per-doc editor is refused (AS-035).
  const role = await deps.resolveDocRole(doc.id, input.actorId);
  const isAdmin = deps.isWorkspaceAdmin ? !!(await deps.isWorkspaceAdmin(input.actorId)) : false;
  const isOwner = role === "owner";
  if (!isOwner && !isAdmin) {
    // A VISIBLE-in-Trash doc the actor may not purge → 403 (editor/commenter/viewer + non-admin).
    throw new DocDeleteRejected("insufficient permission to permanently delete this doc", "forbidden");
  }

  // The transactional cascade purge (C-007 scoped again in SQL). Idempotent shape: a second purge
  // (already gone) changes 0 rows — but the gate above already 404s on a vanished tombstone.
  await deps.repo.purgeDeleted(input.workspaceId, doc.id);

  return { docId: doc.id, slug: doc.slug };
}
