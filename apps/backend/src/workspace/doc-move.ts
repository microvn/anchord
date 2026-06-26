// Move / copy a doc between projects (workspace-project S-004). Pure logic behind
// injectable ports (mirrors projects.ts / publish's service), so the validate-target,
// authz, move (project_id update), and copy (read-current → create-new-doc) rules are
// unit-testable without a DB.
//
// Decisions locked here (documented + tested):
//  - MOVE authz min  = editor-or-owner on the SOURCE doc (or a workspace admin).
//                      Move mutates the doc's location, so a viewer/commenter is denied
//                      (403). The minimum is `edit` capability on the source role.
//  - COPY authz min  = ANY read access on the SOURCE (a non-null doc-scoped role).
//                      A copy only READS the source content and creates a NEW doc the
//                      copier owns — it never mutates the source — so read is enough.
//  - EXISTENCE-HIDING (C-003): a source the actor cannot access at all (resolveDocRole
//                      → null) collapses to NOT_FOUND, NOT forbidden — so "no access"
//                      is indistinguishable from "does not exist" (matches the browse /
//                      versions existence-hiding rule). A 403 is reserved for a VISIBLE
//                      doc whose role is too low (a reader trying to MOVE).
//  - SAME-WORKSPACE guard: the target project must EXIST and be in the SAME workspace.
//                      A bogus / cross-workspace target → NOT_FOUND, nothing mutated.
//                      Moving INTO the default project is allowed (S-003: default cannot
//                      be deleted, but is a valid move/copy target).
//  - SAME-PROJECT move: moving a doc to the project it is already in is an idempotent
//                      no-op (still writes project_id to the same value; returns ok).
//  - COPY title:       the copy keeps the SOURCE title (the spec leaves the new doc's
//                      title unspecified; keeping it is least-surprising — the project,
//                      not the name, is what changed).
//  - COPY access: a copy is a FRESH doc → its access config (share_links row) is created
//                      with the FIXED new-doc default (workspace_role=commenter, link_role=
//                      null — doc-access-two-axis S-002/C-007), exactly like a new publish.
//                      The SOURCE's sharing is NOT inherited (clean copy, C-008).
//  - COPY version reset: only the source's CURRENT version content becomes the copy's
//                      version 1 — history is NOT carried. Annotations/comments are NOT
//                      copied (C-008 clean-copy invariant).

import { can, type Role } from "../sharing/roles";

/** Thrown when a move/copy is refused. The route maps `code` → HTTP status. */
export class DocMoveRejected extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "forbidden" | "needs_choice",
  ) {
    super(message);
    this.name = "DocMoveRejected";
  }
}

/**
 * project-visibility S-005 / C-009: the caller's explicit access intent on a boundary-crossing
 * move. REQUIRED (server-enforced) when the move crosses a visibility boundary; ignored when it
 * does not. `make_private` restricts the doc ({null,null}); `keep_sharing` leaves its access
 * untouched (soft-private — a shared doc inside a private project stays workspace-visible).
 */
export type AccessChoice = "make_private" | "keep_sharing";

/** The source doc, as the move/copy logic needs it. `null` when no such slug exists. */
export interface SourceDoc {
  id: string;
  slug: string;
  title: string;
  kind: "html" | "markdown" | "image";
  projectId: string | null;
  /**
   * project-visibility S-005 / C-009: the doc's CURRENT workspace axis
   * (`share_links.workspace_role`) — non-null ⇒ the doc is workspace-shared. The move
   * boundary-detection compares THIS against the target project's visibility to decide if
   * an explicit access choice is required. Read on the same source fetch (no extra round-trip).
   */
  workspaceRole: "viewer" | "commenter" | "editor" | null;
}

/**
 * project-visibility S-005 / C-009: the access-relevant shape of a MOVE target project.
 * `isDefault` + `visibility` are exactly what decides whether the move crosses a boundary
 * (the per-member default project is private-shell but treated as shared — the decouple
 * carve-out, mirroring deriveNewDocAccess). `null` when the target does not exist.
 */
export interface TargetProjectAccess {
  isDefault: boolean;
  visibility: "private" | "public";
}

