// mcp-roundtrip S-006 — the project tools (list_projects / read_project / create_project).
//
// Drive the PURE tool handlers (project-tools.ts) through injectable ports with in-memory
// fakes (the read-tools.test.ts / publish-tools.test.ts pattern), plus the tools through the
// real S-001 pipeline (handleJsonRpc) to prove the scope gate (projects:read / projects:write —
// C-009/AS-016) and the cross-tenant binding (C-010/C-013): a token bound to W1 never surfaces
// a W2 project across list/read, and a foreign projectId is rejected-not-disclosed (AS-014/AS-017).
//
// The concrete Drizzle reads (listActive / findById / insert over createProjectRepo) are
// integration-verified in project-tools-wiring.ts; here the fake store simulates them so the
// access-scoping logic (C-010 workspace-member visibility, no per-owner ACL) is unit-tested
// without a DB.

import { describe, expect, test } from "bun:test";
import {
  listProjectsHandler,
  readProjectHandler,
  createProjectHandler,
  projectTools,
  type ProjectPorts,
  type ProjectSummary,
} from "./project-tools";
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

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  userId: "u_owner",
  workspaceId: "W1",
  scopes: ["projects:read"] as Scope[],
  ...over,
});

const rpc = (method: string, params?: Record<string, unknown>): JsonRpcRequest => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  ...(params ? { params } : {}),
});

// ── fake store: active projects across W1 + W2 (+ an archived W1 project) ────
// AS-014 data: W1 has several active projects (some owned by the token-owner, some by other
// members — workspace-member visibility means BOTH are returned) + a project in W2 (never
// appears). AS-017 data: a W1 project P + a W2 projectId (rejected, not disclosed).

interface StoreProject extends ProjectSummary {
  workspaceId: string;
  archived: boolean;
}

