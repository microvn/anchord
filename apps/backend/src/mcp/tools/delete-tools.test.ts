// doc-delete-trash S-005 — the MCP delete/restore tools + the deleted-doc exclusion.
//
// Drives the PURE tool handlers (delete-tools.ts) through injectable ports with in-memory fakes
// (the read-tools.test.ts / publish-tools.test.ts pattern), plus the tools through the real
// mcp-roundtrip S-001 pipeline (handleJsonRpc) to prove the scope gate (docs:write).
//
// The fakes simulate the EXISTING soft-delete/restore services + the workspace-scoped resolver:
//   • resolveInWorkspace mirrors the real C-007 binding — a doc is returned ONLY when it lives
//     in the requested workspace, so a W-X token never resolves a W-Y doc (AS-029).
//   • softDelete/restore raise the real service's DocDeleteRejected on a too-low role, so the
//     handler's owner-or-editor refusal (AS-030) is exercised end-to-end.
// The exclusion scenarios (AS-017/018/019) drive the read/pull handlers with a deleted doc to
// prove it never surfaces: list filters it server-side, pull/read refuse via the deleted role.

import { describe, expect, test } from "bun:test";
import {
  deleteDocumentHandler,
  restoreDocumentHandler,
  deleteTools,
  type DeleteToolsPorts,
  type ResolvedDeletableDoc,
} from "./delete-tools";
import { McpToolError } from "./publish-tools";
import { listDocumentsHandler, readDocumentHandler, type ReadPorts, type ResolvedReadDoc, type DocumentSummary } from "./read-tools";
import { pullAnnotationsHandler, type PullPorts } from "./pull-tools";
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
  scopes: ["docs:write"] as Scope[],
  ...over,
});

const rpc = (method: string, params?: Record<string, unknown>): JsonRpcRequest => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  ...(params ? { params } : {}),
});

// The existing service's rejection, recreated here (structurally recognized by `name`).
class DocDeleteRejected extends Error {
  constructor(message: string, readonly code: "not_found" | "forbidden") {
    super(message);
    this.name = "DocDeleteRejected";
  }
}

interface FakeDoc {
  id: string;
  slug: string;
  workspaceId: string;
  /** the token-owner's per-doc role (resolveAccess seam) — null = no grant. */
  role: Role | null;
  deleted?: boolean;
}

/**
 * A fake DeleteToolsPorts that mirrors the real services: resolveInWorkspace is workspace-scoped
 * (C-007), and softDelete/restore apply the owner-or-editor gate (raising DocDeleteRejected on a
 * too-low role, like the real deleteDoc/restoreDoc). Records calls for assertions.
 */
