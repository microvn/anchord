// mcp-roundtrip S-001 — in-process HTTP tests for the two route surfaces:
//   • POST /mcp           — the raw JSON-RPC agent transport (envelope-EXEMPT, C-005/AS-023).
//   • /api/me/tokens       — the enveloped Developer-settings PAT web surface (AS-020/021/025).
// HTTP GLUE only — driven via createApp + app.handle(Request), with a fake token repo
// for the web surface and the real pipeline + a fake repo for the transport.

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { ApiTokenRepo, ResolvedToken, TokenListItem } from "../../src/mcp/token-repo";
import { TokenCapError } from "../../src/mcp/token-repo";
import { baselineTools, type ToolDef } from "../../src/mcp/server";
import { McpRateLimiter } from "../../src/mcp/rate-limit";
import { TOKEN_PREFIX } from "../../src/mcp/token";
import type { SessionResolver } from "../../src/http/auth-gate";

const asUser = (userId: string): SessionResolver => async () => ({ userId });
const noSession: SessionResolver = async () => null;

function req(method: string, path: string, opts?: { body?: unknown; headers?: Record<string, string> }) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", ...(opts?.headers ?? {}) },
    body: opts?.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

// ── POST /mcp transport — REAL MCP protocol over @modelcontextprotocol/sdk ───
//
// These drive the SDK Streamable HTTP transport through createApp + app.handle: the full
// MCP handshake (initialize → tools/list → tools/call), NOT the old method=tool-name
// dispatch. The old-protocol pipeline tests live in src/mcp/server.test.ts (handleJsonRpc).

// The Accept header the MCP Streamable HTTP transport requires on every request.
const MCP_ACCEPT = "application/json, text/event-stream";

const PROTOCOL_VERSION = "2025-06-18";

function transportTokens(scopes: string[] = ["docs:read"]): ApiTokenRepo {
  let touched = 0;
  return {
    async verify(plaintext: string): Promise<ResolvedToken | null> {
      if (plaintext !== "anch_pat_valid") return null;
      return { id: "t1", userId: "u1", workspaceId: "W", scopes: scopes as any, lastUsedAt: null };
    },
    async touchLastUsed() {
      touched += 1;
    },
    get _touched() {
      return touched;
    },
  } as unknown as ApiTokenRepo;
}

// The 12 anchord_* tools we expect tools/list to advertise — registered as inert ToolDefs
// (the scope gate + identity threading are proven against the real handlers elsewhere).
function anchordToolDefs(): Record<string, ToolDef> {
  const names = [
    "anchord_create_document",
    "anchord_update_document",
    "anchord_list_documents",
    "anchord_read_document",
    "anchord_search_documents",
    "anchord_pull_annotations",
    "anchord_list_comments",
    "anchord_reply_comment",
    "anchord_resolve_comment",
    "anchord_list_projects",
    "anchord_read_project",
    "anchord_create_project",
  ];
  const writeScopes: Record<string, any> = {
    anchord_create_document: "docs:write",
    anchord_update_document: "docs:write",
  };
  const tools: Record<string, ToolDef> = {};
  for (const n of names) {
    tools[n] = {
      requiredScope: writeScopes[n] ?? null,
      handler: (_p, ctx) => ({ tool: n, workspaceId: ctx.workspaceId }),
    };
  }
  return tools;
}

function appWithTransport(opts?: {
  allowedOrigins?: string[];
  tokens?: ApiTokenRepo;
  tools?: Record<string, ToolDef>;
  rateLimiter?: McpRateLimiter;
}) {
  return createApp({
    dbCheck: async () => {},
    mcp: {
      tokens: opts?.tokens ?? transportTokens(),
      tools: opts?.tools ?? { ...baselineTools(), ...anchordToolDefs() },
      allowedOrigins: opts?.allowedOrigins,
      rateLimiter: opts?.rateLimiter,
    },
  });
}

function mcpReq(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: MCP_ACCEPT, ...headers },
    body: JSON.stringify(body),
  });
}

const initRpc = (id: number | string = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "0" } },
});

/** Parse a Streamable-HTTP response body — JSON (enableJsonResponse) or an SSE `data:` frame. */
async function parseMcp(res: Response): Promise<any> {
  const text = await res.text();
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) {
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    return line ? JSON.parse(line.slice(5).trim()) : undefined;
  }
  return text ? JSON.parse(text) : undefined;
}

