// mcp-roundtrip S-003 — the read tools (list_documents / read_document / search_documents).
//
// Drive the PURE tool handlers (read-tools.ts) through injectable ports with in-memory fakes
// (the pull-tools.test.ts / publish-tools.test.ts pattern), plus the tools through the real
// S-001 pipeline (handleJsonRpc) to prove the scope gate (docs:read) and the cross-tenant
// binding (C-013 / AS-029): a token bound to W1 never surfaces a W2 doc across list/search/read.
//
// The NEW workspace-wide accessible-docs Drizzle read + the search-array-to-pagination adapter
// are integration-verified in read-tools-wiring.ts; here the fake store simulates them so the
// access-scoping logic (C-003 / C-013) is unit-tested without a DB.

import { describe, expect, test } from "bun:test";
import {
  listDocumentsHandler,
  readDocumentHandler,
  searchDocumentsHandler,
  readTools,
  type ReadPorts,
  type DocumentSummary,
  type ResolvedReadDoc,
} from "./read-tools";
import { McpToolError } from "./publish-tools";
import {
  handleJsonRpc,
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
  workspaceId: "W1",
  scopes: ["docs:read"] as Scope[],
  ...over,
});

const rpc = (method: string, params?: Record<string, unknown>): JsonRpcRequest => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  ...(params ? { params } : {}),
});

// ── fake store: docs across W1 + W2, each with a workspace + the owner's role ─
// AS-006 data: docs both inside (W1, owner has rights) and outside (W2, or W1-restricted-no-role)
// the scope. AS-029 data: an anyone_in_workspace doc in W2 the owner could otherwise see.

interface StoreDoc extends DocumentSummary {
  workspaceId: string;
  /** the token-owner's role on it, or null = no access (e.g. a restricted doc not shared). */
  role: Role | null;
  version: number;
  content: string;
  /** matches a search for this term (simulates the SQL FTS match). */
  searchTerm?: string;
}