/** The source's current (highest) version content, for a copy. */
export interface CurrentVersion {
  content: string;
  contentHash: string;
}

/**
 * Persistence port. The real impl (repo.ts) is thin Drizzle glue. Reads:
 *  - findDocBySlug          — resolve the source.
 *  - targetProjectViewableBy — does `projectId` exist AND may the actor VIEW it (C-006)?
 *  - currentVersion         — the source's highest-version content (for copy).
 * Writes:
 *  - setProjectId          — MOVE: relocate the source (only project_id changes).
 *  - createCopy            — COPY: insert a NEW doc + its version 1 (no annotations).
 */
export interface DocMoveRepo {
  findDocBySlug(slug: string): Promise<SourceDoc | null>;
  /**
   * project-visibility S-002 / C-006: a move/copy TARGET must be a project the ACTOR can SEE
   * (canViewProject — own OR public, no admin exception, C-003). Returns true iff `projectId`
   * exists in the workspace AND the actor may view it; a bogus id, a cross-workspace id, AND
   * another member's PRIVATE project all return false → the route refuses identically (404,
   * existence-hiding) so the move can never be used to confirm a private project exists (AS-009).
   * (Was `projectInWorkspace` — bare existence — before two-axis project visibility.)
   */
  targetProjectViewableBy(projectId: string, actorId: string): Promise<boolean>;
  /**
   * project-visibility S-005 / C-009: the access-relevant facts of the MOVE target
   * (`isDefault` + `visibility`) so the service can detect a visibility boundary. `null`
   * when the project does not exist (the viewable-check already ran, so this is rare).
   */
  targetProjectAccess(projectId: string): Promise<TargetProjectAccess | null>;
  /** The source doc's current (max) version content + hash, or null if it has none. */
  currentVersion(docId: string): Promise<CurrentVersion | null>;
  /** MOVE: relocate the doc — set ONLY docs.project_id. Nothing else changes. */
  setProjectId(docId: string, projectId: string): Promise<void>;
  /**
   * project-visibility S-005 / C-009: a BOUNDARY-CROSSING move — relocate the doc AND apply the
   * access change in ONE transaction (atomic; if the access write fails the move rolls back, no
   * half-state). `restrict=true` ⇒ make-private ({null,null}); `restrict=false` ⇒ keep-sharing
   * (project_id changes, share_links untouched). The atomicity is the repo's contract — the
   * service never issues two separate writes for a crossing move.
   */
  moveWithAccess(docId: string, projectId: string, restrict: boolean): Promise<void>;
  /**
   * COPY: create a NEW doc in `projectId` with `content` as version 1. Owner = the
   * copier. The repo also creates the copy's share_links row with the FIXED new-doc
   * default (workspace_role=commenter, link_role=null — doc-access-two-axis S-002/C-007),
   * exactly like a fresh publish; the SOURCE's sharing is NOT inherited (clean copy).
   * Returns the new doc's id + slug. Does NOT copy annotations/comments/history.
   */
  createCopy(input: {
    title: string;
    kind: "html" | "markdown" | "image";
    content: string;
    contentHash: string;
    ownerId: string;
    projectId: string;
    extractedText: string | null;
  }): Promise<{ id: string; slug: string }>;
}

export interface DocMoveDeps {
  repo: DocMoveRepo;
  /** The actor's effective role on the SOURCE doc (sharing seam). Null = no access. */
  resolveDocRole: (docId: string, userId: string) => Promise<Role | null>;
  /** True if the actor is a workspace admin (admin may move regardless of doc role). */
  isWorkspaceAdmin?: (userId: string) => boolean | Promise<boolean>;
  /** Derive the searchable text for the copy's v1 (mirrors publish). */
  extractText?: (content: string, kind: "html" | "markdown" | "image") => string;
}

/**
 * Resolve the source doc the actor may at least READ, or throw NOT_FOUND
 * (existence-hiding): a missing slug AND a no-access source both collapse to 404.
 * Returns the doc + the actor's effective role (null only when admin-but-no-doc-role,
 * which the caller treats as sufficient for move).
 */
