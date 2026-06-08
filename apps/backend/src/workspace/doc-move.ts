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
//  - COPY general_access: a copy is a FRESH doc → `restricted` (the safe default a new
//                      publish gets). Sharing is NOT inherited (clean copy, C-008).
//  - COPY version reset: only the source's CURRENT version content becomes the copy's
//                      version 1 — history is NOT carried. Annotations/comments are NOT
//                      copied (C-008 clean-copy invariant).

import { can, type Role } from "../sharing/roles";

/** Thrown when a move/copy is refused. The route maps `code` → HTTP status. */
export class DocMoveRejected extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "forbidden",
  ) {
    super(message);
    this.name = "DocMoveRejected";
  }
}

/** The source doc, as the move/copy logic needs it. `null` when no such slug exists. */
export interface SourceDoc {
  id: string;
  slug: string;
  title: string;
  kind: "html" | "markdown" | "image";
  projectId: string | null;
}

/** The source's current (highest) version content, for a copy. */
export interface CurrentVersion {
  content: string;
  contentHash: string;
}

/**
 * Persistence port. The real impl (repo.ts) is thin Drizzle glue. Reads:
 *  - findDocBySlug         — resolve the source.
 *  - projectInWorkspace    — does `projectId` exist in the actor's (single) workspace?
 *  - currentVersion        — the source's highest-version content (for copy).
 * Writes:
 *  - setProjectId          — MOVE: relocate the source (only project_id changes).
 *  - createCopy            — COPY: insert a NEW doc + its version 1 (no annotations).
 */
export interface DocMoveRepo {
  findDocBySlug(slug: string): Promise<SourceDoc | null>;
  /** True iff `projectId` is a project in the actor's single workspace (same-workspace guard). */
  projectInWorkspace(projectId: string): Promise<boolean>;
  /** The source doc's current (max) version content + hash, or null if it has none. */
  currentVersion(docId: string): Promise<CurrentVersion | null>;
  /** MOVE: relocate the doc — set ONLY docs.project_id. Nothing else changes. */
  setProjectId(docId: string, projectId: string): Promise<void>;
  /**
   * COPY: create a NEW doc in `projectId` with `content` as version 1. Owner = the
   * copier. general_access defaults to `restricted` (the repo sets the column default).
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

/** Validate the target project exists in the actor's workspace, or throw NOT_FOUND. */
async function requireTargetProject(projectId: string, deps: DocMoveDeps): Promise<void> {
  if (!(await deps.repo.projectInWorkspace(projectId))) {
    throw new DocMoveRejected("target project not found in this workspace", "not_found");
  }
}

export interface MoveResult {
  docId: string;
  slug: string;
  projectId: string;
}

/**
 * MOVE a doc to another project (AS-008 / C-008). Updates ONLY docs.project_id — the
 * id, slug, versions, annotations/comments, sharing, owner, and general_access all stay.
 *
 * Authz: editor-or-owner on the source (or a workspace admin). A reader (viewer/
 * commenter) attempting a move → 403. A source the actor cannot access at all → 404.
 * Target must exist in the same workspace → else 404 (nothing mutated). Moving to the
 * project the doc is already in is an idempotent no-op.
 */
export async function moveDoc(
  input: { slug: string; targetProjectId: string; actorId: string },
  deps: DocMoveDeps,
): Promise<MoveResult> {
  const { doc, role, isAdmin } = await loadReadableSource(input.slug, input.actorId, deps);

  // Move mutates the doc's location → require `edit` capability (editor/owner), unless
  // the actor is a workspace admin. A visible-but-too-low role → 403 (not 404).
  if (!isAdmin && !(role !== null && can(role, "edit"))) {
    throw new DocMoveRejected("not allowed to move this doc", "forbidden");
  }

  // Validate the target AFTER authz so a forbidden actor never probes project existence.
  await requireTargetProject(input.targetProjectId, deps);

  // Idempotent: moving to the same project still writes the same value (no-op effect).
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

  await requireTargetProject(input.targetProjectId, deps);

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
  });

  return { docId: created.id, slug: created.slug, projectId: input.targetProjectId };
}
