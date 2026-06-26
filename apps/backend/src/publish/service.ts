// Publish service (story S-001): turn an uploaded file or pasted content into a
// published doc with a shareable link.
//
// AS-001/AS-002: a valid artifact creates a doc with an immutable slug + version 1
// and returns its /d/:slug link.
// AS-003: the title is auto-suggested but the author may override it (editedTitle).
// AS-004 (C-003): over-cap artifacts are rejected BEFORE any persistence.
// AS-005 (C-005): content whose sniffed type contradicts its declaration is rejected.
//
// Persistence is behind an injectable DocRepo so the flow is unit-testable without a DB.

import { deriveTitle } from "./title";
import { generateSlug } from "./slug";
import { sniffKind, validateSize, PublishRejected, type DocKind } from "./sniff";
import { extractText } from "../render/extract-text";
import { deriveLevel, type GeneralAccessLevel } from "../sharing/derive-level";

export interface CreateDocInput {
  slug: string;
  title: string;
  kind: DocKind;
  content: string; // HTML/MD text, or an asset key for images
  contentHash: string;
  /**
   * auth-routes S-001 (C-001/C-007): the authenticated publisher's user id (a
   * better-auth TEXT id, e.g. "u_abc123"). Written to docs.owner_id AND
   * doc_versions.published_by for version 1. NULL/omitted only for a doc created
   * without a session (e.g. a seed) — owner is immutable once set (no transfer in
   * v0). Optional so a session-less seed can omit it; the publish service always
   * supplies it from the route's session actor.
   */
  ownerId?: string | null;
  /**
   * workspace-project S-005 (GAP-003 → publish-time extraction / C-006): the plain
   * text extracted from this version's content, for the search index. Derived by the
   * publish service via extractText(content, kind) and written to
   * doc_versions.extracted_text. NULL only for a session-less seed that has no content
   * worth indexing (the seed path can omit it).
   */
  extractedText?: string | null;
  /**
   * workspace-project S-003 (AS-005 / C-009): the project this doc belongs to.
   * Already RESOLVED by the time it reaches the repo — explicit projectId (validated
   * to belong to the workspace) or the publisher's default project (MCP fallback when
   * omitted). NULL only for a session-less seed that has no project context.
   */
  projectId?: string | null;
}

/**
 * The doc-creation result the repo returns (project-visibility S-004 / C-013): the doc id
 * PLUS the target project (id + name) and the doc's resulting two-axis access, so the publish
 * RESPONSE can report where the doc landed + who can see it (transparency — AS-029).
 */
export interface CreateDocResult {
  id: string;
  /** The target project the doc landed in (the resolved id), or null on the seed path. */
  projectId: string | null;
  /** The target project's name, or null when there is no project (seed) / it vanished. */
  projectName: string | null;
  /** doc-access-two-axis axes the share_links row was created with (derived from the project). */
  workspaceRole: "viewer" | "commenter" | "editor" | null;
  linkRole: "viewer" | "commenter" | "editor" | null;
}

/** Persistence port. The real implementation (repo.ts) is thin Drizzle glue. */
export interface DocRepo {
  createDocWithV1(input: CreateDocInput): Promise<CreateDocResult>;
}

/**
 * Resolve the project a doc should land in (workspace-project S-003). Given the
 * publisher and the (optional) requested projectId, return the project id to write.
 * Contract (the publish path enforces the "omitted → default, invalid → error" split):
 *  - requested projectId present → validate it belongs to the publisher's workspace;
 *    a bogus/foreign id MUST throw (never silently fall back to default).
 *  - requested projectId omitted → the publisher's default project (C-009 / MCP fallback).
 */
export type ProjectResolver = (args: {
  workspaceId: string;
  ownerId: string;
  requestedProjectId?: string | null;
}) => Promise<string>;

export interface PublishDeps {
  repo: DocRepo;
  slugGen?: (title: string) => string;
  now?: () => Date;
  hash?: (content: Uint8Array) => string;
  /**
   * workspace-project S-003: resolves the doc's project. Optional so the S-001-era
   * seed path (no workspace context) can omit it → the doc gets a null project_id.
   * The route always supplies it so a published doc always lands in a project.
   */
  resolveProjectId?: ProjectResolver;
}

export interface PublishInput {
  /** Raw bytes of the artifact (uploaded file or pasted text encoded to bytes). */
  bytes: Uint8Array;
  /** Original file name, when uploaded. Absent for a paste. */
  filename?: string;
  /** Author-declared kind, e.g. from a paste "format" selector. */
  declaredKind?: DocKind;
  /** Author's final title (edited before publish). Overrides the auto-derived one. */
  editedTitle?: string;
  /**
   * auth-routes S-001 (C-001/C-007): the authenticated publisher's user id from
   * the SERVER session (never from the request body). Threaded into
   * createDocWithV1 so the doc records this user as owner and version 1 records it
   * as published_by. Optional here only so a session-less seed path can omit it
   * (→ null owner); the route always supplies it (publishing requires a session,
   * C-002).
   */
  ownerId?: string | null;
  /**
   * workspaces S-006: the workspace the publish is scoped to (from the /api/w/:workspaceId
   * path; the gate proved the publisher is a member). The project resolver validates the
   * chosen project belongs to THIS workspace. Omitted on the session-less seed path.
   */
  workspaceId?: string | null;
  /**
   * workspace-project S-003 (AS-005): the project the author chose to publish into.
   * Omitted → the publisher's default project (C-009 / MCP fallback). A supplied id
   * that does not belong to the workspace is rejected by resolveProjectId (not silently
   * defaulted). Never read from anywhere but the validated request.
   */
  projectId?: string | null;
}

