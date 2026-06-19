// mcp-roundtrip S-005 — the write-back tools (reply_comment & resolve_comment).
//
// Drive the PURE tool handlers (writeback-tools.ts) through injectable ports with in-memory
// fakes (the pull-tools.test.ts pattern), plus the tools through the real S-001 pipeline
// (handleJsonRpc) to prove the scope gate (annotations:write) + the per-doc authz + revoke
// rejection. The Drizzle reuse of addReply/setResolution is integration-verified via their
// own unit suites (reply.test.ts / resolve.test.ts) + writeback-tools-wiring.ts.

import { describe, expect, test } from "bun:test";
import {
  replyCommentHandler,
  resolveCommentHandler,
  writebackTools,
  type WritebackPorts,
} from "./writeback-tools";
import { McpToolError } from "./publish-tools";
import {
  handleJsonRpc,
  baselineTools,
  MCP_FORBIDDEN_SCOPE,
  MCP_UNAUTHORIZED,
  JSONRPC_INVALID_PARAMS,
  type JsonRpcRequest,
  type McpServerDeps,
  type ToolContext,
} from "../server";
import { McpRateLimiter } from "../rate-limit";
import type { ApiTokenRepo, ResolvedToken } from "../token-repo";
import type { Scope } from "../token";
import type { Role } from "../../sharing/roles";

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  userId: "u_owner",
  workspaceId: "W",
  scopes: ["annotations:write"] as Scope[],
  ...over,
});

const rpc = (method: string, params?: Record<string, unknown>): JsonRpcRequest => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  ...(params ? { params } : {}),
});

// ── fake write-back ports: in-memory comment/annotation map + per-doc roles ──
function fakeWriteback(opts: {
  /** docId → the token-owner's role on it (absent = no access → reject). */
  roles?: Record<string, Role>;
  /** commentId → { docId, annotationId }. Absent = nonexistent comment. */
  comments?: Record<string, { docId: string; annotationId: string }>;
  /** annotationId → { docId }. Absent = nonexistent annotation. */
  annotationDocs?: Record<string, { docId: string }>;
} = {}): {
  ports: WritebackPorts;
  replies: Array<{ annotationId: string; parentCommentId: string; body: string; sessionRole: Role }>;
  resolves: Array<{ annotationId: string; sessionRole: Role }>;
} {
  const roles = opts.roles ?? {};
  const comments = opts.comments ?? {};
  const annotationDocs = opts.annotationDocs ?? {};
  const replies: Array<{ annotationId: string; parentCommentId: string; body: string; sessionRole: Role }> = [];
  const resolves: Array<{ annotationId: string; sessionRole: Role }> = [];
  const ports: WritebackPorts = {
    async findCommentTarget(commentId) {
      return comments[commentId] ?? null;
    },
    async findAnnotationDoc(annotationId) {
      return annotationDocs[annotationId] ?? null;
    },
    async resolveRole(docId) {
      return roles[docId] ?? null;
    },
    async addReply(input) {
      replies.push({
        annotationId: input.annotationId,
        parentCommentId: input.parentCommentId,
        body: input.body,
        sessionRole: input.sessionRole,
      });
      return { created: true, id: "c_reply", parentId: input.parentCommentId };
    },
    async resolveAnnotation(input) {
      resolves.push({ annotationId: input.annotationId, sessionRole: input.sessionRole });
      return { ok: true, status: "resolved" };
    },
  };
  return { ports, replies, resolves };
}

function fakeTokens(
  valid: Record<string, { id: string; userId: string; workspaceId: string; scopes: Scope[] }>,
): ApiTokenRepo {
  return {
    async verify(plaintext: string): Promise<ResolvedToken | null> {
      const t = valid[plaintext];
      return t ? { ...t, lastUsedAt: null } : null;
    },
    async touchLastUsed() {},
  } as unknown as ApiTokenRepo;
}

function pipelineDeps(tokens: ApiTokenRepo, ports: WritebackPorts): McpServerDeps {
  return { tokens, rateLimiter: new McpRateLimiter(), tools: { ...baselineTools(), ...writebackTools(ports) } };
}

