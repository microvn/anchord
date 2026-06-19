// mcp-roundtrip S-001 — the per-request MCP pipeline (C-001/C-009).
// Drives handleJsonRpc with a fake token repo + a real rate limiter. Proves the
// gate order auth → rate-limit → scope → dispatch and that a tool runs under the
// token-owner's identity, scoped to the token's workspace.

import { describe, expect, test } from "bun:test";
import {
  baselineTools,
  handleJsonRpc,
  MCP_FORBIDDEN_SCOPE,
  MCP_RATE_LIMITED,
  MCP_UNAUTHORIZED,
  type JsonRpcRequest,
  type McpServerDeps,
  type ToolDef,
} from "./server";
import { McpRateLimiter } from "./rate-limit";
import type { ApiTokenRepo, ResolvedToken } from "./token-repo";
import type { Scope } from "./token";

// A fake token repo: a fixed table of plaintext → resolved identity. `verify`
// mirrors the real revoke/expiry semantics by checking a mutable `revoked` set.
function fakeTokens(opts: {
  valid: Record<string, { userId: string; workspaceId: string; scopes: Scope[]; id: string }>;
  revoked?: Set<string>;
}): ApiTokenRepo {
  const revoked = opts.revoked ?? new Set<string>();
  let touched = 0;
  const repo = {
    async verify(plaintext: string): Promise<ResolvedToken | null> {
      const t = opts.valid[plaintext];
      if (!t) return null;
      if (revoked.has(t.id)) return null; // re-validated every call (AS-022)
      return { id: t.id, userId: t.userId, workspaceId: t.workspaceId, scopes: t.scopes, lastUsedAt: null };
    },
    async touchLastUsed() {
      touched += 1;
    },
    get _touched() {
      return touched;
    },
  } as unknown as ApiTokenRepo;
  return repo;
}

const rpc = (method: string, params?: Record<string, unknown>, id: string | number = 1): JsonRpcRequest => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params ? { params } : {}),
});

// A write tool standing in for S-002's create_document: it records side effects so a
// scope-rejected call can be proven to have NO effect (AS-011).
function depsWith(tokens: ApiTokenRepo, sideEffects: string[], limiter = new McpRateLimiter()): McpServerDeps {
  const tools: Record<string, ToolDef> = {
    ...baselineTools(),
    create_document: {
      requiredScope: "docs:write",
      handler: (_p, ctx) => {
        sideEffects.push(`created-in:${ctx.workspaceId}`);
        return { docId: "d_1" };
      },
    },
  };
  return { tokens, rateLimiter: limiter, tools };
}

