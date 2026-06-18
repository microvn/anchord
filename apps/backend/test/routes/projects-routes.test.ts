// In-process route tests for the workspace-project S-003 /api/projects mount (no DB).
// HTTP GLUE only — envelope + auth gate + Zod + ProjectRejected→DomainError mapping +
// the access-filtered browse — via app.handle(Request)→Response with fake repos. The
// real-Postgres path (default project on join, publish-into-project) is covered by
// test/integration/projects.itest.ts.
//
// AS map (workspace-project S-003):
//   AS-005  member creates a project → 201 { id, name }; owner = the session actor.
//   AS-006  browse a project → only access-visible docs; out-of-access doc ABSENT.
//   AS-007  archive hides a project from the default list; unarchive shows it.
//   C-002   any member creates; a non-owner member cannot archive someone else's project.
//   C-005   archived project gone from default list; back after unarchive.

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import {
  ProjectRejected,
  type ProjectRepo,
  type ProjectRow,
} from "../../src/workspace/projects";
import type { ProjectsRouteRepo, ProjectDocRow } from "../../src/workspace/repo";
import type { SessionResolver, WorkspaceRoleResolver } from "../../src/http/auth-gate";

const WS = "ws_1";
const asUser = (userId: string): SessionResolver => async () => ({ userId });
const noSession: SessionResolver = async () => null;

function fakeRepo(seed: ProjectRow[] = []) {
  let n = seed.length;
  const state = { projects: [...seed], docCounts: new Map<string, number>() };
  const repo: ProjectRepo = {
    async insert(input) {
      const row: ProjectRow = {
        id: `p_${++n}`,
        workspaceId: input.workspaceId,
        name: input.name,
        ownerId: input.ownerId,
        isDefault: input.isDefault,
        archivedAt: null,
      };
      state.projects.push(row);
      return row;
    },
    async findById(ws, id) {
      return state.projects.find((p) => p.workspaceId === ws && p.id === id) ?? null;
    },
    async findDefaultFor(ws, owner) {
      return (
        state.projects.find((p) => p.workspaceId === ws && p.ownerId === owner && p.isDefault) ??
        null
      );
    },
    async listActive(ws) {
      return state.projects.filter((p) => p.workspaceId === ws && p.archivedAt == null);
    },
    async listAll(ws) {
      return state.projects.filter((p) => p.workspaceId === ws);
    },
    async setName(id, name) {
      const p = state.projects.find((x) => x.id === id);
      if (p) p.name = name;
    },
    async setArchivedAt(id, at) {
      const p = state.projects.find((x) => x.id === id);
      if (p) p.archivedAt = at;
    },
    async countDocs(id) {
      return state.docCounts.get(id) ?? 0;
    },
    async delete(id) {
      state.projects = state.projects.filter((p) => p.id !== id);
    },
  };
  return { repo, state };
}

// workspaces S-006: the ctx now only supplies the per-doc invite check + docs-in-project.
// The workspace id + the actor's admin flag come from the path-scoped gate, so the test
// fixture's `admins` drives resolveWorkspaceRole ("admin" vs "member") instead.
function fakeCtx(opts: {
  invited?: Set<string>;
  docs?: Map<string, ProjectDocRow[]>;
}): ProjectsRouteRepo {
  return {
    async isInvited(docId, userId) {
      return !!opts.invited?.has(`${docId}:${userId}`);
    },
    async docsInProject(projectId) {
      return opts.docs?.get(projectId) ?? [];
    },
  };
}

function buildApp(
  resolveSession: SessionResolver,
  repo: ProjectRepo,
  ctx: ProjectsRouteRepo,
  opts: { admins?: Set<string> } = {},
) {
  const resolveWorkspaceRole: WorkspaceRoleResolver = async (_ws, userId) =>
    opts.admins?.has(userId) ? "admin" : "member";
  return createApp({
    dbCheck: async () => {},
    projects: { repo, ctx, resolveSession, resolveWorkspaceRole },
  });
}