describe("POST /mcp transport — MCP protocol (C-005/AS-023)", () => {
  test("initialize returns serverInfo + capabilities (handshake works)", async () => {
    const app = appWithTransport();
    const res = await app.handle(mcpReq(initRpc(1), { authorization: "Bearer anch_pat_valid" }));
    expect(res.status).toBe(200);
    const json = await parseMcp(res);
    expect(json.jsonrpc).toBe("2.0");
    expect(json.id).toBe(1);
    expect(json.result.serverInfo.name).toBe("anchord");
    expect(json.result.capabilities).toBeDefined();
    // Raw JSON-RPC, never the API envelope (AS-023).
    expect(json).not.toHaveProperty("ok");
    expect(json).not.toHaveProperty("data");
  });

  test("tools/list returns the 12 anchord_* tools with an inputSchema", async () => {
    const app = appWithTransport();
    const res = await app.handle(
      mcpReq({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { authorization: "Bearer anch_pat_valid" }),
    );
    const json = await parseMcp(res);
    const names: string[] = json.result.tools.map((t: any) => t.name);
    for (const n of [
      "anchord_create_document",
      "anchord_update_document",
      "anchord_list_documents",
      "anchord_read_document",
      "anchord_search_documents",
      "anchord_pull_annotations",
      "anchord_list_comments",
      "anchord_reply_comment",
      "anchord_resolve_comment",
      "anchord_list_projects",
      "anchord_read_project",
      "anchord_create_project",
    ]) {
      expect(names).toContain(n);
    }
    const createTool = json.result.tools.find((t: any) => t.name === "anchord_create_document");
    expect(createTool.inputSchema).toBeDefined();
    expect(createTool.inputSchema.properties).toHaveProperty("content");
  });

  test("AS-001: a valid docs:* token → tools/call executes under the owner identity, scoped to the token workspace", async () => {
    const app = appWithTransport();
    const res = await app.handle(
      mcpReq(
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "anchord_list_documents", arguments: {} } },
        { authorization: "Bearer anch_pat_valid" },
      ),
    );
    const json = await parseMcp(res);
    expect(json.error).toBeUndefined();
    expect(json.result.isError).toBeFalsy();
    // The text content block carries the JSON-encoded handler result, run in the token's workspace.
    const payload = JSON.parse(json.result.content[0].text);
    expect(payload).toEqual({ tool: "anchord_list_documents", workspaceId: "W" });
  });

  test("AS-023: a tool-call response is RAW JSON-RPC, not the API envelope", async () => {
    const app = appWithTransport();
    const res = await app.handle(
      mcpReq(
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "anchord_list_documents", arguments: {} } },
        { authorization: "Bearer anch_pat_valid" },
      ),
    );
    const json = await parseMcp(res);
    expect(json.jsonrpc).toBe("2.0");
    expect(json).not.toHaveProperty("ok");
    expect(json).not.toHaveProperty("data");
  });

  test("AS-002: a missing bearer is rejected with a raw JSON-RPC auth error, no SDK invoked", async () => {
    const app = appWithTransport();
    const res = await app.handle(mcpReq(initRpc(1))); // no Authorization
    const json = await parseMcp(res);
    expect(json.jsonrpc).toBe("2.0");
    expect(json.error.code).toBe(-32001);
    expect(json).not.toHaveProperty("ok");
  });

  test("AS-002: a wrong/unknown token is rejected with the same non-disclosing auth error", async () => {
    const app = appWithTransport();
    const res = await app.handle(mcpReq(initRpc(1), { authorization: "Bearer anch_pat_nope" }));
    const json = await parseMcp(res);
    expect(json.error.code).toBe(-32001);
    expect(json.error.message).toBe("invalid or revoked token");
  });

  test("AS-011/C-009: a read-only token calling anchord_create_document is rejected on scope — NO doc created", async () => {
    const created: string[] = [];
    const tools = {
      anchord_create_document: {
        requiredScope: "docs:write" as const,
        handler: () => {
          created.push("doc");
          return { docId: "d1" };
        },
      },
    };
    const app = appWithTransport({ tokens: transportTokens(["docs:read"]), tools });
    const res = await app.handle(
      mcpReq(
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "anchord_create_document", arguments: { content: "x", format: "html" } },
        },
        { authorization: "Bearer anch_pat_valid" },
      ),
    );
    const json = await parseMcp(res);
    // Surfaced as an isError tool result mentioning the missing scope; the handler never ran.
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("docs:write");
    expect(created).toEqual([]);
  });

  test("AS-022: revoking mid-session rejects the NEXT request (re-validated every request)", async () => {
    let revoked = false;
    const tokens = {
      async verify(plaintext: string): Promise<ResolvedToken | null> {
        if (plaintext !== "anch_pat_valid" || revoked) return null;
        return { id: "t1", userId: "u1", workspaceId: "W", scopes: ["docs:read"] as any, lastUsedAt: null };
      },
      async touchLastUsed() {},
    } as unknown as ApiTokenRepo;
    const app = appWithTransport({ tokens });
    expect((await parseMcp(await app.handle(mcpReq(initRpc(1), { authorization: "Bearer anch_pat_valid" })))).error).toBeUndefined();
    revoked = true;
    const after = await parseMcp(await app.handle(mcpReq(initRpc(2), { authorization: "Bearer anch_pat_valid" })));
    expect(after.error.code).toBe(-32001);
  });

  test("AS-024: a token over its rate limit is throttled with a raw JSON-RPC rate-limit error", async () => {
    const app = appWithTransport({ rateLimiter: new McpRateLimiter(1, 60) }); // budget 1
    expect((await parseMcp(await app.handle(mcpReq(initRpc(1), { authorization: "Bearer anch_pat_valid" })))).error).toBeUndefined();
    const over = await parseMcp(await app.handle(mcpReq(initRpc(2), { authorization: "Bearer anch_pat_valid" })));
    expect(over.error.code).toBe(-32003);
  });

  test("C-005: with an allowlist, an ALLOWED Origin passes", async () => {
    const app = appWithTransport({ allowedOrigins: ["https://anchord.example"] });
    const ok = await app.handle(
      mcpReq(initRpc(1), { authorization: "Bearer anch_pat_valid", origin: "https://anchord.example" }),
    );
    expect(ok.status).toBe(200);
    expect((await parseMcp(ok)).error).toBeUndefined();
  });

  test("AS-030: a request with NO Origin header is allowed (CLI MCP clients send none)", async () => {
    const app = appWithTransport({ allowedOrigins: ["https://anchord.example"] });
    // No `origin` key → absent header, exactly what claude mcp / Cursor / Codex send.
    const res = await app.handle(mcpReq(initRpc(1), { authorization: "Bearer anch_pat_valid" }));
    expect(res.status).toBe(200);
    expect((await parseMcp(res)).error).toBeUndefined();
  });

  test("AS-031: a PRESENT but non-allowlisted Origin (incl. literal `null`) is rejected (403)", async () => {
    const app = appWithTransport({ allowedOrigins: ["https://anchord.example"] });
    for (const origin of ["null", "https://evil.example"]) {
      const res = await app.handle(
        mcpReq(initRpc(1), { authorization: "Bearer anch_pat_valid", origin }),
      );
      expect(res.status).toBe(403);
    }
  });
});