describe("MCP request pipeline (C-001)", () => {
  test("AS-001: a valid PAT calls a tool → executes under the owner's identity, scoped to W", async () => {
    const tokens = fakeTokens({
      valid: { "anch_pat_good": { id: "t1", userId: "u_owner", workspaceId: "W", scopes: ["docs:read", "docs:write"] } as any },
    });
    const deps = depsWith(tokens, []);
    const { response, resolved } = await handleJsonRpc(deps, "anch_pat_good", rpc("ping"));
    expect(response.error).toBeUndefined();
    // The tool ran under the token-owner's identity, scoped to the token's workspace W.
    expect(response.result).toEqual({ ok: true, userId: "u_owner", workspaceId: "W", scopes: ["docs:read", "docs:write"] });
    expect(resolved?.userId).toBe("u_owner");
    expect(resolved?.workspaceId).toBe("W");
  });

  test("AS-002: a missing bearer is rejected with a clear auth error, no dispatch", async () => {
    const deps = depsWith(fakeTokens({ valid: {} }), []);
    const { response, resolved } = await handleJsonRpc(deps, null, rpc("ping"));
    expect(response.result).toBeUndefined();
    expect(response.error?.code).toBe(MCP_UNAUTHORIZED);
    expect(resolved).toBeNull();
  });

  test("AS-002: a wrong/unknown token is rejected with the same non-disclosing auth error", async () => {
    const deps = depsWith(fakeTokens({ valid: {} }), []);
    const { response } = await handleJsonRpc(deps, "anch_pat_wrong", rpc("ping"));
    expect(response.error?.code).toBe(MCP_UNAUTHORIZED);
    expect(response.error?.message).toBe("invalid or revoked token");
  });

  test("AS-002: a revoked token is rejected (revoke takes effect)", async () => {
    const revoked = new Set<string>();
    const tokens = fakeTokens({
      valid: { "anch_pat_rev": { id: "t2", userId: "u", workspaceId: "W", scopes: ["docs:read"] } as any },
      revoked,
    });
    const deps = depsWith(tokens, []);
    // Valid before revoke.
    expect((await handleJsonRpc(deps, "anch_pat_rev", rpc("ping"))).response.error).toBeUndefined();
    // Owner revokes.
    revoked.add("t2");
    const after = await handleJsonRpc(deps, "anch_pat_rev", rpc("ping"));
    expect(after.response.error?.code).toBe(MCP_UNAUTHORIZED);
  });

  test("AS-022: revoking mid-session rejects the NEXT call on the same stream (re-validated every request)", async () => {
    const revoked = new Set<string>();
    const tokens = fakeTokens({
      valid: { "anch_pat_sess": { id: "t3", userId: "u", workspaceId: "W", scopes: ["docs:read"] } as any },
      revoked,
    });
    const deps = depsWith(tokens, []);
    // Several calls succeed on the open "session".
    expect((await handleJsonRpc(deps, "anch_pat_sess", rpc("ping", undefined, 1))).response.error).toBeUndefined();
    expect((await handleJsonRpc(deps, "anch_pat_sess", rpc("ping", undefined, 2))).response.error).toBeUndefined();
    // Owner revokes between requests — no session cache shields the next call.
    revoked.add("t3");
    const next = await handleJsonRpc(deps, "anch_pat_sess", rpc("ping", undefined, 3));
    expect(next.response.error?.code).toBe(MCP_UNAUTHORIZED);
  });

  test("AS-011 / C-009: a docs:read-only token calling create_document is rejected on scope — NO doc created", async () => {
    const sideEffects: string[] = [];
    const tokens = fakeTokens({
      valid: { "anch_pat_ro": { id: "t4", userId: "u", workspaceId: "W", scopes: ["docs:read"] } as any },
    });
    const deps = depsWith(tokens, sideEffects);
    const { response } = await handleJsonRpc(deps, "anch_pat_ro", rpc("create_document", { content: "x" }));
    expect(response.result).toBeUndefined();
    expect(response.error?.code).toBe(MCP_FORBIDDEN_SCOPE);
    expect(response.error?.message).toContain("docs:write");
    // The scope gate runs BEFORE the handler → no side effect.
    expect(sideEffects).toEqual([]);
  });

  test("AS-011 / C-009: the SAME tool succeeds when the token carries docs:write", async () => {
    const sideEffects: string[] = [];
    const tokens = fakeTokens({
      valid: { "anch_pat_rw": { id: "t5", userId: "u", workspaceId: "W2", scopes: ["docs:read", "docs:write"] } as any },
    });
    const deps = depsWith(tokens, sideEffects);
    const { response } = await handleJsonRpc(deps, "anch_pat_rw", rpc("create_document", { content: "x" }));
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ docId: "d_1" });
    expect(sideEffects).toEqual(["created-in:W2"]); // ran in the token's workspace
  });

  test("AS-024: a token over its rate limit is throttled with a clear rate-limit error", async () => {
    const tokens = fakeTokens({
      valid: { "anch_pat_burst": { id: "t6", userId: "u", workspaceId: "W", scopes: ["docs:read"] } as any },
    });
    const deps = depsWith(tokens, [], new McpRateLimiter(2, 60)); // budget 2
    expect((await handleJsonRpc(deps, "anch_pat_burst", rpc("ping"))).response.error).toBeUndefined();
    expect((await handleJsonRpc(deps, "anch_pat_burst", rpc("ping"))).response.error).toBeUndefined();
    const over = await handleJsonRpc(deps, "anch_pat_burst", rpc("ping"));
    expect(over.response.error?.code).toBe(MCP_RATE_LIMITED);
  });

  test("C-001: the rate-limit gate runs AFTER auth — an unauthenticated burst never consumes a token's budget", async () => {
    const tokens = fakeTokens({
      valid: { "anch_pat_ok": { id: "t7", userId: "u", workspaceId: "W", scopes: ["docs:read"] } as any },
    });
    const limiter = new McpRateLimiter(1, 60);
    const deps = depsWith(tokens, [], limiter);
    // A bad token is rejected at auth, never reaching the limiter.
    await handleJsonRpc(deps, "anch_pat_bad", rpc("ping"));
    await handleJsonRpc(deps, "anch_pat_bad", rpc("ping"));
    // The good token still has its full budget of 1.
    expect((await handleJsonRpc(deps, "anch_pat_ok", rpc("ping"))).response.error).toBeUndefined();
  });
});
