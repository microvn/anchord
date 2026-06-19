// mcp-roundtrip S-001 — the REAL MCP server, built on @modelcontextprotocol/sdk.
//
// Replaces the hand-rolled `handleJsonRpc` JSON-RPC framing (which mapped a JSON-RPC
// `method` directly to a tool name, so `initialize`/`tools/list`/`tools/call` returned
// "unknown tool" and NO real MCP client could connect). This module wires anchord's
// existing `ToolDef` registry onto an `McpServer` so the full MCP handshake works:
// `initialize` → `tools/list` → `tools/call`.
//
// The transport itself (WebStandardStreamableHTTPServerTransport) is created PER REQUEST
// in routes/mcp.ts — the stateless transport is single-use, so the McpServer it connects
// to is also built per request, bound to the already-resolved token identity (closure).
//
// Constraint wiring lives in the ROUTE (auth re-validate C-001, origin C-005, rate-limit
// C-007, last_used C-008, log redaction C-014 all run BEFORE this server is ever built).
// What survives HERE is the per-tool scope gate (C-009/AS-011): a write tool called with a
// read-only token is rejected with NO side effect, because the scope check runs before the
// underlying `def.handler` is invoked.

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext, ToolDef } from "./server";
import type { Scope } from "./token";

/** The resolved token identity every MCP request acts under (derived from the token — C-001). */
export interface McpIdentity {
  userId: string;
  /** The ONE workspace this token acts in (C-001 — never from the path/params). */
  workspaceId: string;
  scopes: Scope[];
}

/** serverInfo reported in the `initialize` response. */
const SERVER_NAME = "anchord";
const SERVER_VERSION = "0.0.0";

/**
 * A one-line description + a Zod raw-shape input schema per anchord tool, so `tools/list`
 * is useful to an agent. The shapes are authored from each tool's known params + the spec
 * AS (required vs optional matters); the underlying handler still validates internally (it
 * is the source of truth), so this is the advertised contract, not the only guard.
 *
 * A tool present in the registry but absent here still registers (with an empty input
 * schema + a generic description), so a newly-added tool is never silently dropped.
 */
interface ToolMeta {
  description: string;
  inputSchema: z.ZodRawShape;
}

const TOOL_META: Record<string, ToolMeta> = {
  ping: {
    description: "Health check — returns the calling token's resolved identity and workspace.",
    inputSchema: {},
  },
  // ── publish (docs:write) ──────────────────────────────────────────────────
  anchord_create_document: {
    description: "Publish a new document (version 1) in the token's workspace. Returns { docId, slug, url }.",
    inputSchema: {
      content: z.string(),
      format: z.string(),
      title: z.string().optional(),
      projectId: z.string().optional(),
    },
  },
  anchord_update_document: {
    description: "Append a new immutable version to an existing document (editor+ required).",
    inputSchema: {
      docId: z.string(),
      content: z.string(),
    },
  },
  // ── read (docs:read) ──────────────────────────────────────────────────────
  anchord_list_documents: {
    description: "List documents accessible to the token in its workspace (paginated).",
    inputSchema: {
      page: z.number().optional(),
      limit: z.number().optional(),
    },
  },
  anchord_read_document: {
    description: "Read one document (by id or slug) — its current content and metadata.",
    inputSchema: {
      idOrSlug: z.string(),
    },
  },
  anchord_search_documents: {
    description: "Full-text search documents accessible to the token in its workspace.",
    inputSchema: {
      query: z.string(),
      page: z.number().optional(),
      limit: z.number().optional(),
    },
  },
  // ── pull (annotations:read) ───────────────────────────────────────────────
  anchord_pull_annotations: {
    description: "Pull a document's annotations (anchors + comment threads), cursor-paginated.",
    inputSchema: {
      docId: z.string(),
      cursor: z.string().optional(),
    },
  },
  anchord_list_comments: {
    description: "List a document's comments (flat, paginated).",
    inputSchema: {
      docId: z.string(),
      page: z.number().optional(),
      limit: z.number().optional(),
    },
  },
  // ── write-back (annotations:write) ────────────────────────────────────────
  anchord_reply_comment: {
    description: "Reply to a comment thread (commenter+ required).",
    inputSchema: {
      commentId: z.string(),
      body: z.string(),
    },
  },
  anchord_resolve_comment: {
    description: "Resolve an annotation's thread (commenter+ required).",
    inputSchema: {
      annotationId: z.string(),
    },
  },
  // ── projects ──────────────────────────────────────────────────────────────
  anchord_list_projects: {
    description: "List projects in the token's workspace (projects:read).",
    inputSchema: {
      page: z.number().optional(),
      limit: z.number().optional(),
    },
  },
  anchord_read_project: {
    description: "Read one project by id in the token's workspace (projects:read).",
    inputSchema: {
      projectId: z.string(),
    },
  },
  anchord_create_project: {
    description: "Create a new project in the token's workspace (projects:write).",
    inputSchema: {
      name: z.string(),
    },
  },
};

/** Tool errors whose MESSAGE is safe to surface to the caller as an isError result. */
const EXPECTED_TOOL_ERROR_NAMES = new Set(["McpToolError", "ProjectRejected"]);

function isExpectedToolError(e: unknown): boolean {
  return e instanceof Error && EXPECTED_TOOL_ERROR_NAMES.has(e.name);
}

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

function toolOk(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

/**
 * Build a fresh `McpServer` bound to the resolved token identity, with anchord's existing
 * `ToolDef` registry bridged onto `server.registerTool`. Build ONE per request (the SDK
 * transport is stateless/single-use).
 *
 * The bridge for each `[name, def]`:
 *  - C-009/AS-011 scope gate: if the def requires a scope the identity lacks → an isError
 *    tool result with NO side effect (the underlying handler is never called).
 *  - else call `def.handler(args, ctx)` and wrap its result in an MCP text content block.
 *  - an EXPECTED tool error (McpToolError / ProjectRejected) surfaces its message as an
 *    isError tool result, not a thrown 500; any other throw becomes a generic isError.
 */
export function buildMcpServer(
  identity: McpIdentity,
  tools: Record<string, ToolDef>,
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const ctx: ToolContext = {
    userId: identity.userId,
    workspaceId: identity.workspaceId,
    scopes: identity.scopes,
  };

  for (const [name, def] of Object.entries(tools)) {
    const meta = TOOL_META[name] ?? {
      description: `anchord tool ${name}`,
      inputSchema: {} as z.ZodRawShape,
    };

    server.registerTool(
      name,
      { description: meta.description, inputSchema: meta.inputSchema },
      async (args: Record<string, unknown>) => {
        // C-009/AS-011: scope gate runs BEFORE the handler — a write tool called with a
        // read-only token is rejected with NO side effect (no doc created).
        if (def.requiredScope && !ctx.scopes.includes(def.requiredScope)) {
          return toolError(
            `token is missing the required scope '${def.requiredScope}' for ${name}`,
          );
        }
        try {
          const result = await def.handler(args ?? {}, ctx);
          return toolOk(result);
        } catch (e) {
          // An EXPECTED tool rejection (bad params / per-resource authz) carries a
          // caller-facing message; everything else stays a generic error (no stack leak).
          if (isExpectedToolError(e)) return toolError((e as Error).message);
          return toolError("internal error");
        }
      },
    );
  }

  return server;
}
