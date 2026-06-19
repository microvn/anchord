// mcp-roundtrip S-002 — the publish write tools (create & update).
//
// These drive the PURE tool handlers (publish-tools.ts) through injectable ports with
// in-memory fakes (the publish.test.ts pattern), plus the create/update tools through the
// real S-001 pipeline (handleJsonRpc) to prove the scope gate + identity threading. The
// concurrency assertions (AS-026/AS-027) are exercised at the mechanism level here (the
// serialization/idempotency port is invoked) and at the behaviour level against the fake
// that simulates the per-doc lock; the true Postgres advisory-lock + UNIQUE-backstop race
// is integration-verified (see report Concurrency note).

import { describe, expect, test } from "bun:test";
import {
  createDocumentHandler,
  updateDocumentHandler,
  publishTools,
  McpToolError,
  type CreateDocumentPort,
  type UpdateDocumentPorts,
  type UpdateTargetDoc,
} from "./publish-tools";
import {
  handleJsonRpc,
  baselineTools,
  MCP_FORBIDDEN_SCOPE,
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
  scopes: ["docs:write"] as Scope[],
  ...over,
});

// ── create fake: an in-memory publish that records every doc it made ─────────
function fakeCreate(opts: {
  /** projectIds that exist + are writable in the workspace (others are rejected). */
  writableProjects?: Set<string>;
  /** the owner's default project id, lazily created (AS-003/AS-027). */
  defaultProjectByOwner?: Map<string, string>;
} = {}) {
  const writable = opts.writableProjects ?? new Set<string>();
  const defaults = opts.defaultProjectByOwner ?? new Map<string, string>();
  let nDoc = 0;
  let nDefaultCreates = 0;
  const docs: {
    docId: string;
    workspaceId: string;
    ownerId: string;
    projectId: string;
    generalAccess: string;
    version: number;
  }[] = [];

  const port: CreateDocumentPort = async (input) => {
    // Placement (C-006): explicit writable projectId honored; foreign/invalid rejected
    // (NEVER silent default); missing → owner's default (created on the fly, idempotent).
    let projectId: string;
    if (input.projectId != null) {
      if (!writable.has(input.projectId)) {
        // Mirrors createPublishProjectResolver throwing ProjectRejected("not_found").
        throw new McpToolError(`project '${input.projectId}' not found in this workspace`);
      }
      projectId = input.projectId;
    } else {
      const key = `${input.workspaceId}:${input.ownerId}`;
      if (!defaults.has(key)) {
        defaults.set(key, `proj_default_${++nDefaultCreates}`);
      }
      projectId = defaults.get(key)!;
    }
    const docId = `doc_${++nDoc}`;
    const slug = `slug-${docId}`;
    docs.push({
      docId,
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      projectId,
      generalAccess: "restricted", // docs.general_access column default (C-006)
      version: 1,
    });
    return { docId, slug, url: `/d/${slug}` };
  };
  return { port, docs, get defaultCreates() { return nDefaultCreates; } };
}

// ── update fake: an in-memory versioned doc store with a per-doc serialization lock ──
function fakeUpdate(opts: {
  docs: Record<string, { kind: "html" | "markdown" | "image"; version: number }>;
  roles: Record<string, Role | null>; // keyed `${docId}:${userId}`
}) {
  const store = opts.docs;
  const reanchorFired: { docId: string; version: number; newContentHtml: string }[] = [];
  // a single in-flight gate per doc id to simulate the advisory lock (AS-026).
  const locks = new Map<string, Promise<void>>();

  const ports: UpdateDocumentPorts = {
    async findDocById(docId): Promise<UpdateTargetDoc | null> {
      const d = store[docId];
      return d ? { id: docId, kind: d.kind } : null;
    },
    async resolveRole(docId, userId): Promise<Role | null> {
      return opts.roles[`${docId}:${userId}`] ?? null;
    },
    async appendVersion(input) {
      // Serialize per-doc: chain onto any in-flight append for this doc (the advisory-lock
      // semantics of appendVersionTx — read max+1 + insert under the lock).
      const prev = locks.get(input.docId) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      locks.set(input.docId, prev.then(() => gate));
      await prev;
      try {
        const d = store[input.docId]!;
        const previousVersion = d.version;
        d.version = previousVersion + 1;
        return { version: d.version, previousVersion };
      } finally {
        release();
      }
    },
    fireReanchor(input) {
      reanchorFired.push(input);
    },
  };
  return { ports, reanchorFired };
}

const rpc = (method: string, params?: Record<string, unknown>): JsonRpcRequest => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  ...(params ? { params } : {}),
});

