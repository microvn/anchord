// mcp-roundtrip S-002 — the publish write tools: `anchord_create_document` and
// `anchord_update_document`. Both plug into the S-001 pipeline as ToolDef entries
// (requiredScope: "docs:write" — the scope gate in server.ts enforces C-009 before
// dispatch, so these handlers never run for a read-only token).
//
// These are an API SURFACE over the EXISTING domain services — no new content model:
//   • create  → publish/service.ts `publishDoc` (immutable slug + version 1, project
//               resolution) — C-002/C-006/AS-003/AS-018/AS-019.
//   • update  → services/version-repo.ts `appendVersionTx` (per-doc advisory lock +
//               UNIQUE(doc_id, version) backstop = C-011 serialization, AS-026) then
//               FIRE the existing re-anchor seam (annotation-core:S-005, async,
//               idempotent ledger) — C-012/AS-004/AS-028.
//
// Authorization is the per-RESOURCE gate INSIDE the tool, AFTER the scope check (C-001):
//   • create: the doc lands in the token-owner's workspace with the new-doc access
//             default (workspace_role=commenter, link_role=null — doc-access-two-axis
//             S-002/C-007, set by the publish repo); the
//             project resolver rejects a foreign/invalid projectId (AS-019).
//   • update: editor+ rights on the target doc via resolveAccess (AS-004/AS-005); a
//             missing doc or too-low role is rejected with a create_document hint.
//
// Everything is behind injectable ports so the tools are unit-testable without a DB
// (the same fake-repo pattern publish.test.ts uses); the route wires the concrete
// Drizzle-backed deps in index.ts / routes/mcp.ts.

import type { ToolContext, ToolDef } from "../server";
import { can, type Role } from "../../sharing/roles";
import { patchMarkdownSource, patchHtmlSource, MarkdownPatchError, type BlockEdit } from "../../render/markdown";

/** Thrown by a tool when the request is rejected — the pipeline maps it to a JSON-RPC error. */
export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolError";
  }
}

// ── anchord_create_document (AS-003/AS-018/AS-019, C-002/C-006) ─────────────

/** What the create tool returns to the agent (AS-003.T4). */
export interface CreateDocumentResult {
  docId: string;
  slug: string;
  url: string;
  /**
   * project-visibility S-004 (C-013 / AS-029): the target project the doc landed in + the
   * doc's resulting access LEVEL ("restricted" / "anyone_in_workspace" / "anyone_with_link"),
   * so an agent that passed no projectId LEARNS the doc went to its default project and is
   * workspace-visible (reviewable) — never a silent surprise. Null project only on a seed path.
   */
  project: { id: string; name: string | null } | null;
  access: "restricted" | "anyone_in_workspace" | "anyone_with_link";
}

/**
 * The create port — an API-surface adapter over publish/service.ts `publishDoc`. It
 * MUST: create the doc in `workspaceId` as the token-owner (`ownerId`) with the new-doc
 * access default (workspace_role = commenter, link_role = null — doc-access-two-axis
 * S-002 / C-007, applied by the publish repo, identical to the web surface), version 1
 * with an immutable slug; resolve placement (explicit writable projectId honored,
 * foreign/invalid rejected, missing → owner's default project — C-006); and return
 * `{ docId, slug, url }`. A foreign/invalid projectId MUST throw (never silently default
 * — AS-019).
 */
export type CreateDocumentPort = (input: {
  workspaceId: string;
  ownerId: string;
  content: string;
  /** "html" | "markdown" — the agent-declared format. */
  format: string;
  title?: string;
  projectId?: string | null;
}) => Promise<CreateDocumentResult>;

/** Valid `format` values an agent may declare (image is not an MCP-creatable format in v0). */
const CREATABLE_FORMATS = new Set(["html", "markdown"]);

function asString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new McpToolError(`'${field}' is required and must be a non-empty string`);
  }
  return v;
}

function optionalString(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new McpToolError(`'${field}' must be a string`);
  return v;
}

/**
 * Build the `anchord_create_document` tool. The handler reads identity from the resolved
 * ToolContext (userId + workspaceId derived from the token, never from params — C-001) and
 * never lets the caller set visibility (the new-doc default — workspace_role=commenter,
 * link_role=null — is applied by the publish repo: doc-access-two-axis S-002/C-007).
 */