function fakeProjects(seed: StoreProject[]): {
  ports: ProjectPorts;
  calls: { listWs: string[]; findWs: string[]; createWs: string[] };
  store: StoreProject[];
} {
  const store = [...seed];
  const calls = { listWs: [] as string[], findWs: [] as string[], createWs: [] as string[] };
  const summary = (p: StoreProject): ProjectSummary => ({ projectId: p.projectId, name: p.name });
  const ports: ProjectPorts = {
    async listActiveProjects(input) {
      calls.listWs.push(input.workspaceId);
      // The real read is workspace-scoped (C-013) AND active-only (C-010 / listActive); the
      // fake mirrors that contract — no per-owner filter (workspace-member visibility).
      return store
        .filter((p) => p.workspaceId === input.workspaceId && !p.archived)
        .map(summary);
    },
    async findProjectById(input) {
      calls.findWs.push(input.workspaceId);
      // Scoped by the token's workspace (C-013): a project in another workspace is invisible
      // here (returns null), so the handler rejects it identically to "does not exist".
      const p = store.find(
        (x) => x.projectId === input.projectId && x.workspaceId === input.workspaceId && !x.archived,
      );
      return p ? summary(p) : null;
    },
    async createProject(input) {
      calls.createWs.push(input.workspaceId);
      const created: StoreProject = {
        projectId: `p_new_${store.length}`,
        name: input.name,
        workspaceId: input.workspaceId,
        archived: false,
      };
      store.push(created);
      return summary(created);
    },
  };
  return { ports, calls, store };
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

const STORE: StoreProject[] = [
  { projectId: "p_w1_a", name: "Payments", workspaceId: "W1", archived: false },
  // Owned by a DIFFERENT member — must still be visible (workspace-member visibility, C-010).
  { projectId: "p_w1_b", name: "Onboarding", workspaceId: "W1", archived: false },
  // Archived W1 project — never in the active list.
  { projectId: "p_w1_arch", name: "Legacy", workspaceId: "W1", archived: true },
  // A project in ANOTHER workspace — must never appear / be disclosed (C-010/C-013).
  { projectId: "p_w2", name: "W2 Secret Project", workspaceId: "W2", archived: false },
];

describe("anchord_list_projects", () => {
  test("AS-014: returns the active projects of the token's workspace (workspace-member visibility)", async () => {
    const { ports, calls } = fakeProjects(STORE);
    const res = await listProjectsHandler(ports)({}, ctx());
    const ids = res.items.map((i) => i.projectId);
    // T1: BOTH W1 active projects (regardless of owner — no per-owner ACL); archived absent.
    expect(ids).toEqual(["p_w1_a", "p_w1_b"]);
    expect(ids).not.toContain("p_w1_arch");
    // T2: a project in another workspace never appears (C-010/C-013).
    expect(ids).not.toContain("p_w2");
    // C-013: the read was scoped by the TOKEN's workspace (ctx), not an ambient/path one.
    expect(calls.listWs).toEqual(["W1"]);
  });

  test("AS-014: list is paginated by page + limit returning {items, pagination}", async () => {
    const many: StoreProject[] = [1, 2, 3].map((n) => ({
      projectId: `p${n}`,
      name: `Project ${n}`,
      workspaceId: "W1",
      archived: false,
    }));
    const { ports } = fakeProjects(many);
    const page1 = await listProjectsHandler(ports)({ page: 1, limit: 2 }, ctx());
    expect(page1.items.map((i) => i.projectId)).toEqual(["p1", "p2"]);
    expect(page1.pagination).toEqual({ page: 1, limit: 2, total: 3 });
    const page2 = await listProjectsHandler(ports)({ page: 2, limit: 2 }, ctx());
    expect(page2.items.map((i) => i.projectId)).toEqual(["p3"]);
    expect(page2.pagination).toEqual({ page: 2, limit: 2, total: 3 });
  });

  test("AS-014: defaults page/limit and clamps invalid input (boundary/invalid type)", async () => {
    const { ports } = fakeProjects(STORE);
    const res = await listProjectsHandler(ports)({ page: -5, limit: "oops" }, ctx());
    expect(res.pagination.page).toBe(1);
    expect(res.pagination.limit).toBe(20);
    const big = await listProjectsHandler(ports)({ limit: 9999 }, ctx());
    expect(big.pagination.limit).toBe(100); // MAX_LIMIT
  });

  test("AS-014: a W1 token never lists a W2 project (cross-tenant, C-013)", async () => {
    const { ports, calls } = fakeProjects(STORE);
    const res = await listProjectsHandler(ports)({}, ctx({ workspaceId: "W2" }));
    // With a W2 token, ONLY the W2 project is visible — proving the gate is the token's ws.
    expect(res.items.map((i) => i.projectId)).toEqual(["p_w2"]);
    expect(calls.listWs).toEqual(["W2"]);
  });
});

describe("anchord_read_project", () => {
  test("AS-017: reads an active project in the token's workspace by id", async () => {
    const { ports } = fakeProjects(STORE);
    const res = await readProjectHandler(ports)({ projectId: "p_w1_a" }, ctx());
    expect(res.projectId).toBe("p_w1_a");
    expect(res.name).toBe("Payments");
  });

  test("AS-017: a projectId from another workspace is rejected, not disclosed (C-010/C-013)", async () => {
    const { ports } = fakeProjects(STORE);
    // The owner could be a W2 member, but the W1 token must never surface the W2 project.
    await expect(
      readProjectHandler(ports)({ projectId: "p_w2" }, ctx({ workspaceId: "W1" })),
    ).rejects.toThrow(McpToolError);
    // And it IS readable with a W2-bound token (proves the gate is the token's ws).
    const w2 = await readProjectHandler(ports)({ projectId: "p_w2" }, ctx({ workspaceId: "W2" }));
    expect(w2.projectId).toBe("p_w2");
  });

  test("AS-017: a nonexistent projectId is rejected identically (existence-hiding)", async () => {
    const { ports } = fakeProjects(STORE);
    await expect(readProjectHandler(ports)({ projectId: "p_nope" }, ctx())).rejects.toThrow(
      McpToolError,
    );
  });

  test("AS-017: missing/empty projectId is rejected (null/empty input)", async () => {
    const { ports } = fakeProjects(STORE);
    await expect(readProjectHandler(ports)({}, ctx())).rejects.toThrow(McpToolError);
    await expect(readProjectHandler(ports)({ projectId: "" }, ctx())).rejects.toThrow(McpToolError);
  });
});

describe("anchord_create_project", () => {
  test("AS-015: creates a project in the token's workspace owned by the token-owner, returns {projectId, name}", async () => {
    const { ports, calls, store } = fakeProjects(STORE);
    const res = await createProjectHandler(ports)({ name: "Payments revamp" }, ctx());
    expect(res.projectId).toBeString();
    expect(res.name).toBe("Payments revamp");
    // C-010: created in the TOKEN's workspace (W1), not params.
    expect(calls.createWs).toEqual(["W1"]);
    // The new project is real (could be passed to create_document) and lives in W1.
    const created = store.find((p) => p.projectId === res.projectId);
    expect(created?.workspaceId).toBe("W1");
    expect(created?.name).toBe("Payments revamp");
  });

  test("AS-015: a whitespace-trimmed name is used; an empty/blank name is rejected (null/empty input)", async () => {
    const { ports } = fakeProjects(STORE);
    const res = await createProjectHandler(ports)({ name: "  Spaced  " }, ctx());
    expect(res.name).toBe("Spaced");
    await expect(createProjectHandler(ports)({ name: "   " }, ctx())).rejects.toThrow(McpToolError);
    await expect(createProjectHandler(ports)({}, ctx())).rejects.toThrow(McpToolError);
  });

  test("AS-015: a project name carrying special characters is preserved (special chars)", async () => {
    const { ports } = fakeProjects(STORE);
    const res = await createProjectHandler(ports)({ name: "Q3 — Café & <Payments> 💳" }, ctx());
    expect(res.name).toBe("Q3 — Café & <Payments> 💳");
  });
});

// ── pipeline-level: the scope gate (C-009/AS-016) + identity threading through handleJsonRpc ─

describe("project tools through the S-001 pipeline", () => {
  const deps = (scopes: Scope[]): McpServerDeps => ({
    tokens: fakeTokens({
      tok: { id: "t1", userId: "u_owner", workspaceId: "W1", scopes },
    }),
    rateLimiter: new McpRateLimiter(),
    tools: projectTools(fakeProjects(STORE).ports),
  });

  test("C-010: list/read run under the token's workspace and return only its active projects", async () => {
    const server = deps(["projects:read"]);
    const list = await handleJsonRpc(server, "tok", rpc("anchord_list_projects"));
    const result = list.response.result as { items: ProjectSummary[] };
    expect(result.items.map((i) => i.projectId)).toEqual(["p_w1_a", "p_w1_b"]);
    expect(list.response.error).toBeUndefined();
  });

  test("AS-016: anchord_create_project without projects:write is rejected at the scope gate (no project created)", async () => {
    const fake = fakeProjects(STORE);
    const server: McpServerDeps = {
      tokens: fakeTokens({ tok: { id: "t1", userId: "u_owner", workspaceId: "W1", scopes: ["projects:read"] } }),
      rateLimiter: new McpRateLimiter(),
      tools: projectTools(fake.ports),
    };
    const res = await handleJsonRpc(server, "tok", rpc("anchord_create_project", { name: "Blocked" }));
    expect(res.response.error?.code).toBe(MCP_FORBIDDEN_SCOPE);
    expect(res.response.result).toBeUndefined();
    // No project was created — the handler never ran (gate is BEFORE dispatch).
    expect(fake.calls.createWs).toEqual([]);
  });

  test("AS-016: a projects:write token CAN create a project through the pipeline", async () => {
    const server = deps(["projects:write"]);
    const res = await handleJsonRpc(server, "tok", rpc("anchord_create_project", { name: "Allowed" }));
    expect(res.response.error).toBeUndefined();
    expect((res.response.result as ProjectSummary).name).toBe("Allowed");
  });

  test("C-013: a projects:read token cannot read another workspace's project through the pipeline", async () => {
    const server = deps(["projects:read"]);
    const res = await handleJsonRpc(server, "tok", rpc("anchord_read_project", { projectId: "p_w2" }));
    expect(res.response.error).toBeDefined();
  });
});
