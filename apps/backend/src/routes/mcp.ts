// mcp-roundtrip S-001 — the route mounts.
//
// TWO surfaces, deliberately on opposite sides of the API envelope:
//
//  1. `/mcp` (the agent transport) — mounted on a BARE Elysia() with NO apiEnvelope, so its
//     responses are raw JSON-RPC, not wrapped (C-005/AS-023). Origin is validated against the
//     allowlist (configured base-URL origin); an absent/`null` Origin is rejected (DNS-rebind,
//     C-005). The bearer is redacted from any log line (C-014). Token re-validated on EVERY
//     request inside handleJsonRpc (C-001/AS-022).
//
//  2. `/api/me/tokens` (the Developer-settings web surface) — ENVELOPED + session-gated. The
//     user creates (shown-once plaintext), lists (metadata + prefix only — AS-020), and revokes
//     (AS-021) their PATs here. This is the web path, NOT the MCP transport.

import { Elysia } from "elysia";
import { z } from "zod";
import { apiEnvelope } from "../http/envelope";
import { requireSession, type SessionResolver } from "../http/auth-gate";
import { withValidation } from "../http/validate";
import { ValidationError, ConflictError, NotFoundError } from "../http/errors";
import {
  handleJsonRpc,
  baselineTools,
  type JsonRpcRequest,
  type McpServerDeps,
  type ToolDef,
  JSONRPC_PARSE_ERROR,
  JSONRPC_INVALID_REQUEST,
} from "../mcp/server";
import { createApiTokenRepo, TokenCapError, type ApiTokenRepo } from "../mcp/token-repo";
import { TokenScopeError, ALL_SCOPES } from "../mcp/token";
import { McpRateLimiter } from "../mcp/rate-limit";
import { safeMcpLogFields } from "../mcp/log";
import type { DB } from "../db/client";

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
  if (!origin || origin === "null") return false; // DNS-rebinding guard
  return allowed.includes(origin);
}

export function mcpTransportRoutes(deps: McpTransportDeps) {
  const rateLimiter = deps.rateLimiter ?? new McpRateLimiter();
  const tools = deps.tools ?? baselineTools();
  const allowed = deps.allowedOrigins ?? [];
  const server: McpServerDeps = { tokens: deps.tokens, rateLimiter, tools };

  // BARE Elysia — NO apiEnvelope, so nothing here is wrapped (AS-023).
  return new Elysia().post("/mcp", async ({ request }) => {
    const authHeader = request.headers.get("authorization");
    // C-014: every log on this exempt path redacts the bearer first.
    const log = safeMcpLogFields("POST", "/mcp", authHeader);

    // C-005: Origin allowlist + DNS-rebinding guard (absent/null Origin rejected).
    if (!originAllowed(request.headers.get("origin"), allowed)) {
      console.warn("[mcp] rejected request: origin not allowed", log);
      return rawJson(
        { jsonrpc: "2.0", id: null, error: { code: JSONRPC_INVALID_REQUEST, message: "origin not allowed" } },
        403,
      );
    }

    // Parse the JSON-RPC body.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return rawJson(
        { jsonrpc: "2.0", id: null, error: { code: JSONRPC_PARSE_ERROR, message: "parse error" } },
        200,
      );
    }
    if (
      typeof body !== "object" ||
      body === null ||
      (body as { jsonrpc?: unknown }).jsonrpc !== "2.0" ||
      typeof (body as { method?: unknown }).method !== "string"
    ) {
      return rawJson(
        { jsonrpc: "2.0", id: null, error: { code: JSONRPC_INVALID_REQUEST, message: "invalid request" } },
        200,
      );
    }

    const rpc = body as JsonRpcRequest;
    const bearer = parseBearerFromHeader(authHeader);
    const { response, resolved } = await handleJsonRpc(server, bearer, rpc);

    // Coalesced last_used_at bump AFTER dispatch (C-008) — best-effort, never blocks/leaks.
    if (resolved) {
      void deps.tokens.touchLastUsed(resolved.id, resolved.lastUsedAt).catch(() => {});
    }
    return rawJson(response, 200);
  });
}

/** Local bearer parse (kept here to avoid importing token.ts into the transport path twice). */
function parseBearerFromHeader(header: string | null): string | null {
  if (typeof header !== "string") return null;
  const m = header.match(/^Bearer[ \t]+(.+)$/i);
  if (!m) return null;
  const t = m[1]!.trim();
  return t.length > 0 ? t : null;
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