async function loadReadableSource(
  slug: string,
  userId: string,
  deps: DocMoveDeps,
): Promise<{ doc: SourceDoc; role: Role | null; isAdmin: boolean }> {
  const doc = await deps.repo.findDocBySlug(slug);
  if (!doc) {
    throw new DocMoveRejected("doc not found", "not_found");
  }
  const role = await deps.resolveDocRole(doc.id, userId);
  const isAdmin = deps.isWorkspaceAdmin ? !!(await deps.isWorkspaceAdmin(userId)) : false;
  // No doc-scoped role AND not an admin → indistinguishable from "does not exist".
  if (role === null && !isAdmin) {
    throw new DocMoveRejected("doc not found", "not_found");
  }
  return { doc, role, isAdmin };
}

/**
 * Validate the target project exists in the actor's workspace AND the actor may VIEW it
 * (project-visibility S-002 / C-006), or throw NOT_FOUND. A target the actor cannot see
 * (another member's private project) is refused indistinguishably from a missing project —
 * the move never leaks a private project's existence (AS-009, existence-hiding).
 */
async function requireTargetProject(
  projectId: string,
  actorId: string,
  deps: DocMoveDeps,
): Promise<void> {
  if (!(await deps.repo.targetProjectViewableBy(projectId, actorId))) {
    throw new DocMoveRejected("target project not found in this workspace", "not_found");
  }
}

export interface MoveResult {
  docId: string;
  slug: string;
  projectId: string;
}

/**
 * project-visibility S-005 / C-009: does relocating a doc whose CURRENT workspace axis is
 * `workspaceRole` into a project of access-class `target` cross a visibility boundary?
 *
 * The precise, server-enforced rule (the primary case the spec cares about — moving a SHARED
 * doc into a PRIVATE project): a mismatch exists IFF the target is a NON-DEFAULT PRIVATE
 * project AND the doc is currently workspace-shared (`workspaceRole != null`). In that case the
 * move would either silently over-restrict (drop the doc out of the workspace) or silently keep
 * a doc shared inside a private project — both are decided by the explicit choice, never by the
 * server alone. Every other move (target public, target default, or an already-restricted doc)
 * implies no access change and needs no choice. The default project is treated as shared-shell
 * (mirrors deriveNewDocAccess's carve-out) so moving INTO it never crosses.
 */
export function isVisibilityBoundaryCrossing(
  workspaceRole: SourceDoc["workspaceRole"],
  target: TargetProjectAccess,
): boolean {
  const targetRestricts = !target.isDefault && target.visibility === "private";
  const docIsShared = workspaceRole != null;
  return targetRestricts && docIsShared;
}

/**
 * MOVE a doc to another project (AS-008 / C-008). For an ordinary move, updates ONLY
 * docs.project_id — the id, slug, versions, annotations/comments, sharing, owner all stay.
 *
 * project-visibility S-005 / C-009 — a move that CROSSES a visibility boundary (a workspace-
 * shared doc into a non-default private project) must NOT silently keep or silently restrict:
 *  - no `accessChoice` supplied  → REFUSED ("needs_choice", server-enforced — AS-021), nothing
 *    moved, nothing changed; the FE shows the choice dialog and retries.
 *  - `accessChoice=make_private`  → move + share_links→{null,null} in ONE transaction (AS-022).
 *  - `accessChoice=keep_sharing`  → move only, access untouched (soft-private — AS-023).
 * A non-crossing move ignores `accessChoice` and behaves exactly as before (no regression).
 *
 * Authz: editor-or-owner on the source (or a workspace admin). A reader (viewer/commenter)
 * attempting a move → 403. A source the actor cannot access at all → 404. Target must exist in
 * the same workspace AND be viewable → else 404. Moving to the project the doc is already in is
 * an idempotent no-op.
 */