export function createDocumentHandler(
  port: CreateDocumentPort,
): (params: Record<string, unknown>, ctx: ToolContext) => Promise<CreateDocumentResult> {
  return async function handler(params, ctx): Promise<CreateDocumentResult> {
    const content = asString(params.content, "content");
    const format = asString(params.format, "format");
    if (!CREATABLE_FORMATS.has(format)) {
      throw new McpToolError(`unsupported format '${format}' (expected 'html' or 'markdown')`);
    }
    const title = optionalString(params.title, "title");
    const projectId = optionalString(params.projectId, "projectId") ?? null;

    // Identity + workspace come from the TOKEN (ctx), not the params (C-001/C-006).
    return port({
      workspaceId: ctx.workspaceId,
      ownerId: ctx.userId,
      content,
      format,
      title,
      projectId,
    });
  };
}

/** The `anchord_create_document` ToolDef (scope-gated docs:write — C-009). */
export function createDocumentTool(port: CreateDocumentPort): ToolDef {
  return { requiredScope: "docs:write", handler: createDocumentHandler(port) };
}

// ── anchord_update_document (AS-004/AS-005/AS-026/AS-028, C-002/C-011/C-012) ─

/** What the update tool returns to the agent. */
export interface UpdateDocumentResult {
  docId: string;
  version: number;
  previousVersion: number | null;
}

/** A doc as the update tool needs to gate it: its id + kind (for re-anchor/extract). */
export interface UpdateTargetDoc {
  id: string;
  kind: "html" | "markdown" | "image";
}

/**
 * The update ports — split so authorization, append, and re-anchor each stay a single
 * injectable seam reusing the EXISTING services.
 */
export interface UpdateDocumentPorts {
  /** Resolve a doc by id, or null when it does not exist (AS-005 nonexistent docId). */
  findDocById(docId: string): Promise<UpdateTargetDoc | null>;
  /**
   * The token-owner's effective role on the doc (resolveAccess/resolveDocRole), or null
   * when no source grants one. editor+ required to update (C-002/AS-004/AS-005).
   */
  resolveRole(docId: string, userId: string): Promise<Role | null>;
  /**
   * Append a new immutable version (no overwrite). MUST be per-doc serialized with the
   * UNIQUE(doc_id, version) backstop (C-011 — appendVersionTx) so concurrent updates
   * yield N+1 then N+2, never two N+1 (AS-026). Returns the new + previous version.
   */
  appendVersion(input: {
    docId: string;
    content: string;
    publishedBy: string;
    kind: "html" | "markdown" | "image";
  }): Promise<{ version: number; previousVersion: number | null }>;
  /**
   * FIRE the existing re-anchor seam (annotation-core:S-005, async, idempotent ledger).
   * The tool does NOT await it (C-012: update returns only after the version is durably
   * committed; re-anchor runs async, failure leaves annotations in their PREVIOUS state
   * and is retried — AS-028). Skipped for a doc's first extra version is the caller's call.
   */
  fireReanchor?(input: {
    docId: string;
    version: number;
    /** RAW version content (markdown source or HTML); the job renders it before re-anchoring. */
    content: string;
    /** Doc kind — drives renderForAnchoring inside the job (markdown→HTML before the matcher). */
    kind: "html" | "markdown" | "image";
  }): void;
}

/**
 * Build the `anchord_update_document` tool. Order (C-001/C-002): resolve the target →
 * 404-style reject if missing → editor+ gate → append (serialized) → fire re-anchor →
 * return AFTER the version is committed.
 */
export function updateDocumentHandler(
  ports: UpdateDocumentPorts,
): (params: Record<string, unknown>, ctx: ToolContext) => Promise<UpdateDocumentResult> {
  return async function handler(params, ctx): Promise<UpdateDocumentResult> {
    const docId = asString(params.docId, "docId");
    const content = asString(params.content, "content");

    const doc = await ports.findDocById(docId);
    if (!doc) {
      // AS-005: nonexistent docId → reject; suggest create_document for a NEW doc.
      throw new McpToolError(
        `document '${docId}' not found — use anchord_create_document to create a new document`,
      );
    }

    const role = await ports.resolveRole(docId, ctx.userId);
    // C-002/AS-004/AS-005: editor+ rights required. No role (or too low) → reject with
    // the same create_document hint (don't disclose whether the doc exists vs is hidden
    // any more than the suggestion implies).
    if (role === null || !can(role, "edit")) {
      throw new McpToolError(
        `not permitted to update document '${docId}' (editor rights required) — ` +
          `use anchord_create_document to create a new document instead`,
      );
    }

    // C-011: append is per-doc serialized (advisory lock + UNIQUE backstop) so two
    // concurrent updates produce strictly sequential versions (AS-026).
    const { version, previousVersion } = await ports.appendVersion({
      docId,
      content,
      publishedBy: ctx.userId,
      kind: doc.kind,
    });

    // C-012/AS-004/AS-028: FIRE re-anchor async AFTER the version is committed (returned
    // by appendVersion). Not awaited — a re-anchor failure leaves annotations in their
    // PREVIOUS state and is retried; it never gates this success. Skip a doc's FIRST
    // version (no prior content to re-anchor) — mirrors routes/versions.ts fireReanchor.
    if (ports.fireReanchor && previousVersion !== null) {
      // Pass RAW content + the doc's kind — the job renders markdown→HTML before the matcher.
      ports.fireReanchor({ docId, version, content, kind: doc.kind });
    }

    return { docId, version, previousVersion };
  };
}