export interface PublishResult {
  docId: string;
  slug: string;
  url: string;
  title: string;
  kind: DocKind;
  version: 1;
  /**
   * project-visibility S-004 (C-013 / AS-029): the target project the doc landed in + the
   * doc's resulting general-access LEVEL (deriveLevel of the two axes), so a quick-publish /
   * agent-publish that falls back to the default project is never a silent surprise about
   * where the doc went or who can see it. `project` is null only on the session-less seed path.
   */
  project: { id: string; name: string | null } | null;
  access: GeneralAccessLevel;
}

function sha256Hex(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
}

/**
 * Validate, classify, and persist an artifact as a new published doc.
 * Order matters: sniff + size guards run BEFORE the repo is touched, so a rejected
 * artifact never creates a doc (AS-004 / AS-005).
 */
export async function publishDoc(
  input: PublishInput,
  deps: PublishDeps,
): Promise<PublishResult> {
  const { bytes, filename, declaredKind, editedTitle, ownerId, projectId, workspaceId } = input;
  const slugGen = deps.slugGen ?? generateSlug;
  const hash = deps.hash ?? sha256Hex;

  // C-005 / AS-005: decide the real kind from bytes; reject on mismatch or empty.
  const kind = sniffKind(filename, bytes, declaredKind);

  // C-003 / AS-004: enforce the cap before storing anything.
  validateSize(kind, bytes.length);

  // AS-003: auto-derive a title, then let the author's edit win if provided.
  const suggested = deriveTitle(kind, bytes, filename);
  const finalTitle =
    editedTitle != null && editedTitle.trim().length > 0
      ? editedTitle.trim()
      : suggested;

  // C-004: slug is generated once here and is the doc's immutable identifier.
  const slug = slugGen(finalTitle);

  const content =
    kind === "image" ? (filename ?? slug) : new TextDecoder("utf-8").decode(bytes);

  // workspace-project S-005 (GAP-003 → publish-time extraction / C-006): derive the
  // plain searchable text NOW and store it on the version, so the search index never
  // re-renders content. Extraction reuses the viewer's render/sanitize path.
  const extractedText = extractText(content, kind);

  // workspace-project S-003 (AS-005 / C-009): resolve the doc's project BEFORE the
  // write. An explicit-but-invalid projectId throws here (resolveProjectId rejects a
  // foreign/bogus id) so the doc is never silently dropped into the default; an
  // omitted projectId resolves to the publisher's default project (MCP fallback). The
  // seed path (no resolver, no owner) writes a null project_id.
  let resolvedProjectId: string | null = null;
  if (deps.resolveProjectId && ownerId && workspaceId) {
    resolvedProjectId = await deps.resolveProjectId({
      workspaceId,
      ownerId,
      requestedProjectId: projectId,
    });
  }

  // doc-access-two-axis S-002 (C-007): a new doc's access config (share_links row) is
  // created BY the repo with the fixed new-doc defaults — workspace_role = commenter,
  // link_role = null — so a freshly published doc is shared with its workspace at the
  // comment level and has no public link, with no sharing edit needed. The default is
  // FIXED at publish (not inherited from a workspace setting), applied identically at
  // every publish surface (web + MCP). The legacy general_access column is dropped, so
  // there is no per-doc access value to plumb through here any more.
  const created = await deps.repo.createDocWithV1({
    slug,
    title: finalTitle,
    kind,
    content,
    contentHash: hash(bytes),
    // C-001/C-007: the session publisher becomes the doc owner + v1 publisher.
    // Defaults to null only for a session-less create (seed); set once, immutable.
    ownerId: ownerId ?? null,
    projectId: resolvedProjectId,
    // S-005: the searchable text for this version (empty string for empty content).
    extractedText,
  });

  // project-visibility S-004 (C-013 / AS-029): surface the target project + the doc's resulting
  // access LEVEL (deriveLevel of the axes the repo set) so the caller learns where the doc went.
  return {
    docId: created.id,
    slug,
    url: `/d/${slug}`,
    title: finalTitle,
    kind,
    version: 1,
    project: created.projectId != null ? { id: created.projectId, name: created.projectName } : null,
    access: deriveLevel(created.workspaceRole, created.linkRole),
  };
}

export { PublishRejected };
