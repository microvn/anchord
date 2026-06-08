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
   * workspace-project S-003 (AS-005 / C-009): the project this doc belongs to.
   * Already RESOLVED by the time it reaches the repo — explicit projectId (validated
   * to belong to the workspace) or the publisher's default project (MCP fallback when
   * omitted). NULL only for a session-less seed that has no project context.
   */
  projectId?: string | null;
}

/** Persistence port. The real implementation (repo.ts) is thin Drizzle glue. */
export interface DocRepo {
  createDocWithV1(input: CreateDocInput): Promise<{ id: string }>;
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
  const { bytes, filename, declaredKind, editedTitle, ownerId, projectId } = input;
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

  // workspace-project S-003 (AS-005 / C-009): resolve the doc's project BEFORE the
  // write. An explicit-but-invalid projectId throws here (resolveProjectId rejects a
  // foreign/bogus id) so the doc is never silently dropped into the default; an
  // omitted projectId resolves to the publisher's default project (MCP fallback). The
  // seed path (no resolver, no owner) writes a null project_id.
  let resolvedProjectId: string | null = null;
  if (deps.resolveProjectId && ownerId) {
    resolvedProjectId = await deps.resolveProjectId({
      ownerId,
      requestedProjectId: projectId,
    });
  }

  const { id } = await deps.repo.createDocWithV1({
    slug,
    title: finalTitle,
    kind,
    content,
    contentHash: hash(bytes),
    // C-001/C-007: the session publisher becomes the doc owner + v1 publisher.
    // Defaults to null only for a session-less create (seed); set once, immutable.
    ownerId: ownerId ?? null,
    projectId: resolvedProjectId,
  });

  return {
    docId: id,
    slug,
    url: `/d/${slug}`,
    title: finalTitle,
    kind,
    version: 1,
  };
}

export { PublishRejected };