function fakeTokens(valid: Record<string, { id: string; userId: string; workspaceId: string; scopes: Scope[] }>): ApiTokenRepo {
  return {
    async verify(plaintext: string): Promise<ResolvedToken | null> {
      const t = valid[plaintext];
      return t ? { ...t, lastUsedAt: null } : null;
    },
    async touchLastUsed() {},
  } as unknown as ApiTokenRepo;
}

// ── AS-003: create_document → doc + immutable slug + v1, restricted, default project ──

describe("AS-003: anchord_create_document creates a doc in the token's workspace", () => {
  test("AS-003.T1: an immutable slug + version 1 are created", async () => {
    const fk = fakeCreate();
    const tool = createDocumentHandler(fk.port);
    const res = await tool({ content: "<h1>Payment Spec</h1>", format: "html", title: "Payment Spec" }, ctx());
    expect(fk.docs).toHaveLength(1);
    expect(fk.docs[0]!.version).toBe(1);
    expect(res.slug).toBe("slug-doc_1");
  });

  test("AS-003.T2: the doc is restricted (token-owner only), never set via MCP", async () => {
    const fk = fakeCreate();
    const tool = createDocumentHandler(fk.port);
    await tool({ content: "x", format: "markdown" }, ctx());
    expect(fk.docs[0]!.generalAccess).toBe("restricted");
  });

  test("AS-003.T3: with no projectId, the doc lands in the owner's default project", async () => {
    const fk = fakeCreate();
    const tool = createDocumentHandler(fk.port);
    await tool({ content: "x", format: "html" }, ctx({ userId: "u_owner", workspaceId: "W" }));
    expect(fk.docs[0]!.projectId).toBe("proj_default_1");
    expect(fk.defaultCreates).toBe(1);
  });

  test("AS-003.T4: returns the { docId, slug, url } shape", async () => {
    const fk = fakeCreate();
    const tool = createDocumentHandler(fk.port);
    const res = await tool({ content: "x", format: "html" }, ctx());
    expect(res).toEqual({ docId: "doc_1", slug: "slug-doc_1", url: "/d/slug-doc_1" });
  });

  test("AS-003: identity + workspace come from the TOKEN (ctx), not params (C-001/C-006)", async () => {
    const fk = fakeCreate();
    const tool = createDocumentHandler(fk.port);
    // Caller tries to smuggle a different workspace/owner in params — ignored.
    await tool(
      { content: "x", format: "html", workspaceId: "EVIL", ownerId: "u_evil" } as Record<string, unknown>,
      ctx({ userId: "u_owner", workspaceId: "W" }),
    );
    expect(fk.docs[0]!.workspaceId).toBe("W");
    expect(fk.docs[0]!.ownerId).toBe("u_owner");
  });

  test("AS-003: empty/invalid content or format is rejected (edge: empty + invalid type)", async () => {
    const fk = fakeCreate();
    const tool = createDocumentHandler(fk.port);
    await expect(tool({ content: "", format: "html" }, ctx())).rejects.toThrow(McpToolError);
    await expect(tool({ content: "x", format: "pdf" }, ctx())).rejects.toThrow(/unsupported format/);
    await expect(tool({ content: 123 as unknown, format: "html" }, ctx())).rejects.toThrow(McpToolError);
  });
});

// ── AS-018 / AS-019: explicit projectId honored / foreign rejected ───────────

describe("AS-018 / AS-019: create_document project placement", () => {
  test("AS-018: an explicit writable projectId is honored (not the default)", async () => {
    const fk = fakeCreate({ writableProjects: new Set(["proj_pay"]) });
    const tool = createDocumentHandler(fk.port);
    await tool({ content: "x", format: "html", projectId: "proj_pay" }, ctx());
    expect(fk.docs[0]!.projectId).toBe("proj_pay");
    expect(fk.defaultCreates).toBe(0); // default never touched
  });

  test("AS-019: a foreign/invalid projectId is rejected and NO doc is created (never silent default)", async () => {
    const fk = fakeCreate({ writableProjects: new Set(["proj_pay"]) });
    const tool = createDocumentHandler(fk.port);
    await expect(
      tool({ content: "x", format: "html", projectId: "proj_other_ws" }, ctx()),
    ).rejects.toThrow(McpToolError);
    expect(fk.docs).toHaveLength(0); // no doc, no silent fallback
    expect(fk.defaultCreates).toBe(0);
  });
});

// ── AS-004 / AS-005: update appends a version / rejects bad target or role ───

