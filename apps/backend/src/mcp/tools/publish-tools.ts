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
//   • create: the doc lands in the token-owner's workspace, restricted (C-006); the
//             project resolver rejects a foreign/invalid projectId (AS-019).
//   • update: editor+ rights on the target doc via resolveAccess (AS-004/AS-005); a
//             missing doc or too-low role is rejected with a create_document hint.
//
// Everything is behind injectable ports so the tools are unit-testable without a DB
// (the same fake-repo pattern publish.test.ts uses); the route wires the concrete
// Drizzle-backed deps in index.ts / routes/mcp.ts.

import type { ToolContext, ToolDef } from "../server";
import { can, type Role } from "../../sharing/roles";

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
}

/**
 * The create port — an API-surface adapter over publish/service.ts `publishDoc`. It
 * MUST: create the doc in `workspaceId` as the token-owner (`ownerId`), general_access
 * = restricted (the docs.general_access column default — C-006), version 1 with an
 * immutable slug; resolve placement (explicit writable projectId honored, foreign/invalid
 * rejected, missing → owner's default project — C-006); and return `{ docId, slug, url }`.
 * A foreign/invalid projectId MUST throw (never silently default — AS-019).
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
 * never lets the caller set visibility (C-006: docs default to restricted).
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
  fireReanchor?(input: { docId: string; version: number; newContentHtml: string }): void;
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
      ports.fireReanchor({ docId, version, newContentHtml: content });
    }

    return { docId, version, previousVersion };
  };
}

/** The `anchord_update_document` ToolDef (scope-gated docs:write — C-009). */
export function updateDocumentTool(ports: UpdateDocumentPorts): ToolDef {
  return { requiredScope: "docs:write", handler: updateDocumentHandler(ports) };
}

/**
 * The two publish tools as a registry fragment, ready to spread into the server's tool
 * map (`{ ...baselineTools(), ...publishTools(deps) }`). Tool names are `anchord_*`
 * (C — avoids collisions when an agent mounts several MCP servers).
 */
export function publishTools(deps: {
  create: CreateDocumentPort;
  update: UpdateDocumentPorts;
}): Record<string, ToolDef> {
  return {
    anchord_create_document: createDocumentTool(deps.create),
    anchord_update_document: updateDocumentTool(deps.update),
  };
}