function fakeDeletePorts(store: FakeDoc[]): {
  ports: DeleteToolsPorts;
  store: FakeDoc[];
  calls: { softDelete: string[]; restore: string[] };
} {
  const calls = { softDelete: [] as string[], restore: [] as string[] };
  const canEdit = (r: Role | null) => r === "owner" || r === "editor";
  const ports: DeleteToolsPorts = {
    async resolveInWorkspace(idOrSlug, workspaceId): Promise<ResolvedDeletableDoc | null> {
      // C-007: scoped to the workspace — a doc in another workspace is NOT returned (AS-029).
      const d = store.find(
        (x) => (x.id === idOrSlug || x.slug === idOrSlug) && x.workspaceId === workspaceId,
      );
      return d ? { id: d.id, slug: d.slug, workspaceId: d.workspaceId } : null;
    },
    async softDelete({ slug, actorId }) {
      const d = store.find((x) => x.slug === slug);
      if (!d) throw new DocDeleteRejected("doc not found", "not_found");
      // owner-or-editor gate (no admin arm over MCP — C-003).
      if (!canEdit(d.role)) {
        throw new DocDeleteRejected("insufficient permission to delete this doc", "forbidden");
      }
      calls.softDelete.push(d.id);
      d.deleted = true; // idempotent in the real service via the conditional UPDATE.
      return { docId: d.id, slug: d.slug };
    },
    async restore({ workspaceId, docId, actorId }) {
      const d = store.find((x) => x.id === docId && x.workspaceId === workspaceId && x.deleted);
      // findDeletedById is workspace-scoped; an unreachable doc → not-found.
      if (!d) throw new DocDeleteRejected("doc not found", "not_found");
      if (!canEdit(d.role)) {
        throw new DocDeleteRejected("insufficient permission to restore this doc", "forbidden");
      }
      calls.restore.push(d.id);
      d.deleted = false;
      // private-on-restore + restorer's default project (AS-031) — the service's job; the tool
      // only surfaces the result.
      return { docId: d.id, slug: d.slug, projectId: "p_default" };
    },
  };
  return { ports, store, calls };
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

// ── anchord_delete_document ────────────────────────────────────────────────

describe("anchord_delete_document", () => {
  test("AS-016: owner/editor token deletes by slug — delegates to the existing soft-delete service", async () => {
    const owned: FakeDoc = { id: "d1", slug: "spec-v1", workspaceId: "W1", role: "owner" };
    const { ports, store, calls } = fakeDeletePorts([owned]);

    const res = await deleteDocumentHandler(ports)({ idOrSlug: "spec-v1" }, ctx());
    expect(res).toEqual({ docId: "d1", slug: "spec-v1", deleted: true });
    // The existing service was called (not reimplemented) and the doc is tombstoned.
    expect(calls.softDelete).toEqual(["d1"]);
    expect(store[0].deleted).toBe(true);
  });

  test("AS-016: deletes by id too (slug OR id resolved — GAP-001)", async () => {
    const owned: FakeDoc = { id: "d1", slug: "spec-v1", workspaceId: "W1", role: "editor" };
    const { ports, calls } = fakeDeletePorts([owned]);
    const res = await deleteDocumentHandler(ports)({ idOrSlug: "d1" }, ctx());
    expect(res.docId).toBe("d1");
    expect(calls.softDelete).toEqual(["d1"]);
  });

  test("AS-029: a W1 token cannot reach a W2 doc — refused as not-found, doc stays active", async () => {
    // The owner is also a (admin) member of W2; the target doc lives in W2.
    const w2doc: FakeDoc = { id: "d_y", slug: "y-doc", workspaceId: "W2", role: "owner" };
    const { ports, store, calls } = fakeDeletePorts([w2doc]);

    // by slug
    await expect(deleteDocumentHandler(ports)({ idOrSlug: "y-doc" }, ctx({ workspaceId: "W1" }))).rejects.toThrow(
      McpToolError,
    );
    // by id
    await expect(deleteDocumentHandler(ports)({ idOrSlug: "d_y" }, ctx({ workspaceId: "W1" }))).rejects.toThrow(
      McpToolError,
    );
    // never reached the service; the Y doc stays active.
    expect(calls.softDelete).toEqual([]);
    expect(store[0].deleted).toBeUndefined();
  });

  test("AS-030: a commenter token is refused for insufficient permission — doc stays active", async () => {
    const commented: FakeDoc = { id: "d1", slug: "spec-v1", workspaceId: "W1", role: "commenter" };
    const { ports, store, calls } = fakeDeletePorts([commented]);
    await expect(deleteDocumentHandler(ports)({ idOrSlug: "spec-v1" }, ctx())).rejects.toThrow(
      /insufficient permission/,
    );
    expect(calls.softDelete).toEqual([]);
    expect(store[0].deleted).toBeUndefined();
  });

  test("AS-030: a viewer token is refused too", async () => {
    const viewed: FakeDoc = { id: "d1", slug: "spec-v1", workspaceId: "W1", role: "viewer" };
    const { ports, store } = fakeDeletePorts([viewed]);
    await expect(deleteDocumentHandler(ports)({ idOrSlug: "spec-v1" }, ctx())).rejects.toThrow(McpToolError);
    expect(store[0].deleted).toBeUndefined();
  });

  test("requires idOrSlug", async () => {
    const { ports } = fakeDeletePorts([]);
    await expect(deleteDocumentHandler(ports)({}, ctx())).rejects.toThrow(McpToolError);
  });
});

// ── anchord_restore_document ───────────────────────────────────────────────

describe("anchord_restore_document", () => {
  test("AS-031: owner/editor restores a deleted doc — delegates to the existing restore service", async () => {
    const deleted: FakeDoc = { id: "d1", slug: "spec-v1", workspaceId: "W1", role: "owner", deleted: true };
    const { ports, store, calls } = fakeDeletePorts([deleted]);

    const res = await restoreDocumentHandler(ports)({ idOrSlug: "d1" }, ctx());
    // restored into the restorer's default project (the service's job), reported back by the tool.
    expect(res).toEqual({ docId: "d1", slug: "spec-v1", projectId: "p_default", restored: true });
    expect(calls.restore).toEqual(["d1"]);
    expect(store[0].deleted).toBe(false);
  });

  test("AS-031: restore resolves by slug too", async () => {
    const deleted: FakeDoc = { id: "d1", slug: "spec-v1", workspaceId: "W1", role: "editor", deleted: true };
    const { ports, calls } = fakeDeletePorts([deleted]);
    const res = await restoreDocumentHandler(ports)({ idOrSlug: "spec-v1" }, ctx());
    expect(res.restored).toBe(true);
    expect(calls.restore).toEqual(["d1"]);
  });

  test("AS-029: restore cannot reach another workspace's tombstone — not-found", async () => {
    const w2deleted: FakeDoc = { id: "d_y", slug: "y-doc", workspaceId: "W2", role: "owner", deleted: true };
    const { ports, store, calls } = fakeDeletePorts([w2deleted]);
    await expect(restoreDocumentHandler(ports)({ idOrSlug: "d_y" }, ctx({ workspaceId: "W1" }))).rejects.toThrow(
      McpToolError,
    );
    expect(calls.restore).toEqual([]);
    expect(store[0].deleted).toBe(true); // still in W2's Trash
  });

  test("AS-030: a commenter token is refused on restore — doc stays in Trash", async () => {
    const deleted: FakeDoc = { id: "d1", slug: "spec-v1", workspaceId: "W1", role: "commenter", deleted: true };
    const { ports, store } = fakeDeletePorts([deleted]);
    await expect(restoreDocumentHandler(ports)({ idOrSlug: "d1" }, ctx())).rejects.toThrow(McpToolError);
    expect(store[0].deleted).toBe(true);
  });
});

// ── pipeline: scope gate (docs:write) + identity threading ──────────────────

describe("delete/restore tools through the S-001 pipeline", () => {
  function deps(scopes: Scope[]): { server: McpServerDeps; store: FakeDoc[] } {
    const doc: FakeDoc = { id: "d1", slug: "spec-v1", workspaceId: "W1", role: "owner" };
    const { ports, store } = fakeDeletePorts([doc]);
    const server: McpServerDeps = {
      tokens: fakeTokens({ tok: { id: "t1", userId: "u_owner", workspaceId: "W1", scopes } }),
      rateLimiter: new McpRateLimiter(),
      tools: deleteTools(ports),
    };
    return { server, store };
  }

  test("AS-016: a docs:write token deletes through the pipeline", async () => {
    const { server, store } = deps(["docs:write"]);
    const { response } = await handleJsonRpc(server, "tok", rpc("anchord_delete_document", { idOrSlug: "spec-v1" }));
    expect(response.error).toBeUndefined();
    expect((response.result as { deleted: boolean }).deleted).toBe(true);
    expect(store[0].deleted).toBe(true);
  });

  test("AS-030/scope: a read-only token is rejected by the scope gate (no side effect)", async () => {
    const { server, store } = deps(["docs:read"]);
    const { response } = await handleJsonRpc(server, "tok", rpc("anchord_delete_document", { idOrSlug: "spec-v1" }));
    expect(response.error?.code).toBe(MCP_FORBIDDEN_SCOPE);
    expect(store[0].deleted).toBeUndefined(); // never tombstoned
  });
});

// ── exclusion: deleted docs never surface on list / pull / read (C-002) ─────
//
// AS-017 (list): the workspace-wide read filters deleted docs server-side (the real SQL adds
//   `deleted_at IS NULL`); the fake mirrors that — a deleted doc is simply absent.
// AS-018 (pull) + AS-019 (read): both go through resolveAccess, which (doc-delete-trash S-004)
//   returns a null role / canView=false for a deleted doc → the handler refuses. These prove the
//   MCP read/pull paths inherit the single deletion chokepoint rather than re-deriving access.

describe("MCP excludes deleted docs (C-002)", () => {
  test("AS-017: anchord_list_documents omits a deleted doc among active ones", async () => {
    // The list port mirrors the real workspace-wide read: deleted docs are filtered server-side.
    const rows: Array<DocumentSummary & { deleted?: boolean }> = [
      { docId: "a1", slug: "active-1", title: "Active 1", kind: "html" },
      { docId: "a2", slug: "active-2", title: "Active 2", kind: "markdown" },
      { docId: "x1", slug: "gone", title: "Deleted", kind: "html", deleted: true },
    ];
    const ports: Pick<ReadPorts, "listAccessibleDocs"> = {
      async listAccessibleDocs(input) {
        const visible = rows.filter((r) => !r.deleted); // deleted_at IS NULL in the real SQL
        const items = visible
          .slice(input.offset, input.offset + input.limit)
          .map(({ deleted, ...d }) => d);
        return { items, total: visible.length };
      },
    };
    const res = await listDocumentsHandler(ports as ReadPorts)({}, ctx({ scopes: ["docs:read"] as Scope[] }));
    const ids = res.items.map((i) => i.docId);
    expect(ids).toEqual(["a1", "a2"]);
    expect(ids).not.toContain("x1");
    expect(res.pagination.total).toBe(2);
  });

  test("AS-019: anchord_read_document refuses a deleted doc (resolveAccess → null role → not-found)", async () => {
    // A deleted doc resolves with role null (the doc-delete-trash S-004 deletion chokepoint inside
    // resolveAccess). The read handler treats a null role identically to not-found (no disclosure).
    const ports: Pick<ReadPorts, "findReadableDoc"> = {
      async findReadableDoc(idOrSlug): Promise<ResolvedReadDoc | null> {
        return {
          docId: "d1",
          slug: "gone",
          title: "Deleted",
          kind: "html",
          version: 1,
          content: "<p>secret</p>",
          workspaceId: "W1",
          role: null, // deleted → resolveAccess returns role null / canView false (S-004)
          workspaceRole: null,
          linkRole: null,
        };
      },
    };
    await expect(
      readDocumentHandler(ports as ReadPorts)({ idOrSlug: "gone" }, ctx({ scopes: ["docs:read"] as Scope[] })),
    ).rejects.toThrow(McpToolError);
  });

  test("AS-018: anchord_pull_annotations refuses a deleted doc — no annotations leak", async () => {
    // pull authorizes via resolveRole (= resolveAccess); a deleted doc → null role → refused
    // BEFORE any annotation read, so no annotation from the deleted doc is ever returned.
    let listed = false;
    const ports: PullPorts = {
      async resolveRole() {
        return null; // deleted doc → resolveAccess returns null role (S-004)
      },
      async listAllByDoc() {
        listed = true;
        return [];
      },
      async listAllCommentsByDoc() {
        listed = true;
        return [];
      },
    };
    await expect(
      pullAnnotationsHandler(ports)({ docId: "d_deleted" }, ctx({ scopes: ["annotations:read"] as Scope[] })),
    ).rejects.toThrow(McpToolError);
    // refused at the gate — the annotation repo was never queried (nothing could leak).
    expect(listed).toBe(false);
  });
});