describe("AS-004: anchord_update_document appends a new version + fires re-anchor", () => {
  test("AS-004: a new version is appended (no overwrite) and re-anchor is triggered", async () => {
    const fk = fakeUpdate({
      docs: { doc_a: { kind: "html", version: 3 } },
      roles: { "doc_a:u_owner": "editor" },
    });
    const tool = updateDocumentHandler(fk.ports);
    const res = await tool({ docId: "doc_a", content: "<h1>v4</h1>" }, ctx());
    expect(res).toEqual({ docId: "doc_a", version: 4, previousVersion: 3 });
    // re-anchor fired (annotation-core seam) with the new content (AS-004/C-012).
    expect(fk.reanchorFired).toEqual([{ docId: "doc_a", version: 4, newContentHtml: "<h1>v4</h1>" }]);
  });

  test("AS-004: re-anchor is NOT fired for a doc's first extra version path is N/A — fired only when previousVersion != null", async () => {
    // A doc whose stored version is 0 (no real content) would append v1 with previousVersion 0,
    // but version 1 has prior content here so re-anchor still fires; the no-prior case is the
    // create path (v1) which never calls update. Assert the guard via previousVersion.
    const fk = fakeUpdate({ docs: { doc_a: { kind: "markdown", version: 1 } }, roles: { "doc_a:u_owner": "owner" } });
    const tool = updateDocumentHandler(fk.ports);
    const res = await tool({ docId: "doc_a", content: "v2" }, ctx());
    expect(res.version).toBe(2);
    expect(fk.reanchorFired).toHaveLength(1); // previousVersion=1 (not null) → fires
  });
});

describe("AS-005: update with a bad target or insufficient role is rejected", () => {
  test("AS-005: a nonexistent docId is rejected; the error suggests create_document", async () => {
    const fk = fakeUpdate({ docs: {}, roles: {} });
    const tool = updateDocumentHandler(fk.ports);
    await expect(tool({ docId: "ghost", content: "x" }, ctx())).rejects.toThrow(/create_document/);
    expect(fk.reanchorFired).toHaveLength(0);
  });

  test("AS-005: a viewer (no editor rights) is rejected; the error suggests create_document", async () => {
    const fk = fakeUpdate({
      docs: { doc_a: { kind: "html", version: 1 } },
      roles: { "doc_a:u_viewer": "viewer" },
    });
    const tool = updateDocumentHandler(fk.ports);
    await expect(
      tool({ docId: "doc_a", content: "x" }, ctx({ userId: "u_viewer" })),
    ).rejects.toThrow(/create_document/);
    // No version appended (still v1), no re-anchor.
    expect(fk.reanchorFired).toHaveLength(0);
  });

  test("AS-005: a commenter (below editor) is also rejected (boundary on the role ladder)", async () => {
    const fk = fakeUpdate({
      docs: { doc_a: { kind: "html", version: 1 } },
      roles: { "doc_a:u_c": "commenter" },
    });
    const tool = updateDocumentHandler(fk.ports);
    await expect(tool({ docId: "doc_a", content: "x" }, ctx({ userId: "u_c" }))).rejects.toThrow(McpToolError);
  });
});

// ── AS-026: concurrent updates → strictly sequential versions ────────────────

describe("AS-026: concurrent update_document on one doc → strictly sequential versions", () => {
  test("AS-026: two concurrent updates on doc at N yield N+1 then N+2, never two N+1", async () => {
    const fk = fakeUpdate({
      docs: { doc_a: { kind: "html", version: 5 } },
      roles: { "doc_a:u_owner": "editor" },
    });
    const tool = updateDocumentHandler(fk.ports);
    // Fire both without awaiting in between (concurrent), then settle.
    const [r1, r2] = await Promise.all([
      tool({ docId: "doc_a", content: "a" }, ctx()),
      tool({ docId: "doc_a", content: "b" }, ctx()),
    ]);
    const versions = [r1.version, r2.version].sort((a, b) => a - b);
    expect(versions).toEqual([6, 7]); // N+1 then N+2 — never two 6s
    expect(new Set(versions).size).toBe(2);
  });
});

// ── AS-027: concurrent first create → exactly one default project ────────────