// ── AS-009: reply_comment + resolve_comment ─────────────────────────────────

describe("AS-009: anchord_reply_comment then anchord_resolve_comment", () => {
  test("AS-009: reply is added to the thread (flat) and the annotation becomes resolved", async () => {
    const fk = fakeWriteback({
      roles: { doc_a: "commenter" },
      comments: { c1: { docId: "doc_a", annotationId: "a1" } },
      annotationDocs: { a1: { docId: "doc_a" } },
    });

    // reply "changed to 48h in v2" (AS-009 data)
    const reply = await replyCommentHandler(fk.ports)({ commentId: "c1", body: "changed to 48h in v2" }, ctx());
    expect(reply).toEqual({ commentId: "c1", replyId: "c_reply", parentId: "c1" });
    expect(fk.replies).toHaveLength(1);
    // The reply reuses addReply with the comment's annotation + the resolved role (flat thread).
    expect(fk.replies[0]).toEqual({
      annotationId: "a1",
      parentCommentId: "c1",
      body: "changed to 48h in v2",
      sessionRole: "commenter",
    });

    // then resolve
    const resolved = await resolveCommentHandler(fk.ports)({ annotationId: "a1" }, ctx());
    expect(resolved).toEqual({ annotationId: "a1", status: "resolved" });
    expect(fk.resolves).toEqual([{ annotationId: "a1", sessionRole: "commenter" }]);
  });

  test("AS-009: resolve is idempotent — re-resolving an already-resolved annotation stays resolved", async () => {
    const fk = fakeWriteback({ roles: { doc_a: "editor" }, annotationDocs: { a1: { docId: "doc_a" } } });
    const handler = resolveCommentHandler(fk.ports);
    const first = await handler({ annotationId: "a1" }, ctx());
    const second = await handler({ annotationId: "a1" }, ctx());
    expect(first).toEqual({ annotationId: "a1", status: "resolved" });
    expect(second).toEqual({ annotationId: "a1", status: "resolved" });
  });

  // ── scope gate (C-009): annotations:write required ────────────────────────
  test("AS-009 edge: a token WITHOUT annotations:write is rejected at the scope gate (reply) — no write", async () => {
    const fk = fakeWriteback({
      roles: { doc_a: "owner" },
      comments: { c1: { docId: "doc_a", annotationId: "a1" } },
    });
    const tokens = fakeTokens({ ro: { id: "t_ro", userId: "u_owner", workspaceId: "W", scopes: ["annotations:read"] } });
    const { response } = await handleJsonRpc(
      pipelineDeps(tokens, fk.ports),
      "ro",
      rpc("anchord_reply_comment", { commentId: "c1", body: "x" }),
    );
    expect(response.error?.code).toBe(MCP_FORBIDDEN_SCOPE);
    expect(fk.replies).toHaveLength(0); // no side effect
  });

  test("AS-009 edge: a token WITHOUT annotations:write is rejected at the scope gate (resolve) — no write", async () => {
    const fk = fakeWriteback({ roles: { doc_a: "owner" }, annotationDocs: { a1: { docId: "doc_a" } } });
    const tokens = fakeTokens({ ro: { id: "t_ro", userId: "u_owner", workspaceId: "W", scopes: ["docs:read"] } });
    const { response } = await handleJsonRpc(
      pipelineDeps(tokens, fk.ports),
      "ro",
      rpc("anchord_resolve_comment", { annotationId: "a1" }),
    );
    expect(response.error?.code).toBe(MCP_FORBIDDEN_SCOPE);
    expect(fk.resolves).toHaveLength(0);
  });

  // ── nonexistent target (C-008 per-resource) ───────────────────────────────
  test("AS-009 edge: reply to a nonexistent commentId is rejected — no write", async () => {
    const fk = fakeWriteback({ roles: { doc_a: "owner" } });
    await expect(
      replyCommentHandler(fk.ports)({ commentId: "missing", body: "x" }, ctx()),
    ).rejects.toBeInstanceOf(McpToolError);
    expect(fk.replies).toHaveLength(0);
  });

  test("AS-009 edge: resolve of a nonexistent annotationId is rejected — no write", async () => {
    const fk = fakeWriteback({ roles: { doc_a: "owner" } });
    await expect(
      resolveCommentHandler(fk.ports)({ annotationId: "missing" }, ctx()),
    ).rejects.toBeInstanceOf(McpToolError);
    expect(fk.resolves).toHaveLength(0);
  });

  // ── per-doc authz (C-008): owner has no write rights on the doc ────────────
  test("AS-009 edge: reply on a doc the owner can only VIEW is rejected — no write", async () => {
    const fk = fakeWriteback({
      roles: { doc_a: "viewer" }, // viewer cannot comment
      comments: { c1: { docId: "doc_a", annotationId: "a1" } },
    });
    await expect(
      replyCommentHandler(fk.ports)({ commentId: "c1", body: "x" }, ctx()),
    ).rejects.toBeInstanceOf(McpToolError);
    expect(fk.replies).toHaveLength(0);
  });

  test("AS-009 edge: resolve on a doc the owner has NO access to is rejected — no write", async () => {
    const fk = fakeWriteback({
      roles: {}, // no role on doc_b
      annotationDocs: { a1: { docId: "doc_b" } },
    });
    await expect(
      resolveCommentHandler(fk.ports)({ annotationId: "a1" }, ctx()),
    ).rejects.toBeInstanceOf(McpToolError);
    expect(fk.resolves).toHaveLength(0);
  });

  // ── revoke / unknown token rejected at the pipeline (C-001) ────────────────
  test("AS-009 edge: a revoked/unknown token is rejected before dispatch — no write", async () => {
    const fk = fakeWriteback({
      roles: { doc_a: "owner" },
      comments: { c1: { docId: "doc_a", annotationId: "a1" } },
    });
    const tokens = fakeTokens({}); // no valid tokens → revoked/unknown
    const { response } = await handleJsonRpc(
      pipelineDeps(tokens, fk.ports),
      "revoked",
      rpc("anchord_reply_comment", { commentId: "c1", body: "x" }),
    );
    expect(response.error?.code).toBe(MCP_UNAUTHORIZED);
    expect(fk.replies).toHaveLength(0);
  });

  // ── bad params surface as INVALID_PARAMS through the pipeline ──────────────
  test("AS-009 edge: an empty body / missing param surfaces as a caller-facing INVALID_PARAMS", async () => {
    const fk = fakeWriteback({
      roles: { doc_a: "owner" },
      comments: { c1: { docId: "doc_a", annotationId: "a1" } },
    });
    const tokens = fakeTokens({ rw: { id: "t_rw", userId: "u_owner", workspaceId: "W", scopes: ["annotations:write"] } });
    const { response } = await handleJsonRpc(
      pipelineDeps(tokens, fk.ports),
      "rw",
      rpc("anchord_reply_comment", { commentId: "c1" }), // body missing
    );
    expect(response.error?.code).toBe(JSONRPC_INVALID_PARAMS);
    expect(fk.replies).toHaveLength(0);
  });

  // ── happy path through the full pipeline (scope passes) ────────────────────
  test("AS-009: full pipeline — annotations:write token replies then resolves end-to-end", async () => {
    const fk = fakeWriteback({
      roles: { doc_a: "commenter" },
      comments: { c1: { docId: "doc_a", annotationId: "a1" } },
      annotationDocs: { a1: { docId: "doc_a" } },
    });
    const tokens = fakeTokens({ rw: { id: "t_rw", userId: "u_owner", workspaceId: "W", scopes: ["annotations:write"] } });
    const deps = pipelineDeps(tokens, fk.ports);

    const r1 = await handleJsonRpc(deps, "rw", rpc("anchord_reply_comment", { commentId: "c1", body: "changed to 48h in v2" }));
    expect(r1.response.error).toBeUndefined();
    expect(r1.response.result).toEqual({ commentId: "c1", replyId: "c_reply", parentId: "c1" });

    const r2 = await handleJsonRpc(deps, "rw", rpc("anchord_resolve_comment", { annotationId: "a1" }));
    expect(r2.response.error).toBeUndefined();
    expect(r2.response.result).toEqual({ annotationId: "a1", status: "resolved" });
  });
});
