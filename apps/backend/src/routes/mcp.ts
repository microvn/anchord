// mcp-roundtrip S-001 — the route mounts.
//
// TWO surfaces, deliberately on opposite sides of the API envelope:
//
//  1. `/mcp` (the agent transport) — a REAL MCP server over @modelcontextprotocol/sdk's
//     web-standard Streamable HTTP transport, so the full handshake works (initialize →
//     tools/list → tools/call) and any compliant MCP client (claude mcp, Cursor) connects.
//     Mounted on a BARE Elysia() with NO apiEnvelope, so its responses are raw JSON-RPC, not
//     wrapped (C-005/AS-023). The per-request pipeline (this route, BEFORE the SDK): origin
//     allowlist + DNS-rebind guard (C-005) → bearer re-validate every request (C-001/AS-022)
//     → per-token rate limit (C-007/AS-024) → build a fresh McpServer bound to the resolved
//     identity + connect a single-use transport → handleRequest → coalesced last_used bump
//     (C-008). The bearer is redacted from any log line (C-014). The per-tool scope gate
//     (C-009/AS-011) lives in mcp/sdk-server.ts `buildMcpServer`.
//
//  2. `/api/me/tokens` (the Developer-settings web surface) — ENVELOPED + session-gated. The
//     user creates (shown-once plaintext), lists (metadata + prefix only — AS-020), and revokes
//     (AS-021) their PATs here. This is the web path, NOT the MCP transport.

import { Elysia } from "elysia";
import { z } from "zod";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { apiEnvelope } from "../http/envelope";
import { requireSession, type SessionResolver } from "../http/auth-gate";
import { withValidation } from "../http/validate";
import { ValidationError, ConflictError, NotFoundError } from "../http/errors";
import { baselineTools, type ToolDef } from "../mcp/server";
import { buildMcpServer } from "../mcp/sdk-server";
import { createApiTokenRepo, TokenCapError, type ApiTokenRepo } from "../mcp/token-repo";
import { TokenScopeError, ALL_SCOPES, parseBearer } from "../mcp/token";
import { McpRateLimiter } from "../mcp/rate-limit";
import { safeMcpLogFields } from "../mcp/log";
import type { DB } from "../db/client";

// JSON-RPC error codes for the raw (pre-SDK) auth/origin/rate-limit refusals returned from
// the transport route WITHOUT invoking the SDK (so a bad token never reaches a tool).
const JSONRPC_INVALID_REQUEST = -32600;
const MCP_UNAUTHORIZED = -32001;
const MCP_RATE_LIMITED = -32003;

// ── /mcp transport (raw JSON-RPC, envelope-exempt) ──────────────────────────

export interface McpTransportDeps {
  tokens: ApiTokenRepo;
  rateLimiter?: McpRateLimiter;
  /** Tool registry (defaults to the S-001 baseline `ping`). S-002..S-006 extend this. */
  tools?: Record<string, ToolDef>;
  /**
   * The allowed Origin (C-005) — the configured base-URL origin. A request whose `Origin`
   * header is absent, `null`, or not in this set is rejected (DNS-rebinding). When empty,
   * Origin checking is OFF (test/embedded callers that send no browser Origin).
   */
  allowedOrigins?: string[];
}

const RAW_JSON = { "content-type": "application/json" } as const;

function rawJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: RAW_JSON });
}

/**
 * Validate the Origin header against the allowlist (C-005). Returns true when allowed. An
 * absent/`null` Origin is rejected (DNS-rebinding) UNLESS no allowlist is configured.
 */
export function originAllowed(origin: string | null, allowed: string[]): boolean {
  if (allowed.length === 0) return true; // no allowlist configured → checking off
  // C-005/AS-030: an ABSENT Origin header is ALLOWED — non-browser CLI MCP clients (claude mcp,
  // Cursor, Codex) send none, and DNS-rebinding only threatens browsers (which always send one).
  if (origin === null) return true;
  // C-005/AS-031: a PRESENT Origin must be in the allowlist; a literal `null` Origin is treated
  // as present-and-disallowed (the browser DNS-rebinding guard).
  if (origin === "null") return false;
  return allowed.includes(origin);
}