/** The `anchord_update_document` ToolDef (scope-gated docs:write — C-009). */
export function updateDocumentTool(ports: UpdateDocumentPorts): ToolDef {
  return { requiredScope: "docs:write", handler: updateDocumentHandler(ports) };
}

// ── anchord_patch_document (S-002 — AS-005…AS-014/AS-024, C-001..C-004/C-006/C-008) ─
//
// A block-addressed patch: version-pinned `{ blockId, find, replace }` edits spliced into
// the addressed block's MARKDOWN SOURCE, appending a new immutable version WITHOUT the agent
// re-emitting the whole doc. The whole-doc `anchord_update_document` STAYS the fallback. The
// splice + ambiguity + structural guard live in render/markdown.ts (`patchMarkdownSource`);
// this handler owns the authz gate (C-006), atomic validation (C-002), and the hard version
// pin verified INSIDE the serialized append (C-003).

/** What the patch tool returns to the agent (AS-005.T3). */
export interface PatchDocumentResult {
  docId: string;
  version: number;
  previousVersion: number | null;
}

/** A doc as the patch tool needs to gate + splice it: id + kind (markdown vs html). */
export interface PatchTargetDoc {
  id: string;
  kind: "html" | "markdown" | "image";
}

/**
 * The patch ports — authorization + current-content read + the pinned serialized append, each
 * a single injectable seam reusing the EXISTING services (fake-repo testable, no DB).
 */
export interface PatchDocumentPorts {
  /** Resolve a doc by id, or null when it does not exist. */
  findDocById(docId: string): Promise<PatchTargetDoc | null>;
  /** The token-owner's effective role on the doc (resolveAccess), or null. editor+ required (C-006). */
  resolveRole(docId: string, userId: string): Promise<Role | null>;
  /** The doc's CURRENT version + raw content (the markdown source to splice). null if absent. */
  getCurrentVersion(docId: string): Promise<{ version: number; content: string } | null>;
  /**
   * Append a new immutable version. The HARD version pin (C-003) MUST be verified INSIDE this
   * per-doc-serialized step (advisory lock + UNIQUE(doc_id,version) — appendVersionTx) that
   * reads the current version: if `expectedVersion` != the version read under the lock, throw
   * (no lost update, AS-009). Returns the new + previous version.
   */
  appendVersion(input: {
    docId: string;
    content: string;
    publishedBy: string;
    kind: "html" | "markdown" | "image";
    expectedVersion: number;
  }): Promise<{ version: number; previousVersion: number | null }>;
  /**
   * FIRE the existing re-anchor seam (annotation-core:S-005, async, idempotent) — identical to
   * the whole-doc update path (C-004), EXCEPT it passes the patch's changed-block set so the job
   * carries annotations on untouched blocks deterministically (mcp-patch-document:S-004/C-005).
   * Not awaited; fired only when previousVersion != null.
   */
  fireReanchor?(input: {
    docId: string;
    version: number;
    content: string;
    kind: "html" | "markdown" | "image";
    /** S-004/C-004: the block-ids this patch edited (= every edits[].blockId). */
    changedBlockIds: string[];
  }): void;
}

/** Parse + validate the `edits[]` param into typed BlockEdits (C-001: non-empty, literal strings). */
function parseEdits(raw: unknown): BlockEdit[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    // AS-010: an empty (or non-array) edit list is refused.
    throw new McpToolError("'edits' is required and must be a non-empty array of { blockId, find, replace }");
  }
  return raw.map((e, i) => {
    if (typeof e !== "object" || e === null) {
      throw new McpToolError(`edits[${i}] must be an object { blockId, find, replace }`);
    }
    const rec = e as Record<string, unknown>;
    const blockId = asString(rec.blockId, `edits[${i}].blockId`);
    // find/replace are LITERAL strings (never regex, C-001). find must be non-empty; replace
    // MAY be empty (a deletion) as long as the block set stays unchanged (C-008).
    const find = asString(rec.find, `edits[${i}].find`);
    if (typeof rec.replace !== "string") {
      throw new McpToolError(`edits[${i}].replace must be a string`);
    }
    return { blockId, find, replace: rec.replace };
  });
}

