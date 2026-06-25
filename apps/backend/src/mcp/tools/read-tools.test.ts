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
  /** doc-access-two-axis S-006: the doc's raw two-axis state (default both off → restricted). */
  workspaceRole?: "viewer" | "commenter" | "editor" | null;
  linkRole?: "viewer" | "commenter" | "editor" | null;
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
        // doc-access-two-axis S-006: the raw axes (default both off → restricted).
        workspaceRole: d.workspaceRole ?? null,
        linkRole: d.linkRole ?? null,
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

  test("AS-017: MCP browse lists a workspace-shared doc, not a link-only one, for a non-invited member", async () => {
    // doc-access-two-axis S-004 / C-006: listAccessibleDocs uses the SAME workspace-visibility
    // rule as the dashboard — a doc surfaces iff workspace_role IS NOT NULL (or owner/invited).
    // The fake mirrors that SQL: a link-only doc the member is NOT invited to resolves role=null
    // (no workspace grant) so it never lists; the workspace-shared doc does. (The concrete SQL —
    // the `left join share_links … workspace_role is not null` predicate — is integration-only;
    // no Docker here, so this gates the CONTRACT that MCP browse applies the C-006 rule.)
    const store: StoreDoc[] = [
      { docId: "d_ws", slug: "ws", title: "Workspace Doc", kind: "html", workspaceId: "W1",
        role: "commenter", version: 1, content: "x" }, // workspace axis on → a browse grant
      { docId: "d_link", slug: "link", title: "Link Only", kind: "html", workspaceId: "W1",
        role: null, version: 1, content: "y" }, // workspace off + link on, not invited → no grant
    ];
    const { ports } = fakeRead(store);
    const res = await listDocumentsHandler(ports)({}, ctx({ workspaceId: "W1" }));
    expect(res.items.map((i) => i.docId)).toEqual(["d_ws"]);
    expect(res.items.map((i) => i.docId)).not.toContain("d_link");
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

// doc-access-two-axis S-006 / C-008 — read_document carries BOTH the derived legacy
// `generalAccess` summary AND the raw {workspaceRole, linkRole} axes, so a simple MCP display
// keeps the summary while a richer one can tell workspace-shared from link-only (AS-021/022/027).
describe("anchord_read_document — two-axis access on read (doc-access-two-axis S-006)", () => {
  const TWO_AXIS: StoreDoc[] = [
    // Doc X: workspace=commenter, link=viewer → summary "anyone_with_link", workspace-shared too.
    {
      docId: "d_x",
      slug: "doc-x",
      title: "X",
      kind: "markdown",
      workspaceId: "W1",
      role: "owner",
      version: 1,
      content: "x",
      workspaceRole: "commenter",
      linkRole: "viewer",
    },
    // Doc Y: workspace=off, link=viewer → summary "anyone_with_link", but link-ONLY.
    {
      docId: "d_y",
      slug: "doc-y",
      title: "Y",
      kind: "markdown",
      workspaceId: "W1",
      role: "viewer",
      version: 1,
      content: "y",
      workspaceRole: null,
      linkRole: "viewer",
    },
    // Doc W: workspace=commenter, link=off → summary "anyone_in_workspace".
    {
      docId: "d_w",
      slug: "doc-w",
      title: "W",
      kind: "markdown",
      workspaceId: "W1",
      role: "owner",
      version: 1,
      content: "w",
      workspaceRole: "commenter",
      linkRole: null,
    },
  ];

  test("AS-021: a workspace-shared, link-off doc summarizes as 'anyone_in_workspace' + carries raw axes", async () => {
    const { ports } = fakeRead(TWO_AXIS);
    const res = await readDocumentHandler(ports)({ idOrSlug: "d_w" }, ctx());
    expect(res.generalAccess).toBe("anyone_in_workspace");
    expect(res.workspaceRole).toBe("commenter");
    expect(res.linkRole).toBeNull();
  });

  test("AS-022: a link-on doc summarizes as 'anyone_with_link' + carries raw axes", async () => {
    const { ports } = fakeRead(TWO_AXIS);
    const res = await readDocumentHandler(ports)({ idOrSlug: "d_x" }, ctx());
    expect(res.generalAccess).toBe("anyone_with_link");
    expect(res.workspaceRole).toBe("commenter");
    expect(res.linkRole).toBe("viewer");
  });

  test("AS-027: two docs both summarize 'anyone_with_link' but raw axes tell workspace-shared from link-only", async () => {
    const { ports } = fakeRead(TWO_AXIS);
    const x = await readDocumentHandler(ports)({ idOrSlug: "d_x" }, ctx());
    const y = await readDocumentHandler(ports)({ idOrSlug: "d_y" }, ctx());

    // Same lossy summary...
    expect(x.generalAccess).toBe("anyone_with_link");
    expect(y.generalAccess).toBe("anyone_with_link");
    // ...distinguished only by the raw axes (C-008): X is workspace-shared, Y is link-only.
    expect(x.workspaceRole).toBe("commenter");
    expect(y.workspaceRole).toBeNull();
    expect(x.workspaceRole).not.toBe(y.workspaceRole);
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

// ── S-001 (mcp-patch-document): addressable blocks on read_document ──────────
// read_document gains a `blocks: { blockId, sourceText? }[]` array (additive — `content` stays).
// sourceText is the block's SOURCE string (markdown source for md, innerHTML for html); it is
// OMITTED for a non-patchable block (no resolvable source range — GAP-005 fail-closed).

const blockStore = (over: Partial<StoreDoc>): StoreDoc[] => [
  {
    docId: "d_blocks",
    slug: "blocks-doc",
    title: "Blocks Doc",
    kind: "markdown",
    workspaceId: "W1",
    role: "owner",
    version: 1,
    content: "",
    ...over,
  },
];

describe("anchord_read_document — addressable blocks (mcp-patch-document S-001)", () => {
  test("AS-001: markdown read returns per-block source + version + retains content", async () => {
    // A 2-heading markdown doc → block-h2-1 ("## Overview"), block-p-1, block-h2-2 (#Data above).
    const content = "## Overview\n\nFirst paragraph.\n\n## Details\n";
    const { ports } = fakeRead(blockStore({ kind: "markdown", version: 3, content }));
    const res = await readDocumentHandler(ports)({ idOrSlug: "d_blocks" }, ctx());

    expect(res.version).toBe(3);
    // The existing content field is present, unchanged (back-compat).
    expect(res.content).toBe(content);

    const byId = new Map(res.blocks.map((b) => [b.blockId, b]));
    // One entry per addressable block WITH a resolvable source range.
    expect(byId.get("block-h2-1")).toEqual({ blockId: "block-h2-1", sourceText: "## Overview" });
    expect(byId.get("block-h2-2")).toEqual({ blockId: "block-h2-2", sourceText: "## Details" });
    expect(byId.get("block-p-1")).toEqual({ blockId: "block-p-1", sourceText: "First paragraph." });
  });

  test("AS-001: two identical-source markdown blocks disambiguate by distinct ranges (special chars/dupes)", async () => {
    // Two literally-identical "## Overview" blocks must each get their OWN sourceText by id,
    // proving the token.map range (not the text) is the key.
    const content = "## Overview\n\nbody a\n\n## Overview\n\nbody b\n";
    const { ports } = fakeRead(blockStore({ content }));
    const res = await readDocumentHandler(ports)({ idOrSlug: "d_blocks" }, ctx());
    const byId = new Map(res.blocks.map((b) => [b.blockId, b.sourceText]));
    expect(byId.get("block-h2-1")).toBe("## Overview");
    expect(byId.get("block-h2-2")).toBe("## Overview");
  });

  test("AS-002: html read returns per-block source (sourceText = block innerHTML)", async () => {
    // html doc with one <p> ("Hello world") and one <h1>; sourceText = innerHTML, not textContent.
    const content = "<h1>Title</h1><p>Hello world</p>";
    const { ports } = fakeRead(blockStore({ kind: "html", version: 7, content }));
    const res = await readDocumentHandler(ports)({ idOrSlug: "d_blocks" }, ctx());

    expect(res.version).toBe(7);
    const byId = new Map(res.blocks.map((b) => [b.blockId, b]));
    expect(byId.get("block-p-1")).toEqual({ blockId: "block-p-1", sourceText: "Hello world" });
    expect(byId.get("block-h1-1")).toEqual({ blockId: "block-h1-1", sourceText: "Title" });
  });

  test("AS-002: html sourceText keeps inline markup (innerHTML, not textContent)", async () => {
    const content = "<p>Hello <b>world</b></p>";
    const { ports } = fakeRead(blockStore({ kind: "html", content }));
    const res = await readDocumentHandler(ports)({ idOrSlug: "d_blocks" }, ctx());
    const p = res.blocks.find((b) => b.blockId === "block-p-1");
    expect(p?.sourceText).toBe("Hello <b>world</b>");
  });

  test("AS-003: a doc with no addressable blocks returns an empty blocks array (version still returned)", async () => {
    // Inline-only / whitespace content → no block-level elements.
    const { ports } = fakeRead(blockStore({ kind: "markdown", version: 4, content: "   " }));
    const res = await readDocumentHandler(ports)({ idOrSlug: "d_blocks" }, ctx());
    expect(res.blocks).toEqual([]);
    expect(res.version).toBe(4);
  });

  test("AS-003: an image doc (no body text) returns an empty blocks array", async () => {
    const { ports } = fakeRead(
      blockStore({ kind: "image", version: 2, content: "photo.png" }),
    );
    const res = await readDocumentHandler(ports)({ idOrSlug: "d_blocks" }, ctx());
    expect(res.blocks).toEqual([]);
    expect(res.version).toBe(2);
  });

  test("AS-004: an unreadable doc is rejected with no blocks/sourceText leaked", async () => {
    // A doc the token-owner has no role on (restricted, not shared) — auth unchanged from the
    // existing read tool; the rejection must carry no block data.
    const { ports } = fakeRead(
      blockStore({ docId: "d_secret", slug: "secret", role: null, content: "## Secret\n" }),
    );
    await expect(
      readDocumentHandler(ports)({ idOrSlug: "d_secret" }, ctx()),
    ).rejects.toThrow(/not found or not accessible/);
  });

  test("AS-004: a cross-workspace doc is rejected with no block data leaked", async () => {
    // Owner is a W2 member (role resolves) but the token is bound to W1 → reject, no blocks.
    const { ports } = fakeRead(
      blockStore({ workspaceId: "W2", role: "viewer", content: "## W2\n" }),
    );
    await expect(
      readDocumentHandler(ports)({ idOrSlug: "d_blocks" }, ctx({ workspaceId: "W1" })),
    ).rejects.toThrow(/not found or not accessible/);
  });

  test("AS-023: a non-mappable markdown block (table cell, raw-html) omits sourceText; heading keeps it", async () => {
    // md with a heading (patchable), a table (cells td/th carry token.map=null), and a raw <div>
    // block (token-walk id never matches the rendered <div> — GAP-005 fail-closed).
    const content =
      "## Title\n\n| a | b |\n| - | - |\n| c | d |\n\n<div>raw block</div>\n";
    const { ports } = fakeRead(blockStore({ kind: "markdown", content }));
    const res = await readDocumentHandler(ports)({ idOrSlug: "d_blocks" }, ctx());
    const byId = new Map(res.blocks.map((b) => [b.blockId, b]));

    // The heading is patchable — it carries sourceText.
    expect(byId.get("block-h2-1")).toEqual({ blockId: "block-h2-1", sourceText: "## Title" });

    // Table cells: listed by blockId, but OMIT sourceText (non-patchable signal).
    for (const cellId of ["block-td-1", "block-td-2", "block-th-1", "block-th-2"]) {
      expect(byId.has(cellId)).toBe(true);
      expect(byId.get(cellId)).not.toHaveProperty("sourceText");
    }
    // The raw-html <div> block: listed by blockId, sourceText omitted (token-walk↔HTML mismatch).
    expect(byId.has("block-div-1")).toBe(true);
    expect(byId.get("block-div-1")).not.toHaveProperty("sourceText");

    // All blocks are still enumerated by blockId (nothing silently dropped).
    expect(res.blocks.length).toBeGreaterThanOrEqual(7);
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