export function mcpTransportRoutes(deps: McpTransportDeps) {
  const rateLimiter = deps.rateLimiter ?? new McpRateLimiter();
  const tools = deps.tools ?? baselineTools();
  const allowed = deps.allowedOrigins ?? [];

  // BARE Elysia — NO apiEnvelope, so nothing here is wrapped (AS-023). `.all` covers MCP's
  // POST (tool calls) and a GET probe (SSE, which we disable — enableJsonResponse below).
  return new Elysia().all("/mcp", async ({ request, body: parsedBody }) => {
    const now = new Date();
    const authHeader = request.headers.get("authorization");
    // C-014: every log on this exempt path redacts the bearer first.
    const log = safeMcpLogFields(request.method, "/mcp", authHeader);

    // C-005: Origin allowlist + DNS-rebinding guard (absent/null Origin rejected). Runs
    // FIRST, before any auth/SDK work.
    if (!originAllowed(request.headers.get("origin"), allowed)) {
      console.warn("[mcp] rejected request: origin not allowed", log);
      return rawJson(
        { jsonrpc: "2.0", id: null, error: { code: JSONRPC_INVALID_REQUEST, message: "origin not allowed" } },
        403,
      );
    }

    // C-001/AS-002/AS-022: re-validate the bearer on THIS request (no session cache). A
    // missing/invalid/revoked/expired token is refused HERE — with a raw JSON-RPC auth error
    // — WITHOUT ever constructing the SDK server, so a bad token never reaches a tool.
    const bearer = parseBearer(authHeader);
    if (!bearer) {
      return rawJson(
        { jsonrpc: "2.0", id: null, error: { code: MCP_UNAUTHORIZED, message: "missing bearer token" } },
        200,
      );
    }
    const resolved = await deps.tokens.verify(bearer, now);
    if (!resolved) {
      return rawJson(
        { jsonrpc: "2.0", id: null, error: { code: MCP_UNAUTHORIZED, message: "invalid or revoked token" } },
        200,
      );
    }

    // C-007/AS-024: per-token rate limit, counted against the resolved token id, AFTER auth
    // (an unauthenticated burst never consumes a token's budget).
    if (!rateLimiter.consume(resolved.id, now).allowed) {
      return rawJson(
        { jsonrpc: "2.0", id: null, error: { code: MCP_RATE_LIMITED, message: "rate limit exceeded for this token" } },
        200,
      );
    }

    // Build a fresh McpServer + transport PER request — the stateless Streamable HTTP
    // transport is single-use. enableJsonResponse:true → plain application/json JSON-RPC
    // (no SSE; v0 tools never push server-initiated messages). The server is bound to the
    // resolved identity, so every tool runs under the token-owner's identity, scoped to the
    // token's workspace (C-001). The per-tool scope gate (C-009/AS-011) lives in buildMcpServer.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = buildMcpServer(
      { userId: resolved.userId, workspaceId: resolved.workspaceId, scopes: resolved.scopes },
      tools,
    );
    await server.connect(transport);

    // Elysia already drained the body stream, so hand the SDK the parsed body via
    // `parsedBody` (re-reading the Request under Bun.serve would throw). The body arrives as
    // a parsed object under Bun.serve; tolerate a string (test harness) by parsing it.
    let body: unknown = parsedBody;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = undefined;
      }
    }
    const response = await transport.handleRequest(request, { parsedBody: body });

    // C-008: coalesced last_used_at bump AFTER the request resolves — best-effort, never
    // blocks the response or leaks an unhandled rejection.
    void deps.tokens.touchLastUsed(resolved.id, resolved.lastUsedAt).catch(() => {});
    return response;
  });
}

// ── /api/me/tokens — the Developer-settings web surface (enveloped) ─────────

const createTokenSchema = z.object({
  name: z.string().min(1),
  workspaceId: z.string().min(1),
  scopes: z.array(z.string().min(1)).min(1),
  // ISO-8601 string or omitted (never-expires). Parsed to a Date below.
  expiresAt: z.string().datetime().optional(),
});

export interface McpTokenRoutesDeps {
  db?: DB;
  tokens?: ApiTokenRepo;
  secret?: string;
  resolveSession: SessionResolver;
  /** Asserts the caller is a member of the workspace the token will be bound to (C-001). */
  isWorkspaceMember: (workspaceId: string, userId: string) => Promise<boolean>;
}

export function mcpTokenRoutes(deps: McpTokenRoutesDeps) {
  const tokens: ApiTokenRepo =
    deps.tokens ??
    (() => {
      if (!deps.db || !deps.secret) {
        throw new Error("mcpTokenRoutes requires either `tokens` or (`db` + `secret`)");
      }
      return createApiTokenRepo(deps.db, deps.secret);
    })();

  return apiEnvelope(new Elysia())
    .use(requireSession({ resolveSession: deps.resolveSession }))
    // GET /api/me/tokens — list the caller's active tokens (metadata + prefix only, AS-020).
    .get("/api/me/tokens", async ({ actor }) => {
      const items = await tokens.listActive(actor.userId);
      return { tokens: items };
    })
    // POST /api/me/tokens — create a PAT; the plaintext is shown ONCE in this response.
    // withValidation is `as: "scoped"`, so it MUST be isolated in its own .group — chaining
    // it on the parent would leak the create-schema resolve onto the DELETE below (an empty
    // body → a spurious 400). Same isolation pattern as docs/annotations/sharing routes.
    .group("", (g) =>
      g.use(withValidation(createTokenSchema)).post("/api/me/tokens", async ({ validBody, actor, set }) => {
        const { name, workspaceId, scopes, expiresAt } = validBody as z.infer<typeof createTokenSchema>;
        // The token must be bound to a workspace the caller belongs to (C-001).
        if (!(await deps.isWorkspaceMember(workspaceId, actor.userId))) {
          throw new ValidationError("you are not a member of that workspace");
        }
        try {
          const { token, item } = await tokens.create({
            userId: actor.userId,
            workspaceId,
            name,
            scopes,
            expiresAt: expiresAt ? new Date(expiresAt) : null,
          });
          set.status = 201;
          // `token` is the ONLY time the plaintext is returned (C-008/AS-020).
          return { token, ...item };
        } catch (e) {
          if (e instanceof TokenScopeError) throw new ValidationError(e.message);
          if (e instanceof TokenCapError) throw new ConflictError(e.message);
          throw e;
        }
      }),
    )
    // DELETE /api/me/tokens/:id — revoke (AS-021). 404 when not found / not owned.
    .delete("/api/me/tokens/:id", async ({ params, actor }) => {
      const revoked = await tokens.revoke(params.id, actor.userId);
      if (!revoked) {
        throw new NotFoundError("token not found");
      }
      return { revoked: true };
    });
}

/** The 6 scopes + presets, exposed for the FE token modal (READ-ONLY / PUBLISH / FULL MCP). */
export const TOKEN_SCOPE_PRESETS = {
  "READ-ONLY": ["docs:read", "annotations:read", "projects:read"],
  PUBLISH: ["docs:read", "docs:write", "projects:read", "projects:write"],
  "FULL MCP": [...ALL_SCOPES],
} as const;
