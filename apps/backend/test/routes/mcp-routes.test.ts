// mcp-roundtrip S-001 — in-process HTTP tests for the two route surfaces:
//   • POST /mcp           — the raw JSON-RPC agent transport (envelope-EXEMPT, C-005/AS-023).
//   • /api/me/tokens       — the enveloped Developer-settings PAT web surface (AS-020/021/025).
// HTTP GLUE only — driven via createApp + app.handle(Request), with a fake token repo
// for the web surface and the real pipeline + a fake repo for the transport.

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { ApiTokenRepo, ResolvedToken, TokenListItem } from "../../src/mcp/token-repo";
import { TokenCapError } from "../../src/mcp/token-repo";
import { baselineTools } from "../../src/mcp/server";
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

// ── POST /mcp transport ─────────────────────────────────────────────────────

function transportTokens(scopes: string[] = ["docs:read"]): ApiTokenRepo {
  return {
    async verify(plaintext: string): Promise<ResolvedToken | null> {
      if (plaintext !== "anch_pat_valid") return null;
      return { id: "t1", userId: "u1", workspaceId: "W", scopes: scopes as any, lastUsedAt: null };
    },
    async touchLastUsed() {},
  } as unknown as ApiTokenRepo;
}

function appWithTransport(allowedOrigins?: string[]) {
  return createApp({
    dbCheck: async () => {},
    mcp: { tokens: transportTokens(), tools: baselineTools(), allowedOrigins },
  });
}

describe("POST /mcp transport (C-005/AS-023)", () => {
  test("AS-023: an authenticated tool call returns RAW JSON-RPC, not the API envelope", async () => {
    const app = appWithTransport();
    const res = await app.handle(
      req("POST", "/mcp", {
        headers: { authorization: "Bearer anch_pat_valid" },
        body: { jsonrpc: "2.0", id: 7, method: "ping" },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    // Raw JSON-RPC shape — NOT { ok, data } / { ok:false, error } the envelope wraps.
    expect(json.jsonrpc).toBe("2.0");
    expect(json.id).toBe(7);
    expect(json.result).toEqual({ ok: true, userId: "u1", workspaceId: "W", scopes: ["docs:read"] });
    expect(json).not.toHaveProperty("ok");
    expect(json).not.toHaveProperty("data");
  });

  test("AS-002: a wrong token on /mcp gets a JSON-RPC auth error (still raw, not enveloped)", async () => {
    const app = appWithTransport();
    const res = await app.handle(
      req("POST", "/mcp", {
        headers: { authorization: "Bearer anch_pat_nope" },
        body: { jsonrpc: "2.0", id: 1, method: "ping" },
      }),
    );
    const json = (await res.json()) as any;
    expect(json.jsonrpc).toBe("2.0");
    expect(json.error).toBeDefined();
    expect(json).not.toHaveProperty("ok");
  });

  test("C-005: with an allowlist, a request with an ALLOWED Origin passes", async () => {
    const app = appWithTransport(["https://anchord.example"]);
    const res = await app.handle(
      req("POST", "/mcp", {
        headers: { authorization: "Bearer anch_pat_valid", origin: "https://anchord.example" },
        body: { jsonrpc: "2.0", id: 1, method: "ping" },
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).error).toBeUndefined();
  });

  test("C-005: with an allowlist, an ABSENT Origin is rejected (DNS-rebinding guard)", async () => {
    const app = appWithTransport(["https://anchord.example"]);
    const res = await app.handle(
      req("POST", "/mcp", {
        headers: { authorization: "Bearer anch_pat_valid" }, // no Origin header
        body: { jsonrpc: "2.0", id: 1, method: "ping" },
      }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.message).toContain("origin");
  });

  test("C-005: with an allowlist, a literal `null` Origin is rejected (DNS-rebinding guard)", async () => {
    const app = appWithTransport(["https://anchord.example"]);
    const res = await app.handle(
      req("POST", "/mcp", {
        headers: { authorization: "Bearer anch_pat_valid", origin: "null" },
        body: { jsonrpc: "2.0", id: 1, method: "ping" },
      }),
    );
    expect(res.status).toBe(403);
  });

  test("C-005: a foreign Origin (not on the allowlist) is rejected", async () => {
    const app = appWithTransport(["https://anchord.example"]);
    const res = await app.handle(
      req("POST", "/mcp", {
        headers: { authorization: "Bearer anch_pat_valid", origin: "https://evil.example" },
        body: { jsonrpc: "2.0", id: 1, method: "ping" },
      }),
    );
    expect(res.status).toBe(403);
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
