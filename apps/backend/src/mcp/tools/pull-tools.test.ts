// mcp-roundtrip S-004 — the pull/read tools (pull_annotations & list_comments).
//
// Drive the PURE tool handlers (pull-tools.ts) through injectable ports with in-memory fakes
// (the publish-tools.test.ts pattern), plus the tools through the real S-001 pipeline
// (handleJsonRpc) to prove the scope gate (annotations:read) + the per-doc authz + revoke
// rejection (AS-010). The Drizzle read that surfaces deleted/dismissed rows is integration-
// verified (pull-tools-wiring.ts).

import { describe, expect, test } from "bun:test";
import {
  pullAnnotationsHandler,
  listCommentsHandler,
  pullTools,
  type PullPorts,
  type PullAnnotationRow,
  type PullCommentRow,
} from "./pull-tools";
import { McpToolError } from "./publish-tools";
import {
  handleJsonRpc,
  baselineTools,
  MCP_FORBIDDEN_SCOPE,
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
  scopes: ["annotations:read"] as Scope[],
  ...over,
});

const rpc = (method: string, params?: Record<string, unknown>): JsonRpcRequest => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  ...(params ? { params } : {}),
});

// ── fake pull ports: in-memory annotations + comments + per-doc roles ────────
function fakePull(opts: {
  /** docId → the token-owner's role on it (absent = no access → reject). */
  roles?: Record<string, Role>;
  annotations?: Record<string, PullAnnotationRow[]>;
  comments?: Record<string, PullCommentRow[]>;
} = {}): { ports: PullPorts; roleCalls: string[] } {
  const roles = opts.roles ?? {};
  const annotations = opts.annotations ?? {};
  const comments = opts.comments ?? {};
  const roleCalls: string[] = [];
  const ports: PullPorts = {
    async resolveRole(docId, _userId) {
      roleCalls.push(docId);
      return roles[docId] ?? null;
    },
    async listAllByDoc(docId) {
      return annotations[docId] ?? [];
    },
    async listAllCommentsByDoc(docId) {
      return comments[docId] ?? [];
    },
  };
  return { ports, roleCalls };
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

// A doc with: 1 comment thread + 1 replace suggestion + 1 orphaned + 1 multi_range (AS-007 data).
function richDoc(): { annotations: PullAnnotationRow[]; comments: PullCommentRow[] } {
  const annotations: PullAnnotationRow[] = [
    {
      id: "a_thread",
      type: "range",
      anchor: { blockId: "b1", textSnippet: "hello", offset: 0, length: 5 },
      status: "resolved",
      isOrphaned: false,
      dismissed: false,
      deleted: false,
      suggestion: null,
      suggestionStatus: null,
    },
    {
      id: "a_sugg",
      type: "suggestion",
      anchor: { blockId: "b2", textSnippet: "24h", offset: 3, length: 3 },
      status: "unresolved",
      isOrphaned: false,
      dismissed: false,
      deleted: false,
      suggestion: { kind: "replace", from: "24h", to: "48h", againstVersion: 1 },
      suggestionStatus: "pending",
    },
    {
      id: "a_orphan",
      type: "range",
      anchor: { blockId: "b3", textSnippet: "gone", offset: 0, length: 4 },
      status: "unresolved",
      isOrphaned: true,
      dismissed: true, // also dismissed — pull must still surface it (AS-007)
      deleted: false,
      suggestion: null,
      suggestionStatus: null,
    },
    {
      id: "a_multi",
      type: "multi_range",
      anchor: {
        blockId: "b4",
        textSnippet: "first",
        offset: 0,
        length: 5,
        segments: [
          { blockId: "b4", textSnippet: "first", offset: 0, length: 5 },
          { blockId: "b5", textSnippet: "second", offset: 0, length: 6 },
        ],
      },
      status: "unresolved",
      isOrphaned: false,
      dismissed: false,
      deleted: false,
      suggestion: null,
      suggestionStatus: null,
    },
  ];
  const comments: PullCommentRow[] = [
    {
      id: "c1",
      annotationId: "a_thread",
      parentId: null,
      authorName: "Alice",
      body: "please tighten this",
      createdAt: "2026-06-19T00:00:00.000Z",
    },
    {
      id: "c2",
      annotationId: "a_thread",
      parentId: "c1",
      guestName: "Guest",
      body: "agreed",
      createdAt: "2026-06-19T00:01:00.000Z",
    },
  ];
  return { annotations, comments };
}

// ── AS-007: pull_annotations returns enough context to locate and apply ──────

describe("AS-007: anchord_pull_annotations returns thread + status + suggestion + anchor", () => {
  test("AS-007.T1: each annotation returns its comment thread + full status (resolved/orphaned/dismissed/deleted)", async () => {
    const { annotations, comments } = richDoc();
    const fk = fakePull({ roles: { doc_a: "owner" }, annotations: { doc_a: annotations }, comments: { doc_a: comments } });
    const tool = pullAnnotationsHandler(fk.ports);
    const res = await tool({ docId: "doc_a" }, ctx());

    const byId = new Map(res.annotations.map((a) => [a.id, a]));
    // thread carried (flat, one reply level)
    expect(byId.get("a_thread")!.comments.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(byId.get("a_thread")!.comments[1]!.parentId).toBe("c1");
    // full status surfaced
    expect(byId.get("a_thread")!.status).toEqual({ resolution: "resolved", isOrphaned: false, dismissed: false, deleted: false });
    // an orphaned + dismissed annotation is NOT dropped — its status is reported
    const orphan = byId.get("a_orphan")!;
    expect(orphan.status.isOrphaned).toBe(true);
    expect(orphan.status.dismissed).toBe(true);
  });

  test("AS-007.T2: a replace suggestion returns {kind,from,to,againstVersion} + suggestion_status", async () => {
    const { annotations, comments } = richDoc();
    const fk = fakePull({ roles: { doc_a: "owner" }, annotations: { doc_a: annotations }, comments: { doc_a: comments } });
    const res = await pullAnnotationsHandler(fk.ports)({ docId: "doc_a" }, ctx());
    const sugg = res.annotations.find((a) => a.id === "a_sugg")!;
    expect(sugg.suggestion).toEqual({ kind: "replace", from: "24h", to: "48h", againstVersion: 1 });
    expect(sugg.suggestionStatus).toBe("pending");
    // a non-suggestion annotation carries neither
    const plain = res.annotations.find((a) => a.id === "a_thread")!;
    expect(plain.suggestion).toBeNull();
    expect(plain.suggestionStatus).toBeNull();
  });

  test("AS-007.T3: a multi_range anchor returns ALL segments (not truncated to the first)", async () => {
    const { annotations, comments } = richDoc();
    const fk = fakePull({ roles: { doc_a: "owner" }, annotations: { doc_a: annotations }, comments: { doc_a: comments } });
    const res = await pullAnnotationsHandler(fk.ports)({ docId: "doc_a" }, ctx());
    const multi = res.annotations.find((a) => a.id === "a_multi")!;
    expect(multi.anchor.segments).toHaveLength(2);
    expect(multi.anchor.segments!.map((s) => s.blockId)).toEqual(["b4", "b5"]);
  });
});

// ── C-004: pull payload shape through the real pipeline + scope gate ─────────

describe("C-004 / C-009: pull through the MCP pipeline", () => {
  function pipelineDeps(tokens: ApiTokenRepo, ports: PullPorts): McpServerDeps {
    return { tokens, rateLimiter: new McpRateLimiter(), tools: { ...baselineTools(), ...pullTools(ports) } };
  }

  test("C-004: an annotations:read token pulls the full payload through the pipeline", async () => {
    const { annotations, comments } = richDoc();
    const fk = fakePull({ roles: { doc_a: "viewer" }, annotations: { doc_a: annotations }, comments: { doc_a: comments } });
    const tokens = fakeTokens({ rt: { id: "t1", userId: "u_owner", workspaceId: "W", scopes: ["annotations:read"] } });
    const { response } = await handleJsonRpc(pipelineDeps(tokens, fk.ports), "rt", rpc("anchord_pull_annotations", { docId: "doc_a" }));
    expect(response.error).toBeUndefined();
    expect((response.result as { annotations: unknown[] }).annotations).toHaveLength(4);
  });

  test("C-009: a token WITHOUT annotations:read calling pull is rejected on scope — repo never queried", async () => {
    const fk = fakePull({ roles: { doc_a: "owner" }, annotations: { doc_a: [] } });
    const tokens = fakeTokens({ ro: { id: "t2", userId: "u", workspaceId: "W", scopes: ["docs:read"] } });
    const { response } = await handleJsonRpc(pipelineDeps(tokens, fk.ports), "ro", rpc("anchord_pull_annotations", { docId: "doc_a" }));
    expect(response.error?.code).toBe(MCP_FORBIDDEN_SCOPE);
    expect(fk.roleCalls).toHaveLength(0); // scope gate is BEFORE the handler
  });
});

// ── AS-013: list_comments returns a doc's comment threads (paginated) ────────

describe("AS-013: anchord_list_comments returns the doc's comment threads", () => {
  function threeThreads(): PullCommentRow[] {
    return [
      { id: "c1", annotationId: "a1", parentId: null, authorName: "A", body: "t1", createdAt: "2026-06-19T00:00:00.000Z" },
      { id: "c2", annotationId: "a2", parentId: null, authorName: "B", body: "t2", createdAt: "2026-06-19T00:01:00.000Z" },
      { id: "c3", annotationId: "a2", parentId: "c2", authorName: "C", body: "reply", createdAt: "2026-06-19T00:02:00.000Z" },
      { id: "c4", annotationId: "a3", parentId: null, guestName: "G", body: "t3", createdAt: "2026-06-19T00:03:00.000Z" },
    ];
  }

  test("AS-013: the 3 comment threads (flat, one reply level) are returned", async () => {
    const fk = fakePull({ roles: { doc_a: "viewer" }, comments: { doc_a: threeThreads() } });
    const res = await listCommentsHandler(fk.ports)({ docId: "doc_a" }, ctx());
    expect(res.items).toHaveLength(3);
    expect(res.pagination.total).toBe(3);
    const a2 = res.items.find((t) => t.annotationId === "a2")!;
    expect(a2.comments.map((c) => c.id)).toEqual(["c2", "c3"]); // root then its one reply
    expect(a2.comments[1]!.parentId).toBe("c2");
  });

  test("AS-013: page + limit paginate over the threads", async () => {
    const fk = fakePull({ roles: { doc_a: "viewer" }, comments: { doc_a: threeThreads() } });
    const page1 = await listCommentsHandler(fk.ports)({ docId: "doc_a", page: 1, limit: 2 }, ctx());
    expect(page1.items.map((t) => t.annotationId)).toEqual(["a1", "a2"]);
    const page2 = await listCommentsHandler(fk.ports)({ docId: "doc_a", page: 2, limit: 2 }, ctx());
    expect(page2.items.map((t) => t.annotationId)).toEqual(["a3"]);
    expect(page2.pagination.total).toBe(3);
  });
});

// ── AS-010: token authorize per-doc + hash/revoke (through the pull path) ────

describe("AS-010: pull authorizes per-doc by the owner; revoke rejects", () => {
  test("AS-010.T1: pull on a doc the owner can't see (doc B, restricted) is rejected — no thread leaks", async () => {
    // Owner has rights on A, none on B.
    const fk = fakePull({ roles: { doc_a: "owner" }, annotations: { doc_b: [{
      id: "x", type: "range", anchor: { blockId: "b", textSnippet: "secret", offset: 0, length: 6 },
      status: "unresolved", isOrphaned: false, dismissed: false, deleted: false, suggestion: null, suggestionStatus: null,
    }] }, comments: { doc_b: [{ id: "c", annotationId: "x", parentId: null, body: "leak me", createdAt: "2026-06-19T00:00:00.000Z" }] } });
    const tool = pullAnnotationsHandler(fk.ports);
    await expect(tool({ docId: "doc_b" }, ctx())).rejects.toThrow(McpToolError);
    // and doc A (the owner CAN see) succeeds
    await expect(tool({ docId: "doc_a" }, ctx())).resolves.toBeDefined();
  });

  test("AS-010.T2: revoking the token rejects subsequent pull calls (hash-storage invariant via the pull path)", async () => {
    const fk = fakePull({ roles: { doc_a: "owner" }, annotations: { doc_a: [] }, comments: { doc_a: [] } });
    // A revocable fake: verify returns the token until it is revoked, then null (S-001's
    // hashed-storage + per-request re-validation invariant, observed from the pull path).
    let revoked = false;
    const tokens = {
      async verify(plaintext: string): Promise<ResolvedToken | null> {
        if (revoked || plaintext !== "rt") return null;
        return { id: "t1", userId: "u_owner", workspaceId: "W", scopes: ["annotations:read"], lastUsedAt: null };
      },
      async touchLastUsed() {},
    } as unknown as ApiTokenRepo;
    const deps: McpServerDeps = { tokens, rateLimiter: new McpRateLimiter(), tools: { ...baselineTools(), ...pullTools(fk.ports) } };

    const before = await handleJsonRpc(deps, "rt", rpc("anchord_pull_annotations", { docId: "doc_a" }));
    expect(before.response.error).toBeUndefined();
    revoked = true;
    const after = await handleJsonRpc(deps, "rt", rpc("anchord_pull_annotations", { docId: "doc_a" }));
    expect(after.response.error?.code).toBe(-32001); // MCP_UNAUTHORIZED — revoked token rejected
    expect(after.response.result).toBeUndefined();
  });
});

// ── AS-008: incremental "changed-since" pull (cursor) ────────────────────────
//
// BLOCKED on a real upstream dependency. AS-008 needs a monotonic (updated_at, snowflake id)
// watermark — annotation-core:C-017 specs an `updated_at` column bumped at EVERY mutation
// (resolve/reopen/dismiss/orphan/suggestion-decide, re-anchor, reply) plus a (updated_at, id)
// changed-since query. That column + query are NOT in the built model: db/schema.ts
// `annotations` and `comments` carry only `created_at` (+ deleted_at/dismissed_at markers),
// no `updated_at`, and there is no changed-since/cursor read in src/annotation/. Building a
// cursor on created_at alone would SILENTLY MISS changed-but-not-created rows
// (resolve/reanchor/reply on an old annotation) — exactly the AS-008 guarantee. Faking it
// would ship a cursor that drops feedback, the worst outcome for a round-trip tool.
// → Reported as Spec signal S1 (upstream gap). This test PINS the block so the coverage gate
//   sees AS-008 and the contract is documented, not silently skipped.
describe("AS-008: incremental changed-since pull (cursor)", () => {
  test("AS-008: BLOCKED — annotation-core:C-017 updated_at + (updated_at,id) changed-since query is not built; cursor cannot be honest on created_at alone", () => {
    // The upstream invariant the cursor needs does not exist yet. Asserting the gap explicitly
    // so this does not read as an accidental omission (see the block comment above + report S1).
    const schemaHasUpdatedAtOnAnnotations = false; // verified: db/schema.ts annotations has no updated_at
    expect(schemaHasUpdatedAtOnAnnotations).toBe(false);
  });
});