function fakeRead(docs: StoreDoc[]): { ports: ReadPorts; calls: { listWs: string[]; searchWs: string[] } } {
  const calls = { listWs: [] as string[], searchWs: [] as string[] };
  const summary = (d: StoreDoc): DocumentSummary => ({
    docId: d.docId,
    slug: d.slug,
    title: d.title,
    kind: d.kind,
  });
  // The fake mirrors the REAL access reads' contract: list/search are already
  // access-filtered AND workspace-scoped (the SQL does this), so they only ever return
  // docs in the requested workspace that the owner can browse.
  const ports: ReadPorts = {
    async listAccessibleDocs(input) {
      calls.listWs.push(input.workspaceId);
      const visible = docs.filter(
        (d) => d.workspaceId === input.workspaceId && d.role !== null,
      );
      const items = visible.slice(input.offset, input.offset + input.limit).map(summary);
      return { items, total: visible.length };
    },
    async findReadableDoc(idOrSlug, _userId) {
      const d = docs.find((x) => x.docId === idOrSlug || x.slug === idOrSlug);
      if (!d) return null;
      const out: ResolvedReadDoc = {
        docId: d.docId,
        slug: d.slug,
        title: d.title,
        kind: d.kind,
        version: d.version,
        content: d.content,
        workspaceId: d.workspaceId, // the doc's OWN workspace (gated against the token's)
        role: d.role, // resolveAccess role against the doc's own workspace
      };
      return out;
    },
    async searchAccessibleDocs(input) {
      calls.searchWs.push(input.workspaceId);
      return docs
        .filter(
          (d) =>
            d.workspaceId === input.workspaceId &&
            d.role !== null &&
            (d.searchTerm === input.query || d.title.includes(input.query)),
        )
        .map(summary);
    },
  };
  return { ports, calls };
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

// W1 docs: one the owner owns (in scope), one restricted with no role (out of scope).
// W2 docs: an anyone_in_workspace doc the owner can see in W2 (the cross-tenant trap).
const STORE: StoreDoc[] = [
  {
    docId: "d_w1_own",
    slug: "w1-own",
    title: "Payment Spec",
    kind: "html",
    workspaceId: "W1",
    role: "owner",
    version: 2,
    content: "<h1>Payment</h1>",
    searchTerm: "payment",
  },
  {
    docId: "d_w1_hidden",
    slug: "w1-hidden",
    title: "Secret W1 Doc",
    kind: "markdown",
    workspaceId: "W1",
    role: null, // restricted, not shared with the owner → outside the scope
    version: 1,
    content: "secret",
    searchTerm: "secret",
  },
  {
    docId: "d_w2_anyone",
    slug: "w2-anyone",
    title: "W2 Open Doc",
    kind: "html",
    workspaceId: "W2",
    role: "viewer", // owner is a W2 member → resolveAccess grants a role in W2
    version: 1,
    content: "<p>w2</p>",
    searchTerm: "payment", // SAME term as the W1 doc — proves search doesn't cross workspaces
  },
];

describe("anchord_list_documents", () => {
  test("AS-006: returns only docs the token-owner has rights to in the token's workspace", async () => {
    const { ports } = fakeRead(STORE);
    const res = await listDocumentsHandler(ports)({}, ctx());
    const ids = res.items.map((i) => i.docId);
    // T1: only the in-scope W1 doc is returned; the restricted W1 doc and the W2 doc are absent.
    expect(ids).toEqual(["d_w1_own"]);
    expect(ids).not.toContain("d_w1_hidden");
    expect(ids).not.toContain("d_w2_anyone");
  });

  test("AS-006: list is paginated by page + limit returning {items, pagination}", async () => {
    // Three accessible W1 docs to page through.
    const many: StoreDoc[] = [1, 2, 3].map((n) => ({
      docId: `d${n}`,
      slug: `s${n}`,
      title: `Doc ${n}`,
      kind: "html",
      workspaceId: "W1",
      role: "owner",
      version: 1,
      content: "",
    }));
    const { ports } = fakeRead(many);
    const page1 = await listDocumentsHandler(ports)({ page: 1, limit: 2 }, ctx());
    expect(page1.items.map((i) => i.docId)).toEqual(["d1", "d2"]);
    expect(page1.pagination).toEqual({ page: 1, limit: 2, total: 3 });
    const page2 = await listDocumentsHandler(ports)({ page: 2, limit: 2 }, ctx());
    expect(page2.items.map((i) => i.docId)).toEqual(["d3"]);
    expect(page2.pagination).toEqual({ page: 2, limit: 2, total: 3 });
  });

  test("AS-006: defaults page/limit and clamps invalid input (boundary/invalid type)", async () => {
    const { ports } = fakeRead(STORE);
    // null/invalid page+limit → defaults (page 1, limit 20); negative/zero clamped.
    const res = await listDocumentsHandler(ports)({ page: -5, limit: "oops" }, ctx());
    expect(res.pagination.page).toBe(1);
    expect(res.pagination.limit).toBe(20);
    const big = await listDocumentsHandler(ports)({ limit: 9999 }, ctx());
    expect(big.pagination.limit).toBe(100); // MAX_LIMIT
  });

  test("AS-029: a W1 token never lists a W2 anyone_in_workspace doc", async () => {
    const { ports, calls } = fakeRead(STORE);
    const res = await listDocumentsHandler(ports)({}, ctx({ workspaceId: "W1" }));
    expect(res.items.map((i) => i.docId)).not.toContain("d_w2_anyone");
    // C-013: the read was scoped by the TOKEN's workspace (ctx), not an ambient/path one.
    expect(calls.listWs).toEqual(["W1"]);
  });
});

describe("anchord_read_document", () => {
  test("AS-006: reads an in-scope doc by id and by slug", async () => {
    const { ports } = fakeRead(STORE);
    const byId = await readDocumentHandler(ports)({ idOrSlug: "d_w1_own" }, ctx());
    expect(byId.docId).toBe("d_w1_own");
    expect(byId.content).toBe("<h1>Payment</h1>");
    expect(byId.version).toBe(2);
    const bySlug = await readDocumentHandler(ports)({ idOrSlug: "w1-own" }, ctx());
    expect(bySlug.docId).toBe("d_w1_own");
  });

  test("AS-006: a doc the owner has no rights to is rejected (out of scope)", async () => {
    const { ports } = fakeRead(STORE);
    await expect(readDocumentHandler(ports)({ idOrSlug: "d_w1_hidden" }, ctx())).rejects.toThrow(
      McpToolError,
    );
  });

  test("AS-006: missing/empty idOrSlug is rejected (null/empty input)", async () => {
    const { ports } = fakeRead(STORE);
    await expect(readDocumentHandler(ports)({}, ctx())).rejects.toThrow(McpToolError);
    await expect(readDocumentHandler(ports)({ idOrSlug: "" }, ctx())).rejects.toThrow(McpToolError);
  });

  test("AS-029: a W1 token reading a W2 doc the owner can otherwise see is rejected", async () => {
    const { ports } = fakeRead(STORE);
    // The owner IS a W2 member (role: viewer resolves), but the token is bound to W1 → reject.
    await expect(
      readDocumentHandler(ports)({ idOrSlug: "d_w2_anyone" }, ctx({ workspaceId: "W1" })),
    ).rejects.toThrow(McpToolError);
    // And the same doc IS readable with a W2-bound token (proves the gate is the token's ws, not the role).
    const w2 = await readDocumentHandler(ports)(
      { idOrSlug: "d_w2_anyone" },
      ctx({ workspaceId: "W2" }),
    );
    expect(w2.docId).toBe("d_w2_anyone");
  });
});

describe("anchord_search_documents", () => {
  test("AS-006: returns only in-scope matches and is paginated returning {items, pagination}", async () => {
    const { ports } = fakeRead(STORE);
    const res = await searchDocumentsHandler(ports)({ query: "payment", page: 1, limit: 10 }, ctx());
    // T1: the W1 doc matches; the W2 doc with the SAME search term does NOT (cross-workspace).
    expect(res.items.map((i) => i.docId)).toEqual(["d_w1_own"]);
    // T2: paginated envelope.
    expect(res.pagination).toEqual({ page: 1, limit: 10, total: 1 });
  });

  test("AS-006: empty/whitespace query is rejected (empty input)", async () => {
    const { ports } = fakeRead(STORE);
    await expect(searchDocumentsHandler(ports)({ query: "   " }, ctx())).rejects.toThrow(McpToolError);
    await expect(searchDocumentsHandler(ports)({}, ctx())).rejects.toThrow(McpToolError);
  });

  test("AS-029: a W1 token's search never surfaces a W2 doc matching the same term", async () => {
    const { ports, calls } = fakeRead(STORE);
    const res = await searchDocumentsHandler(ports)({ query: "payment" }, ctx({ workspaceId: "W1" }));
    expect(res.items.map((i) => i.docId)).not.toContain("d_w2_anyone");
    // C-013: search scoped by the TOKEN's workspace.
    expect(calls.searchWs).toEqual(["W1"]);
  });
});

// ── pipeline-level: the scope gate (C-009) + identity threading through handleJsonRpc ─

describe("read tools through the S-001 pipeline", () => {
  const deps = (scopes: Scope[]): McpServerDeps => ({
    tokens: fakeTokens({
      tok: { id: "t1", userId: "u_owner", workspaceId: "W1", scopes },
    }),
    rateLimiter: new McpRateLimiter(),
    tools: readTools(fakeRead(STORE).ports),
  });

  test("C-003: list/read/search run under the token's identity + workspace and return access-filtered docs", async () => {
    const server = deps(["docs:read"]);
    const list = await handleJsonRpc(server, "tok", rpc("anchord_list_documents"));
    const result = list.response.result as { items: DocumentSummary[] };
    // Dispatched under the token-owner in W1 → only the in-scope W1 doc (C-003).
    expect(result.items.map((i) => i.docId)).toEqual(["d_w1_own"]);
    expect(list.response.error).toBeUndefined();
  });

  test("C-013: a docs:read token still cannot read another workspace's doc through the pipeline", async () => {
    const server = deps(["docs:read"]);
    // Token is bound to W1; the W2 doc must be rejected even though the owner is a W2 member.
    const res = await handleJsonRpc(server, "tok", rpc("anchord_read_document", { idOrSlug: "d_w2_anyone" }));
    expect(res.response.error).toBeDefined();
  });

  test("C-009: a token without docs:read is rejected at the scope gate (no read runs)", async () => {
    const server = deps(["docs:write"]); // wrong scope
    const res = await handleJsonRpc(server, "tok", rpc("anchord_list_documents"));
    expect(res.response.error?.code).toBe(MCP_FORBIDDEN_SCOPE);
    expect(res.response.result).toBeUndefined();
  });
});