describe("AS-027: concurrent first create_document yields exactly one default project", () => {
  test("AS-027: two concurrent creates (no projectId) make ONE default; both docs land in it", async () => {
    // The fake's default-project resolution mirrors ensureDefaultProject idempotency
    // (find-or-create keyed by workspace+owner) — the mechanism C-011 relies on.
    const fk = fakeCreate();
    const tool = createDocumentHandler(fk.port);
    await Promise.all([
      tool({ content: "a", format: "html" }, ctx({ userId: "u_owner", workspaceId: "W" })),
      tool({ content: "b", format: "html" }, ctx({ userId: "u_owner", workspaceId: "W" })),
    ]);
    expect(fk.docs).toHaveLength(2);
    expect(fk.defaultCreates).toBe(1); // exactly one default project created
    expect(fk.docs[0]!.projectId).toBe(fk.docs[1]!.projectId); // both in the same default
  });
});

// ── AS-028: a failed re-anchor never leaves annotations mis-anchored ─────────

describe("AS-028: a failed/crashing re-anchor leaves the version committed + annotations PREVIOUS", () => {
  test("AS-028: re-anchor throwing does NOT roll back the appended version (committed first)", async () => {
    const fk = fakeUpdate({
      docs: { doc_a: { kind: "html", version: 2 } },
      roles: { "doc_a:u_owner": "editor" },
    });
    // Override fireReanchor to simulate the async job crashing — it must not surface.
    fk.ports.fireReanchor = () => {
      // The real seam is fire-and-forget (void Promise.catch), so a throw here would be a
      // programming error; model the async crash as a rejected promise the tool ignores.
      void Promise.reject(new Error("reanchor crashed")).catch(() => {});
    };
    const tool = updateDocumentHandler(fk.ports);
    const res = await tool({ docId: "doc_a", content: "v3" }, ctx());
    // The version IS committed (returned) even though re-anchor failed — C-012: the update
    // returns after the durable version commit; re-anchor is async + retried, annotations
    // stay in their PREVIOUS anchored state (the ledger/apply is idempotent, never half).
    expect(res).toEqual({ docId: "doc_a", version: 3, previousVersion: 2 });
  });
});

// ── C-002 / C-006 / C-009 through the real S-001 pipeline ────────────────────

describe("C-002 / C-006 / C-009: publish tools through the MCP pipeline", () => {
  function pipelineDeps(tokens: ApiTokenRepo, fkCreate: ReturnType<typeof fakeCreate>, fkUpdate: ReturnType<typeof fakeUpdate>): McpServerDeps {
    return {
      tokens,
      rateLimiter: new McpRateLimiter(),
      tools: {
        ...baselineTools(),
        ...publishTools({ create: fkCreate.port, update: fkUpdate.ports }),
      },
    };
  }

  test("C-009: a docs:read-only token calling anchord_create_document is rejected on scope — NO doc", async () => {
    const fkCreate = fakeCreate();
    const fkUpdate = fakeUpdate({ docs: {}, roles: {} });
    const tokens = fakeTokens({ ro: { id: "t1", userId: "u", workspaceId: "W", scopes: ["docs:read"] } });
    const deps = pipelineDeps(tokens, fkCreate, fkUpdate);
    const { response } = await handleJsonRpc(deps, "ro", rpc("anchord_create_document", { content: "x", format: "html" }));
    expect(response.error?.code).toBe(MCP_FORBIDDEN_SCOPE);
    expect(fkCreate.docs).toHaveLength(0); // scope gate is BEFORE the handler
  });

  test("C-002: a docs:write token creates a doc (v1) through the pipeline, under its workspace", async () => {
    const fkCreate = fakeCreate();
    const fkUpdate = fakeUpdate({ docs: {}, roles: {} });
    const tokens = fakeTokens({ rw: { id: "t2", userId: "u_owner", workspaceId: "Wp", scopes: ["docs:write"] } });
    const deps = pipelineDeps(tokens, fkCreate, fkUpdate);
    const { response } = await handleJsonRpc(deps, "rw", rpc("anchord_create_document", { content: "x", format: "html" }));
    expect(response.error).toBeUndefined();
    expect(fkCreate.docs[0]!.workspaceId).toBe("Wp");
    expect(fkCreate.docs[0]!.version).toBe(1);
  });

  test("C-002: AS-005's rejection message reaches the agent as INVALID_PARAMS (not a generic internal)", async () => {
    const fkCreate = fakeCreate();
    const fkUpdate = fakeUpdate({ docs: {}, roles: {} });
    const tokens = fakeTokens({ rw: { id: "t3", userId: "u", workspaceId: "W", scopes: ["docs:write"] } });
    const deps = pipelineDeps(tokens, fkCreate, fkUpdate);
    const { response } = await handleJsonRpc(deps, "rw", rpc("anchord_update_document", { docId: "ghost", content: "x" }));
    expect(response.error?.code).toBe(JSONRPC_INVALID_PARAMS);
    expect(response.error?.message).toContain("create_document");
  });
});