/**
 * Build the `anchord_patch_document` tool. Order (C-001/C-002/C-006): validate params →
 * resolve target → editor+ gate → read current content → splice (atomic, structural guard) →
 * append with the pin verified in the serialized step → fire re-anchor → return.
 */
export function patchDocumentHandler(
  ports: PatchDocumentPorts,
): (params: Record<string, unknown>, ctx: ToolContext) => Promise<PatchDocumentResult> {
  return async function handler(params, ctx): Promise<PatchDocumentResult> {
    const docId = asString(params.docId, "docId");
    if (typeof params.expectedVersion !== "number" || !Number.isInteger(params.expectedVersion)) {
      throw new McpToolError("'expectedVersion' is required and must be an integer");
    }
    const expectedVersion = params.expectedVersion;
    const edits = parseEdits(params.edits); // AS-010: rejects empty before any work.

    const doc = await ports.findDocById(docId);
    if (!doc) {
      throw new McpToolError(
        `document '${docId}' not found — use anchord_create_document to create a new document`,
      );
    }

    // C-006: editor+ required (AS-013). A W1 token never resolves a role on W2 content, so the
    // same gate covers the cross-workspace case (AS-012).
    const role = await ports.resolveRole(docId, ctx.userId);
    if (role === null || !can(role, "edit")) {
      throw new McpToolError(
        `not permitted to patch document '${docId}' (editor rights required)`,
      );
    }

    const current = await ports.getCurrentVersion(docId);
    if (!current) {
      throw new McpToolError(`document '${docId}' has no current version to patch`);
    }

    // Patch supports markdown (S-002) + html (S-003). Image has no addressable text body.
    if (doc.kind === "image") {
      throw new McpToolError(
        `anchord_patch_document cannot patch image documents (doc kind '${doc.kind}') — ` +
          `use anchord_update_document to replace the whole document`,
      );
    }

    // C-002 atomic splice + C-008 structural guard, applied to the doc's SOURCE STRING:
    //   • markdown → splice the addressed block's markdown source (sanitized at render).
    //   • html     → splice the addressed element's innerHTML, kept VERBATIM (C-007 — html
    //                docs are served raw to the sandbox; no patch-specific sanitize).
    // A MarkdownPatchError (find absent/ambiguous, non-patchable block, structural change) is
    // mapped to McpToolError → NO version appended.
    let newContent: string;
    try {
      newContent =
        doc.kind === "html"
          ? patchHtmlSource(current.content, edits)
          : patchMarkdownSource(current.content, edits);
    } catch (e) {
      if (e instanceof MarkdownPatchError) throw new McpToolError(e.message);
      throw e;
    }

    // C-003: append with the pin verified INSIDE the per-doc-serialized step (no lost update).
    const { version, previousVersion } = await ports.appendVersion({
      docId,
      content: newContent,
      publishedBy: ctx.userId,
      kind: doc.kind,
      expectedVersion,
    });

    // C-004 / S-004-C-005: fire re-anchor async AFTER the version is committed (only when there
    // is prior content), passing the CHANGED-BLOCK SET = every edited blockId. The job carries
    // annotations on untouched blocks deterministically and runs the matcher only on edited ones.
    if (ports.fireReanchor && previousVersion !== null) {
      const changedBlockIds = [...new Set(edits.map((e) => e.blockId))];
      ports.fireReanchor({ docId, version, content: newContent, kind: doc.kind, changedBlockIds });
    }

    return { docId, version, previousVersion };
  };
}

/** The `anchord_patch_document` ToolDef (scope-gated docs:write — C-006/mcp-roundtrip C-009). */
export function patchDocumentTool(ports: PatchDocumentPorts): ToolDef {
  return { requiredScope: "docs:write", handler: patchDocumentHandler(ports) };
}

/**
 * The publish tools as a registry fragment, ready to spread into the server's tool
 * map (`{ ...baselineTools(), ...publishTools(deps) }`). Tool names are `anchord_*`
 * (C — avoids collisions when an agent mounts several MCP servers).
 */
export function publishTools(deps: {
  create: CreateDocumentPort;
  update: UpdateDocumentPorts;
  patch?: PatchDocumentPorts;
}): Record<string, ToolDef> {
  return {
    anchord_create_document: createDocumentTool(deps.create),
    anchord_update_document: updateDocumentTool(deps.update),
    ...(deps.patch ? { anchord_patch_document: patchDocumentTool(deps.patch) } : {}),
  };
}