function req(method: string, path: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("/api/projects route glue (workspace-project S-003)", () => {
  test("AS-005: a member creates a project → 201 { id, name }; owner = session actor", async () => {
    const f = fakeRepo();
    const app = buildApp(asUser("u_a"), f.repo, fakeCtx({}));
    const res = await app.handle(req("POST", "/api/w/ws_1/projects", { name: "Billing" }));
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.data.name).toBe("Billing");
    expect(f.state.projects[0]!.ownerId).toBe("u_a"); // server actor, not a body field
  });

  test("C-002: a plain member (not admin) may create a project", async () => {
    const f = fakeRepo();
    const app = buildApp(asUser("u_member"), f.repo, fakeCtx({}));
    const res = await app.handle(req("POST", "/api/w/ws_1/projects", { name: "Payments" }));
    expect(res.status).toBe(201);
  });

  test("AS-005: empty name → 400 VALIDATION_ERROR", async () => {
    const f = fakeRepo();
    const app = buildApp(asUser("u_a"), f.repo, fakeCtx({}));
    const res = await app.handle(req("POST", "/api/w/ws_1/projects", { name: "" }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  test("no session → 401 (handler never runs, nothing created)", async () => {
    const f = fakeRepo();
    const app = buildApp(noSession, f.repo, fakeCtx({}));
    const res = await app.handle(req("POST", "/api/w/ws_1/projects", { name: "X" }));
    expect(res.status).toBe(401);
    expect(f.state.projects).toHaveLength(0);
  });

  test("AS-006/C-003: browse returns doc B (anyone_in_workspace) but NOT doc A (restricted, X uninvited) — existence-hiding", async () => {
    const f = fakeRepo([
      { id: "p_1", workspaceId: WS, name: "Billing", ownerId: "u_a", isDefault: false, archivedAt: null },
    ]);
    const docA: ProjectDocRow = {
      id: "dA", slug: "doc-a", title: "Secret A", kind: "markdown",
      ownerId: "u_a", generalAccess: "restricted",
      latestVersion: 1, annotationCount: 0, ownerName: "Alice",
    };
    const docB: ProjectDocRow = {
      id: "dB", slug: "doc-b", title: "Shared B", kind: "markdown",
      ownerId: "u_a", generalAccess: "anyone_in_workspace",
      latestVersion: 3, annotationCount: 5, ownerName: "Alice",
    };
    const ctx = fakeCtx({
      docs: new Map([["p_1", [docA, docB]]]),
    });
    const app = buildApp(asUser("u_x"), f.repo, ctx);
    const res = await app.handle(req("GET", "/api/w/ws_1/projects/p_1/docs"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    const ids = json.data.docs.map((d: any) => d.id);
    expect(ids).toEqual(["dB"]);
    // The browse columns surface for the visible doc: version/annotationCount/author/status.
    expect(json.data.docs[0]).toMatchObject({
      id: "dB",
      version: 3,
      annotationCount: 5,
      authorName: "Alice",
      status: "live", // anyone_in_workspace → shared → live
    });
    // No metadata of doc A leaks anywhere in the response body.
    const raw = JSON.stringify(json);
    expect(raw).not.toContain("dA");
    expect(raw).not.toContain("Secret A");
    expect(raw).not.toContain("doc-a");
  });

  test("AS-006: empty project → 200 { docs: [] }", async () => {
    const f = fakeRepo([
      { id: "p_1", workspaceId: WS, name: "Empty", ownerId: "u_a", isDefault: false, archivedAt: null },
    ]);
    const app = buildApp(asUser("u_a"), f.repo, fakeCtx({ docs: new Map([["p_1", []]]) }));
    const res = await app.handle(req("GET", "/api/w/ws_1/projects/p_1/docs"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.docs).toEqual([]);
  });

  test("AS-007/C-005: archive removes the project from the default browse list; unarchive restores it", async () => {
    const f = fakeRepo([
      { id: "p_1", workspaceId: WS, name: "Billing", ownerId: "u_a", isDefault: false, archivedAt: null },
    ]);
    const app = buildApp(asUser("u_a"), f.repo, fakeCtx({}));

    const arch = await app.handle(req("POST", "/api/w/ws_1/projects/p_1/archive"));
    expect(arch.status).toBe(200);

    const listed = await app.handle(req("GET", "/api/w/ws_1/projects"));
    expect(((await listed.json()) as any).data.projects).toEqual([]);

    // includeArchived shows it.
    const all = await app.handle(req("GET", "/api/w/ws_1/projects?includeArchived=true"));
    expect(((await all.json()) as any).data.projects).toHaveLength(1);

    await app.handle(req("POST", "/api/w/ws_1/projects/p_1/unarchive"));
    const back = await app.handle(req("GET", "/api/w/ws_1/projects"));
    expect(((await back.json()) as any).data.projects).toHaveLength(1);
  });

  test("C-002: a non-owner member cannot archive someone else's project → 403", async () => {
    const f = fakeRepo([
      { id: "p_1", workspaceId: WS, name: "Billing", ownerId: "u_a", isDefault: false, archivedAt: null },
    ]);
    const app = buildApp(asUser("u_other"), f.repo, fakeCtx({}));
    const res = await app.handle(req("POST", "/api/w/ws_1/projects/p_1/archive"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe("FORBIDDEN");
  });

  test("delete a non-empty project → 409 CONFLICT", async () => {
    const f = fakeRepo([
      { id: "p_1", workspaceId: WS, name: "Billing", ownerId: "u_a", isDefault: false, archivedAt: null },
    ]);
    f.state.docCounts.set("p_1", 1);
    const app = buildApp(asUser("u_a"), f.repo, fakeCtx({}));
    const res = await app.handle(req("DELETE", "/api/w/ws_1/projects/p_1"));
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.code).toBe("CONFLICT");
  });

  test("manage a missing project → 404", async () => {
    const f = fakeRepo();
    const app = buildApp(asUser("u_a"), f.repo, fakeCtx({}), { admins: new Set(["u_a"]) });
    const res = await app.handle(req("PATCH", "/api/w/ws_1/projects/nope", { name: "X" }));
    expect(res.status).toBe(404);
  });
});

// S-007: the browse + projects-list reads return ONE bounded page (default size 20) plus a
// `pagination` summary (total + hasNext). The domain keys `docs`/`projects` are RETAINED; the
// summary is ADDITIVE. Access filtering (C-003) runs BEFORE the page is taken, so the total
// counts only accessible items and no out-of-access doc appears in any page (AS-020).
describe("/api/projects pagination (workspace-project S-007)", () => {
  // Build N markdown docs in one project, every one accessible (anyone_in_workspace).
  const mkDocs = (n: number, access: ProjectDocRow["generalAccess"] = "anyone_in_workspace"): ProjectDocRow[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `d${i + 1}`,
      slug: `doc-${i + 1}`,
      title: `Doc ${i + 1}`,
      kind: "markdown" as const,
      ownerId: "u_a",
      generalAccess: access,
      latestVersion: 1,
      annotationCount: 0,
      ownerName: "Alice",
    }));

  test("AS-016: a project's doc browse returns one page (≤20) with a total summary stating more pages exist", async () => {
    const f = fakeRepo([
      { id: "p_1", workspaceId: WS, name: "Big", ownerId: "u_a", isDefault: false, archivedAt: null },
    ]);
    const ctx = fakeCtx({ docs: new Map([["p_1", mkDocs(45)]]) });
    const app = buildApp(asUser("u_a"), f.repo, ctx);
    const res = await app.handle(req("GET", "/api/w/ws_1/projects/p_1/docs"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.docs).toHaveLength(20);
    expect(json.data.docs[0].id).toBe("d1");
    expect(json.data.docs[19].id).toBe("d20");
    expect(json.data.pagination).toMatchObject({
      page: 1,
      limit: 20,
      total: 45,
      totalPages: 3,
      hasNext: true,
      hasPrevious: false,
    });
  });

  test("AS-017: requesting a later page returns that slice and the summary states no further page exists", async () => {
    const f = fakeRepo([
      { id: "p_1", workspaceId: WS, name: "Big", ownerId: "u_a", isDefault: false, archivedAt: null },
    ]);
    const ctx = fakeCtx({ docs: new Map([["p_1", mkDocs(45)]]) });
    const app = buildApp(asUser("u_a"), f.repo, ctx);
    const res = await app.handle(req("GET", "/api/w/ws_1/projects/p_1/docs?page=3"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    // page 3 of 45 at size 20 = docs 41..45 (5 items).
    expect(json.data.docs.map((d: any) => d.id)).toEqual(["d41", "d42", "d43", "d44", "d45"]);
    expect(json.data.pagination).toMatchObject({
      page: 3,
      total: 45,
      hasNext: false,
      hasPrevious: true,
    });
  });

  test("AS-019: the projects list returns one page (≤20) with a total summary stating more pages exist", async () => {
    const seed = Array.from({ length: 30 }, (_, i) => ({
      id: `p_${i + 1}`,
      workspaceId: WS,
      name: `Project ${i + 1}`,
      ownerId: "u_a",
      isDefault: false,
      archivedAt: null,
    }));
    const f = fakeRepo(seed);
    const app = buildApp(asUser("u_a"), f.repo, fakeCtx({}));
    const res = await app.handle(req("GET", "/api/w/ws_1/projects"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.projects).toHaveLength(20);
    expect(json.data.pagination).toMatchObject({
      page: 1,
      limit: 20,
      total: 30,
      totalPages: 2,
      hasNext: true,
      hasPrevious: false,
    });
  });

  test("AS-020: the page total counts only accessible docs (filter BEFORE paginate); no out-of-access doc in any page", async () => {
    // 40 docs: the first 22 are accessible (anyone_in_workspace), the last 18 are restricted
    // and u_x is uninvited → access-filtered OUT. Total must reflect 22, two pages, never 40.
    const accessible = mkDocs(22, "anyone_in_workspace");
    const hidden = Array.from({ length: 18 }, (_, i) => ({
      id: `secret${i + 1}`,
      slug: `secret-${i + 1}`,
      title: `Secret ${i + 1}`,
      kind: "markdown" as const,
      ownerId: "u_a",
      generalAccess: "restricted" as const,
      latestVersion: 1,
      annotationCount: 0,
      ownerName: "Alice",
    }));
    const f = fakeRepo([
      { id: "p_1", workspaceId: WS, name: "Mixed", ownerId: "u_a", isDefault: false, archivedAt: null },
    ]);
    const ctx = fakeCtx({ docs: new Map([["p_1", [...accessible, ...hidden]]]) });
    const app = buildApp(asUser("u_x"), f.repo, ctx);

    const page1 = (await (await app.handle(req("GET", "/api/w/ws_1/projects/p_1/docs"))).json()) as any;
    expect(page1.data.pagination).toMatchObject({ total: 22, totalPages: 2, hasNext: true });
    expect(page1.data.docs).toHaveLength(20);

    const page2 = (await (await app.handle(req("GET", "/api/w/ws_1/projects/p_1/docs?page=2"))).json()) as any;
    expect(page2.data.docs).toHaveLength(2);
    expect(page2.data.pagination).toMatchObject({ total: 22, hasNext: false });

    // Existence-hiding holds across BOTH pages: no restricted doc's bytes appear anywhere.
    const raw = JSON.stringify(page1) + JSON.stringify(page2);
    expect(raw).not.toContain("secret");
    expect(raw).not.toContain("Secret ");
  });
});