// ── /api/me/tokens web surface ──────────────────────────────────────────────

// A fake repo backing the Developer-settings PAT surface. Records what `create`
// returns so a test can assert the plaintext is shown once and the hash never leaks.
function webTokens(seed: TokenListItem[] = []) {
  const items = [...seed];
  let n = seed.length;
  let capReached = false;
  const repo = {
    async listActive(): Promise<TokenListItem[]> {
      return items;
    },
    async create(input: { userId: string; workspaceId: string; name: string; scopes: readonly unknown[] }) {
      if (capReached) throw new TokenCapError("active token cap reached (10)");
      const item: TokenListItem = {
        id: `t_${++n}`,
        name: input.name,
        workspaceId: input.workspaceId,
        scopes: input.scopes as any,
        lastUsedAt: null,
        expiresAt: null,
        prefix: TOKEN_PREFIX,
      };
      items.push(item);
      return { token: `${TOKEN_PREFIX}PLAINTEXTSHOWNONCE`, item };
    },
    async revoke(tokenId: string) {
      const i = items.findIndex((x) => x.id === tokenId);
      if (i < 0) return false;
      items.splice(i, 1);
      return true;
    },
    _setCapReached() {
      capReached = true;
    },
  } as unknown as ApiTokenRepo & { _setCapReached: () => void };
  return repo;
}

function appWithWeb(resolveSession: SessionResolver, repo: ApiTokenRepo) {
  return createApp({
    dbCheck: async () => {},
    mcpTokens: {
      tokens: repo,
      resolveSession,
      isWorkspaceMember: async () => true,
    },
  });
}