export async function moveDoc(
  input: {
    slug: string;
    targetProjectId: string;
    actorId: string;
    /** S-005 / C-009: the explicit access intent; REQUIRED only on a boundary-crossing move. */
    accessChoice?: AccessChoice;
  },
  deps: DocMoveDeps,
): Promise<MoveResult> {
  const { doc, role, isAdmin } = await loadReadableSource(input.slug, input.actorId, deps);

  // Move mutates the doc's location → require `edit` capability (editor/owner), unless
  // the actor is a workspace admin. A visible-but-too-low role → 403 (not 404).
  if (!isAdmin && !(role !== null && can(role, "edit"))) {
    throw new DocMoveRejected("not allowed to move this doc", "forbidden");
  }

  // Validate the target AFTER authz so a forbidden actor never probes project existence.
  // C-006: the target must be a project the ACTOR can SEE (existence-hiding for private — AS-009).
  await requireTargetProject(input.targetProjectId, input.actorId, deps);

  // S-005 / C-009: resolve the target's access class and detect a visibility boundary. The
  // target was just viewable-checked, so a null here is a vanished project → fall back to a
  // shared-shell class (no boundary), never crash the move.
  const target =
    (await deps.repo.targetProjectAccess(input.targetProjectId)) ??
    ({ isDefault: true, visibility: "public" } as TargetProjectAccess);
  const crossing = isVisibilityBoundaryCrossing(doc.workspaceRole, target);

  if (crossing) {
    // Server enforces the choice (AS-021): without it, refuse — nothing moved, nothing changed.
    if (input.accessChoice === undefined) {
      throw new DocMoveRejected(
        "this move crosses a visibility boundary — choose make-private or keep-sharing",
        "needs_choice",
      );
    }
    // Move + access change applied ATOMICALLY in one transaction (AS-022/AS-023).
    await deps.repo.moveWithAccess(
      doc.id,
      input.targetProjectId,
      input.accessChoice === "make_private",
    );
    return { docId: doc.id, slug: doc.slug, projectId: input.targetProjectId };
  }

  // Non-crossing: ordinary move (idempotent; same project writes the same value). The
  // accessChoice, if any, is irrelevant here — no access change is implied.
  await deps.repo.setProjectId(doc.id, input.targetProjectId);

  return { docId: doc.id, slug: doc.slug, projectId: input.targetProjectId };
}

export interface CopyResult {
  docId: string;
  slug: string;
  projectId: string;
}

/**
 * COPY (duplicate) a doc into another project (AS-013 / C-008). Creates a NEW doc with a
 * NEW slug whose version 1 = the SOURCE's CURRENT version content; owner = the copier.
 * Annotations/comments/version-history are NOT copied (clean copy). The source is
 * untouched.
 *
 * Authz: ANY read access on the source is enough (copy only reads + creates a new doc
 * the copier owns). A source the actor cannot access at all → 404. Target must exist in
 * the same workspace → else 404.
 */
export async function copyDoc(
  input: { slug: string; targetProjectId: string; actorId: string },
  deps: DocMoveDeps,
): Promise<CopyResult> {
  // Read access is sufficient — loadReadableSource already enforces "at least readable
  // or admin", which is exactly the copy minimum. No extra capability gate.
  const { doc } = await loadReadableSource(input.slug, input.actorId, deps);

  // C-006: copy target must also be a project the actor can SEE (AS-009 applies to copy too).
  await requireTargetProject(input.targetProjectId, input.actorId, deps);

  const current = await deps.repo.currentVersion(doc.id);
  if (!current) {
    // A doc with no versions cannot be copied (nothing to seed v1 with). Treat as 404 —
    // there is no current content to duplicate.
    throw new DocMoveRejected("source doc has no content to copy", "not_found");
  }

  const extractText = deps.extractText;
  const extractedText = extractText ? extractText(current.content, doc.kind) : null;

  const created = await deps.repo.createCopy({
    // Decision: keep the source title (the project changed, not the name).
    title: doc.title,
    kind: doc.kind,
    content: current.content,
    contentHash: current.contentHash,
    // Owner = the copier (a fresh publish), NOT the source owner.
    ownerId: input.actorId,
    projectId: input.targetProjectId,
    extractedText,
    // doc-access-two-axis S-002 (C-007): the copy's share_links row is created by the repo
    // with the FIXED new-doc default (workspace_role=commenter, link_role=null) — a clean
    // copy never inherits the source's sharing.
  });

  return { docId: created.id, slug: created.slug, projectId: input.targetProjectId };
}
