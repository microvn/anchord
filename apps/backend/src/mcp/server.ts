// mcp-roundtrip S-001 — the MCP request pipeline (hand-rolled JSON-RPC framing).
//
// SPIKE OUTCOME (S-001 first deliverable): the @modelcontextprotocol/sdk
// StreamableHTTPServerTransport drives off Node `IncomingMessage`/`ServerResponse`;
// Elysia/Bun hands a route a WHATWG `Request`/`Response`. Rather than ship a fragile Node
// req/res shim (hard to unit-test, the exact risk the spec flagged), S-001 HAND-ROLLS the
// JSON-RPC framing per C-005 ("native framing"). The Streamable HTTP request/response half
// is a single POST that returns `application/json` JSON-RPC — SSE streaming is only needed
// for server-initiated messages, which v0 tools don't use. The SDK stays pinned for v0.5.
//
// This module is the PURE pipeline (no Elysia): given a parsed JSON-RPC request + the bearer
// token, it runs the auth gate — validate token (hash lookup + not-revoked + not-expired, on
// EVERY request — C-001/AS-022) → rate-limit (C-007/AS-024) → derive the request's workspace
// from the token (C-001) → per-tool scope check (C-009/AS-011) → dispatch. The route
// (src/routes/mcp.ts) is the thin transport that frames Request→here→Response, OUTSIDE the
// envelope (C-005/AS-023) and with the bearer redacted from logs (C-014).

import type { ApiTokenRepo, ResolvedToken } from "./token-repo";
import type { McpRateLimiter } from "./rate-limit";
import { type Scope } from "./token";

/** JSON-RPC 2.0 error codes used by the MCP transport. */
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;
// Implementation-defined (MCP/transport) range -32000..-32099.
export const MCP_UNAUTHORIZED = -32001;
export const MCP_FORBIDDEN_SCOPE = -32002;
export const MCP_RATE_LIMITED = -32003;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** The identity + scope context handed to a tool handler once auth passes. */
export interface ToolContext {
  userId: string;
  /** The request workspace, DERIVED from the token (C-001) — never from the path/params. */
  workspaceId: string;
  scopes: Scope[];
}

/** A tool: the scope it requires (C-009) + its handler. */
export interface ToolDef {
  /** The scope a caller must hold to invoke this tool; null = no scope (e.g. a ping). */
  requiredScope: Scope | null;
  handler: (params: Record<string, unknown>, ctx: ToolContext) => Promise<unknown> | unknown;
}

export interface McpServerDeps {
  tokens: ApiTokenRepo;
  rateLimiter: McpRateLimiter;
  /** The tool registry. S-001 ships a baseline `ping`; S-002..S-006 register the rest. */
  tools: Record<string, ToolDef>;
}

function ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function err(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/**
 * Result of an authenticated dispatch — the JSON-RPC response plus the resolved token (so the
 * transport can do the coalesced last_used_at bump after the response is framed).
 */
export interface DispatchResult {
  response: JsonRpcResponse;
  /** Set when the token validated (for last_used_at touch); null on an auth failure. */
  resolved: ResolvedToken | null;
}

/**
 * Run the full per-request pipeline for ONE JSON-RPC request. The bearer is re-validated here
 * EVERY call (C-001/AS-022) — there is no cached session. Order is auth → rate-limit → scope →
 * dispatch, so a revoked/wrong/missing token never reaches a tool (C-001).
 */
export async function handleJsonRpc(
  deps: McpServerDeps,
  bearer: string | null,
  request: JsonRpcRequest,
  now: Date = new Date(),
): Promise<DispatchResult> {
  const id = request?.id ?? null;

  // 1. Authenticate — validate the token on THIS request (AS-001/AS-002/AS-022).
  if (!bearer) {
    return { response: err(id, MCP_UNAUTHORIZED, "missing bearer token"), resolved: null };
  }
  const resolved = await deps.tokens.verify(bearer, now);
  if (!resolved) {
    // Wrong / revoked / expired → one clear, non-disclosing auth error (AS-002).
    return { response: err(id, MCP_UNAUTHORIZED, "invalid or revoked token"), resolved: null };
  }

  // 2. Per-token rate limit (C-007/AS-024) — counted against the resolved token id.
  if (!deps.rateLimiter.consume(resolved.id, now).allowed) {
    return {
      response: err(id, MCP_RATE_LIMITED, "rate limit exceeded for this token"),
      resolved,
    };
  }

  // 3. Resolve the tool.
  const tool = deps.tools[request.method];
  if (!tool) {
    return { response: err(id, JSONRPC_METHOD_NOT_FOUND, `unknown tool: ${request.method}`), resolved };
  }

  // 4. Scope gate (C-009/AS-011) — BEFORE the handler, so a write tool with a read-only token
  //    is rejected with no side effect (no doc created).
  if (tool.requiredScope && !resolved.scopes.includes(tool.requiredScope)) {
    return {
      response: err(
        id,
        MCP_FORBIDDEN_SCOPE,
        `token is missing the required scope '${tool.requiredScope}' for ${request.method}`,
      ),
      resolved,
    };
  }

  // 5. Dispatch — the request runs under the token-owner's identity, scoped to the token's
  //    workspace (C-001). Authorization is a per-RESOURCE gate INSIDE the tool (S-002+).
  const ctx: ToolContext = {
    userId: resolved.userId,
    workspaceId: resolved.workspaceId,
    scopes: resolved.scopes,
  };
  try {
    const result = await tool.handler(request.params ?? {}, ctx);
    return { response: ok(id, result), resolved };
  } catch (e) {
    // No stack/message leak beyond a generic transport error (mirrors the envelope's 500).
    return { response: err(id, JSONRPC_INTERNAL_ERROR, "internal error"), resolved };
  }
}

/**
 * S-001 baseline tool registry — a single `ping` that proves the authenticated transport
 * end-to-end (AS-001) and returns the caller's resolved identity + workspace. The actual
 * domain tools (create_document, pull_annotations, …) register in S-002..S-006.
 */
export function baselineTools(): Record<string, ToolDef> {
  return {
    ping: {
      requiredScope: null,
      handler: (_params, ctx) => ({
        ok: true,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        scopes: ctx.scopes,
      }),
    },
  };
}