const TWO: TokenListItem[] = [
  { id: "t1", name: "CI bot", workspaceId: "W", scopes: ["docs:read"] as any, lastUsedAt: new Date("2026-06-18T00:00:00Z"), expiresAt: null, prefix: TOKEN_PREFIX },
  { id: "t2", name: "Laptop", workspaceId: "W", scopes: ["docs:read", "docs:write"] as any, lastUsedAt: null, expiresAt: new Date("2026-12-01T00:00:00Z"), prefix: TOKEN_PREFIX },
];

describe("/api/me/tokens web surface (AS-020/021/025)", () => {
  test("AS-020.T1: listing tokens shows name/workspace/scopes/last-used/expiry + the anch_pat_ prefix", async () => {
    const app = appWithWeb(asUser("u1"), webTokens(TWO));
    const res = await app.handle(req("GET", "/api/me/tokens"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.tokens).toHaveLength(2);
    const row = json.data.tokens[0];
    expect(row).toMatchObject({ name: "CI bot", workspaceId: "W", scopes: ["docs:read"], prefix: "anch_pat_" });
    expect(row).toHaveProperty("lastUsedAt");
    expect(json.data.tokens[1]).toHaveProperty("expiresAt");
  });

  test("AS-020.T2: the listing NEVER returns the full token or its stored hash", async () => {
    const app = appWithWeb(asUser("u1"), webTokens(TWO));
    const res = await app.handle(req("GET", "/api/me/tokens"));
    const raw = await res.text();
    for (const row of (JSON.parse(raw) as any).data.tokens) {
      expect(row).not.toHaveProperty("token");
      expect(row).not.toHaveProperty("tokenHash");
      // The only secret fragment present is the bare prefix, never a full token body.
      expect(row.prefix).toBe("anch_pat_");
    }
    expect(raw).not.toContain("PLAINTEXT");
  });

  test("AS-020: creating a token returns the plaintext exactly ONCE (in the create response only)", async () => {
    const app = appWithWeb(asUser("u1"), webTokens());
    const res = await app.handle(
      req("POST", "/api/me/tokens", { body: { name: "bot", workspaceId: "W", scopes: ["docs:read"] } }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.data.token).toBe("anch_pat_PLAINTEXTSHOWNONCE"); // shown once here
    expect(json.data.prefix).toBe("anch_pat_");
    // The subsequent list does NOT carry the plaintext.
    const list = await (await app.handle(req("GET", "/api/me/tokens"))).text();
    expect(list).not.toContain("PLAINTEXTSHOWNONCE");
  });

  test("AS-021: revoking a token removes it from the active list", async () => {
    const repo = webTokens(TWO);
    const app = appWithWeb(asUser("u1"), repo);
    const del = await app.handle(req("DELETE", "/api/me/tokens/t1"));
    expect(del.status).toBe(200);
    const list = (await (await app.handle(req("GET", "/api/me/tokens"))).json()) as any;
    expect(list.data.tokens.map((t: any) => t.id)).toEqual(["t2"]);
  });

  test("AS-021: revoking a nonexistent / not-owned token 404s", async () => {
    const app = appWithWeb(asUser("u1"), webTokens(TWO));
    const res = await app.handle(req("DELETE", "/api/me/tokens/t_missing"));
    expect(res.status).toBe(404);
  });

  test("AS-025: creating a token at the per-user cap is refused (409 CONFLICT)", async () => {
    const repo = webTokens(TWO);
    repo._setCapReached();
    const app = appWithWeb(asUser("u1"), repo as unknown as ApiTokenRepo);
    const res = await app.handle(
      req("POST", "/api/me/tokens", { body: { name: "one too many", workspaceId: "W", scopes: ["docs:read"] } }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.code).toBe("CONFLICT");
  });

  test("C-001: a token bound to a workspace the caller is NOT a member of is rejected", async () => {
    const app = createApp({
      dbCheck: async () => {},
      mcpTokens: { tokens: webTokens(), resolveSession: asUser("u1"), isWorkspaceMember: async () => false },
    });
    const res = await app.handle(
      req("POST", "/api/me/tokens", { body: { name: "x", workspaceId: "W_other", scopes: ["docs:read"] } }),
    );
    expect(res.status).toBe(400);
  });

  test("no session → the token web surface is 401", async () => {
    const app = appWithWeb(noSession, webTokens(TWO));
    expect((await app.handle(req("GET", "/api/me/tokens"))).status).toBe(401);
  });
});
