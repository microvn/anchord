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
import type { ProjectsRouteRepo, ProjectDocRow, WorkspaceDocRow } from "../../src/workspace/repo";
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
        visibility: input.visibility,
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
    async setVisibility(id, visibility) {
      const p = state.projects.find((x) => x.id === id);
      if (p) p.visibility = visibility;
    },
    async setVisibilityPrivateCascade(id) {
      const p = state.projects.find((x) => x.id === id);
      if (p) p.visibility = "private";
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
  /** S-008: the union of browse docs across the workspace's active projects (each row carries
   *  its projectId + projectName). The route access-filters + pages + counts over this. */
  workspaceDocs?: WorkspaceDocRow[];
  /** S-003/AS-028: the per-project accessible-doc count the projects-list read rides. Keyed by
   *  projectId; a project absent here resolves to 0 (matches the repo's GROUP BY contract). */
  docCounts?: Map<string, number>;
}): ProjectsRouteRepo {
  return {
    async isInvited(docId, userId) {
      return !!opts.invited?.has(`${docId}:${userId}`);
    },
    async docsInProject(projectId) {
      return opts.docs?.get(projectId) ?? [];
    },
    async workspaceDocs() {
      return opts.workspaceDocs ?? [];
    },
    async countDocsByProject() {
      return opts.docCounts ?? new Map();
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

  test("AS-018: create with no visibility in the body → project created PUBLIC (prior default preserved)", async () => {
    const f = fakeRepo();
    const app = buildApp(asUser("u_a"), f.repo, fakeCtx({}));
    // The dialog at its default sends no override (or "public"); either way the created project is public.
    const res = await app.handle(req("POST", "/api/w/ws_1/projects", { name: "Vantage" }));
    expect(res.status).toBe(201);
    expect(f.state.projects[0]!.visibility).toBe("public");
  });

  test("AS-019: route honors visibility=private → project created PRIVATE from the moment it exists", async () => {
    const f = fakeRepo();
    const app = buildApp(asUser("u_a"), f.repo, fakeCtx({}));
    const res = await app.handle(
      req("POST", "/api/w/ws_1/projects", { name: "Vault", visibility: "private" }),
    );
    expect(res.status).toBe(201);
    // Created private — never public, no follow-up toggle.
    expect(f.state.projects[0]!.visibility).toBe("private");
    expect(f.state.projects[0]!.name).toBe("Vault");
  });

  test("AS-018: an explicit visibility=public in the body is honored (created public)", async () => {
    const f = fakeRepo();
    const app = buildApp(asUser("u_a"), f.repo, fakeCtx({}));
    const res = await app.handle(
      req("POST", "/api/w/ws_1/projects", { name: "Open", visibility: "public" }),
    );
    expect(res.status).toBe(201);
    expect(f.state.projects[0]!.visibility).toBe("public");
  });

  test("AS-019: a bad visibility value → 400 VALIDATION_ERROR (enum-guarded), nothing created", async () => {
    const f = fakeRepo();
    const app = buildApp(asUser("u_a"), f.repo, fakeCtx({}));
    const res = await app.handle(
      req("POST", "/api/w/ws_1/projects", { name: "X", visibility: "secret" }),
    );
    expect(res.status).toBe(400);
    expect(f.state.projects).toHaveLength(0);
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
      { id: "p_1", workspaceId: WS, name: "Billing", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
    ]);
    const docA: ProjectDocRow = {
      id: "dA", slug: "doc-a", title: "Secret A", kind: "markdown",
      ownerId: "u_a", workspaceShared: false, generalAccess: "restricted",
      workspaceRole: null, linkRole: null,
      latestVersion: 1, annotationCount: 0, ownerName: "Alice",
      createdAt: new Date("2026-06-01T00:00:00.000Z"), updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    };
    const docB: ProjectDocRow = {
      id: "dB", slug: "doc-b", title: "Shared B", kind: "markdown",
      ownerId: "u_a", workspaceShared: true, generalAccess: "anyone_in_workspace",
      workspaceRole: "commenter", linkRole: null,
      latestVersion: 3, annotationCount: 5, ownerName: "Alice",
      createdAt: new Date("2026-06-01T00:00:00.000Z"), updatedAt: new Date("2026-06-01T00:00:00.000Z"),
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
    // No metadata of doc A leaks anywhere in the response body. (Assert on doc A's UNIQUE
    // markers — its title/slug — and that no row carries its id; a bare "dA" substring check
    // would false-positive on field names like "createdAt".)
    expect(json.data.docs.some((d: any) => d.id === "dA")).toBe(false);
    const raw = JSON.stringify(json);
    expect(raw).not.toContain("Secret A");
    expect(raw).not.toContain("doc-a");
  });

  test("AS-021: each browse row carries the doc's general_access level (finer than status)", async () => {
    const f = fakeRepo([
      { id: "p_1", workspaceId: WS, name: "Billing", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
    ]);
    const wsDoc: ProjectDocRow = {
      id: "dWs", slug: "doc-ws", title: "Workspace Doc", kind: "markdown",
      ownerId: "u_a", workspaceShared: true, generalAccess: "anyone_in_workspace",
      workspaceRole: "commenter", linkRole: null,
      latestVersion: 1, annotationCount: 0, ownerName: "Alice",
      createdAt: new Date("2026-06-01T00:00:00.000Z"), updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    };
    const linkDoc: ProjectDocRow = {
      // owned by the caller (u_x) so it is browsable — an anyone_with_link doc is reachable by link
      // but only LISTED in browse for its owner/invitee, not for every workspace member.
      id: "dLink", slug: "doc-link", title: "Link Doc", kind: "markdown",
      ownerId: "u_x", workspaceShared: false, generalAccess: "anyone_with_link",
      workspaceRole: null, linkRole: "viewer",
      latestVersion: 1, annotationCount: 0, ownerName: "Xavier",
      createdAt: new Date("2026-06-01T00:00:00.000Z"), updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    };
    const ctx = fakeCtx({ docs: new Map([["p_1", [wsDoc, linkDoc]]]) });
    const app = buildApp(asUser("u_x"), f.repo, ctx);
    const res = await app.handle(req("GET", "/api/w/ws_1/projects/p_1/docs"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    const rowFor = (id: string) => json.data.docs.find((d: any) => d.id === id);
    // Each row reports its OWN general-access level — the 3-way value the AccessIndicator needs.
    expect(rowFor("dWs").generalAccess).toBe("anyone_in_workspace");
    expect(rowFor("dLink").generalAccess).toBe("anyone_with_link");
    // ...which `status` cannot express: both are "live", yet their access levels differ.
    expect(rowFor("dWs").status).toBe("live");
    expect(rowFor("dLink").status).toBe("live");
  });

  test("AS-026: list payload derives status/access from the two axes; a link-only doc is in neither the rows NOR the count", async () => {
    // doc-access-two-axis S-004: a non-invited member browses a project holding a workspace-shared
    // doc (workspace_role on) + a link-only doc (workspace off, link on). The link-only doc must be
    // absent from the rows AND from the total — count and rows come from the SAME filtered set.
    const f = fakeRepo([
      { id: "p_1", workspaceId: WS, name: "Billing", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
    ]);
    const wsShared: ProjectDocRow = {
      id: "dWs", slug: "doc-ws", title: "Workspace Doc", kind: "markdown",
      ownerId: "u_a", workspaceShared: true, generalAccess: "anyone_in_workspace",
      workspaceRole: "commenter", linkRole: null,
      latestVersion: 2, annotationCount: 1, ownerName: "Alice",
      createdAt: new Date("2026-06-01T00:00:00.000Z"), updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    };
    const linkOnly: ProjectDocRow = {
      // workspace axis OFF, link axis ON → derived level anyone_with_link, but NOT a workspace grant.
      // Owned by someone else and the browsing member (u_x) is NOT invited → must be hidden.
      id: "dLink", slug: "doc-link", title: "Link Only", kind: "markdown",
      ownerId: "u_a", workspaceShared: false, generalAccess: "anyone_with_link",
      workspaceRole: null, linkRole: "viewer",
      latestVersion: 1, annotationCount: 0, ownerName: "Alice",
      createdAt: new Date("2026-06-01T00:00:00.000Z"), updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    };
    const ctx = fakeCtx({ docs: new Map([["p_1", [wsShared, linkOnly]]]) });
    const app = buildApp(asUser("u_x"), f.repo, ctx);
    const res = await app.handle(req("GET", "/api/w/ws_1/projects/p_1/docs"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    // Rows: only the workspace-shared doc. The link-only doc leaks nowhere.
    expect(json.data.docs.map((d: any) => d.id)).toEqual(["dWs"]);
    // Count (total) comes from the SAME filtered set as the rows — the hidden doc is not counted.
    expect(json.data.pagination.total).toBe(1);
    // Status + access summary are DERIVED from the two axes (no stored level): workspace on → live.
    expect(json.data.docs[0]).toMatchObject({ status: "live", generalAccess: "anyone_in_workspace" });
    // No byte of the link-only doc survives anywhere in the response.
    const raw = JSON.stringify(json);
    expect(raw).not.toContain("Link Only");
    expect(raw).not.toContain("doc-link");
  });

  test("AS-016: project doc count includes the workspace-shared doc, not the link-only one, for a non-invited member", async () => {
    // doc-access-two-axis S-004: countDocsByProject applies the SAME C-006 predicate in SQL. The
    // route reads it straight through; here the repo's GROUP BY is faked to the value the real SQL
    // (workspace_role IS NOT NULL) would yield — 1 (only the workspace-shared doc counts).
    const f = fakeRepo([
      { id: "p_1", workspaceId: WS, name: "Billing", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
    ]);
    const ctx = fakeCtx({ docCounts: new Map([["p_1", 1]]) });
    const app = buildApp(asUser("u_x"), f.repo, ctx);
    const res = await app.handle(req("GET", "/api/w/ws_1/projects"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    const p1 = json.data.projects.find((p: any) => p.id === "p_1");
    expect(p1.docCount).toBe(1); // the link-only doc is NOT counted (workspace axis off)
  });

  test("AS-022: each browse row carries the doc's created + updated times (for Created/Updated sort)", async () => {
    const f = fakeRepo([
      { id: "p_1", workspaceId: WS, name: "Billing", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
    ]);
    const older: ProjectDocRow = {
      id: "dOld", slug: "doc-old", title: "Older", kind: "markdown",
      ownerId: "u_a", workspaceShared: true, generalAccess: "anyone_in_workspace",
      workspaceRole: "commenter", linkRole: null,
      latestVersion: 1, annotationCount: 0, ownerName: "Alice",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-18T00:00:00.000Z"),
    };
    const newer: ProjectDocRow = {
      id: "dNew", slug: "doc-new", title: "Newer", kind: "markdown",
      ownerId: "u_a", workspaceShared: true, generalAccess: "anyone_in_workspace",
      workspaceRole: "commenter", linkRole: null,
      latestVersion: 1, annotationCount: 0, ownerName: "Alice",
      createdAt: new Date("2026-06-10T00:00:00.000Z"),
      updatedAt: new Date("2026-06-12T00:00:00.000Z"),
    };
    const ctx = fakeCtx({ docs: new Map([["p_1", [older, newer]]]) });
    const app = buildApp(asUser("u_a"), f.repo, ctx);
    const res = await app.handle(req("GET", "/api/w/ws_1/projects/p_1/docs"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    const rowFor = (id: string) => json.data.docs.find((d: any) => d.id === id);
    // Each row reports BOTH timestamps (ISO strings after JSON serialization) so the consumer
    // can sort by Created or Updated without a second fetch (workspace-project-browse:S-003).
    expect(rowFor("dOld").createdAt).toBe("2026-06-01T00:00:00.000Z");
    expect(rowFor("dOld").updatedAt).toBe("2026-06-18T00:00:00.000Z");
    expect(rowFor("dNew").createdAt).toBe("2026-06-10T00:00:00.000Z");
    expect(rowFor("dNew").updatedAt).toBe("2026-06-12T00:00:00.000Z");
    // The two docs have distinct created vs updated ordering → a consumer can sort either axis.
    expect(rowFor("dOld").createdAt < rowFor("dNew").createdAt).toBe(true);
    expect(rowFor("dOld").updatedAt > rowFor("dNew").updatedAt).toBe(true);
  });

  test("AS-028: the projects-list response carries each project's accessible-doc count (one read, count rides each row)", async () => {
    const seed: ProjectRow[] = [
      { id: "p_bill", workspaceId: WS, name: "Billing", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
      { id: "p_pay", workspaceId: WS, name: "Payments", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
      { id: "p_empty", workspaceId: WS, name: "Empty", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
    ];
    const f = fakeRepo(seed);
    // The repo's GROUP BY (countDocsByProject) is access-filtered by construction: Billing 5,
    // Payments 3 (of 9 — only the accessible ones), Empty absent → 0. The route reads THIS map,
    // never a per-project loop. (The DB-level access filter itself is proved in the .itest.)
    const docCounts = new Map<string, number>([
      ["p_bill", 5],
      ["p_pay", 3],
    ]);
    const app = buildApp(asUser("u_a"), f.repo, fakeCtx({ docCounts }));
    const res = await app.handle(req("GET", "/api/w/ws_1/projects"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    const byId = (id: string) => json.data.projects.find((p: any) => p.id === id);
    expect(byId("p_bill").docCount).toBe(5);
    expect(byId("p_pay").docCount).toBe(3); // 3 of 9 — the count is the ACCESSIBLE count, not the raw total
    expect(byId("p_empty").docCount).toBe(0); // absent from the map → defaults to 0, never undefined
  });

  test("AS-030: each projects-list row carries newDocAccess (derived level, default carve-out + private→restricted)", async () => {
    const seed: ProjectRow[] = [
      // default project — private SHELL but the carve-out keeps its new docs workspace-shared.
      { id: "p_def", workspaceId: WS, name: "Alice's docs", ownerId: "u_a", isDefault: true, visibility: "private", archivedAt: null },
      // non-default PUBLIC → workspace-shared.
      { id: "p_pub", workspaceId: WS, name: "Public", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
      // non-default PRIVATE → restricted.
      { id: "p_priv", workspaceId: WS, name: "Private", ownerId: "u_a", isDefault: false, visibility: "private", archivedAt: null },
    ];
    const f = fakeRepo(seed);
    const app = buildApp(asUser("u_a"), f.repo, fakeCtx({}));
    const res = await app.handle(req("GET", "/api/w/ws_1/projects"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    const byId = (id: string) => json.data.projects.find((p: any) => p.id === id);
    expect(byId("p_def").newDocAccess).toBe("anyone_in_workspace"); // carve-out: default stays shared despite private
    expect(byId("p_pub").newDocAccess).toBe("anyone_in_workspace"); // non-default public → shared
    expect(byId("p_priv").newDocAccess).toBe("restricted"); // non-default private → restricted

    // The move/copy picker reads GET /docs — its projects array carries newDocAccess too.
    const picker = await app.handle(req("GET", "/api/w/ws_1/docs"));
    expect(picker.status).toBe(200);
    const pj = (await picker.json()) as any;
    const pBy = (id: string) => pj.data.projects.find((p: any) => p.id === id);
    expect(pBy("p_def").newDocAccess).toBe("anyone_in_workspace");
    expect(pBy("p_pub").newDocAccess).toBe("anyone_in_workspace");
    expect(pBy("p_priv").newDocAccess).toBe("restricted");
  });

  test("AS-006: empty project → 200 { docs: [] }", async () => {
    const f = fakeRepo([
      { id: "p_1", workspaceId: WS, name: "Empty", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
    ]);
    const app = buildApp(asUser("u_a"), f.repo, fakeCtx({ docs: new Map([["p_1", []]]) }));
    const res = await app.handle(req("GET", "/api/w/ws_1/projects/p_1/docs"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.docs).toEqual([]);
  });

  test("AS-007/C-005: archive removes the project from the default browse list; unarchive restores it", async () => {
    const f = fakeRepo([
      { id: "p_1", workspaceId: WS, name: "Billing", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
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
      { id: "p_1", workspaceId: WS, name: "Billing", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
    ]);
    const app = buildApp(asUser("u_other"), f.repo, fakeCtx({}));
    const res = await app.handle(req("POST", "/api/w/ws_1/projects/p_1/archive"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe("FORBIDDEN");
  });

  test("delete a non-empty project → 409 CONFLICT", async () => {
    const f = fakeRepo([
      { id: "p_1", workspaceId: WS, name: "Billing", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
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
      workspaceShared: access === "anyone_in_workspace",
      generalAccess: access,
      workspaceRole: access === "anyone_in_workspace" ? "commenter" : null,
      linkRole: access === "anyone_with_link" ? "viewer" : null,
      latestVersion: 1,
      annotationCount: 0,
      ownerName: "Alice",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    }));

  test("AS-016: a project's doc browse returns one page (≤20) with a total summary stating more pages exist", async () => {
    const f = fakeRepo([
      { id: "p_1", workspaceId: WS, name: "Big", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
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
      { id: "p_1", workspaceId: WS, name: "Big", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
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
      visibility: "public" as const,
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
      workspaceShared: false,
      generalAccess: "restricted" as const,
      workspaceRole: null,
      linkRole: null,
      latestVersion: 1,
      annotationCount: 0,
      ownerName: "Alice",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    }));
    const f = fakeRepo([
      { id: "p_1", workspaceId: WS, name: "Mixed", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
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

// S-008: GET /api/w/:id/docs — the workspace-wide docs read returns, in ONE response, a PAGE of
// the access-filtered doc union (each annotated with project name), every active project with its
// accessible-doc count, the workspace total, and the page summary. Access filtering (C-003) runs
// BEFORE paging AND counting. Default page size 20, cap 100. Retires the FE N+1 fan-out.
describe("/api/w/:id/docs workspace-wide read (workspace-project S-008)", () => {
  // Build a browse doc in a given project, accessible by default (anyone_in_workspace).
  const wDoc = (
    n: number,
    projectId: string,
    projectName: string,
    over: Partial<WorkspaceDocRow> = {},
  ): WorkspaceDocRow => ({
    id: `d${n}`,
    slug: `doc-${n}`,
    title: `Doc ${n}`,
    kind: "markdown",
    ownerId: "u_a",
    workspaceShared: true,
    generalAccess: "anyone_in_workspace",
    workspaceRole: "commenter",
    linkRole: null,
    latestVersion: 1,
    annotationCount: 0,
    ownerName: "Alice",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    projectId,
    projectName,
    // project-visibility S-006 / C-004: the project's visibility + owner ride the row so the route
    // can suppress the name for a non-owner of a private project. Default public/owned-by-u_a so the
    // pre-existing S-008 tests (all public projects) keep the real name; AS-026 overrides them.
    projectVisibility: "public",
    projectOwnerId: "u_a",
    ...over,
  });

  test("AS-023: returns one page of the accessible union, each doc carrying its project name + a total summary", async () => {
    // 12 docs across 3 projects; page size 18 → all 12 fit one page.
    const f = fakeRepo([
      { id: "pA", workspaceId: WS, name: "Alpha", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
      { id: "pB", workspaceId: WS, name: "Beta", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
      { id: "pC", workspaceId: WS, name: "Gamma", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
    ]);
    const union: WorkspaceDocRow[] = [
      ...Array.from({ length: 5 }, (_, i) => wDoc(i + 1, "pA", "Alpha")),
      ...Array.from({ length: 4 }, (_, i) => wDoc(i + 6, "pB", "Beta")),
      ...Array.from({ length: 3 }, (_, i) => wDoc(i + 10, "pC", "Gamma")),
    ];
    const app = buildApp(asUser("u_a"), f.repo, fakeCtx({ workspaceDocs: union }));
    const res = await app.handle(req("GET", "/api/w/ws_1/docs?limit=18"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.docs).toHaveLength(12);
    // Each doc carries its project name (joined in the union read).
    const byId = (id: string) => json.data.docs.find((d: any) => d.id === id);
    expect(byId("d1").projectName).toBe("Alpha");
    expect(byId("d6").projectName).toBe("Beta");
    expect(byId("d10").projectName).toBe("Gamma");
    expect(byId("d1").projectId).toBe("pA");
    expect(json.data.pagination).toMatchObject({
      page: 1,
      limit: 18,
      total: 12,
      totalPages: 1,
      hasNext: false,
      hasPrevious: false,
    });
  });

  test("AS-026/C-004: a non-owner sees a shared doc in A's PRIVATE project but its project NAME is suppressed (null); the owner sees the name", async () => {
    // A owns a PRIVATE project "Secret"; a workspace-shared doc lives in it. B (a member, not the
    // owner) can browse the doc (workspaceShared → C-005), but the private project's NAME must not
    // leak on the card. The OWNER A still sees the real name.
    const f = fakeRepo([
      { id: "pSecret", workspaceId: WS, name: "Secret", ownerId: "u_a", isDefault: false, visibility: "private", archivedAt: null },
    ]);
    const union: WorkspaceDocRow[] = [
      wDoc(1, "pSecret", "Secret", { projectVisibility: "private", projectOwnerId: "u_a" }),
    ];

    // Non-owner B: the doc lists (C-005), but projectName is suppressed to null (C-004 / AS-026).
    const appB = buildApp(asUser("u_b"), f.repo, fakeCtx({ workspaceDocs: union }));
    const jsonB = (await (await appB.handle(req("GET", "/api/w/ws_1/docs"))).json()) as any;
    expect(jsonB.data.docs).toHaveLength(1); // the shared doc still appears (C-005 — not project-gated)
    expect(jsonB.data.docs[0].id).toBe("d1");
    expect(jsonB.data.docs[0].projectName).toBeNull(); // the private project's NAME is suppressed

    // Owner A: same doc, real name shown.
    const appA = buildApp(asUser("u_a"), f.repo, fakeCtx({ workspaceDocs: union }));
    const jsonA = (await (await appA.handle(req("GET", "/api/w/ws_1/docs"))).json()) as any;
    expect(jsonA.data.docs[0].projectName).toBe("Secret");
  });

  test("AS-024: the same response carries the active-project list (id + name) + workspace total, NO per-project docCount", async () => {
    const f = fakeRepo([
      { id: "pA", workspaceId: WS, name: "Alpha", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
      { id: "pB", workspaceId: WS, name: "Beta", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
      { id: "pC", workspaceId: WS, name: "Gamma", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
    ]);
    const union: WorkspaceDocRow[] = [
      ...Array.from({ length: 5 }, (_, i) => wDoc(i + 1, "pA", "Alpha")),
      ...Array.from({ length: 4 }, (_, i) => wDoc(i + 6, "pB", "Beta")),
      ...Array.from({ length: 3 }, (_, i) => wDoc(i + 10, "pC", "Gamma")),
    ];
    const app = buildApp(asUser("u_a"), f.repo, fakeCtx({ workspaceDocs: union }));
    const res = await app.handle(req("GET", "/api/w/ws_1/docs?limit=18"));
    const json = (await res.json()) as any;
    // The active-project list carries id + name (the move/copy picker + project-count stat).
    expect(json.data.projects.map((p: any) => ({ id: p.id, name: p.name }))).toEqual([
      { id: "pA", name: "Alpha" },
      { id: "pB", name: "Beta" },
      { id: "pC", name: "Gamma" },
    ]);
    // NO per-project doc count rides this read (unused — Projects browser counts via its own read).
    for (const p of json.data.projects) expect(p.docCount).toBeUndefined();
    expect(json.data.pagination.total).toBe(12);
  });

  test("AS-025: a later page returns its slice; requested page size honored up to cap 100", async () => {
    // 40 accessible docs in one project; page size 18 → page 3 = docs 37..40.
    const f = fakeRepo([
      { id: "pA", workspaceId: WS, name: "Alpha", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
    ]);
    const union = Array.from({ length: 40 }, (_, i) => wDoc(i + 1, "pA", "Alpha"));
    const app = buildApp(asUser("u_a"), f.repo, fakeCtx({ workspaceDocs: union }));

    const res = await app.handle(req("GET", "/api/w/ws_1/docs?page=3&limit=18"));
    const json = (await res.json()) as any;
    expect(json.data.docs.map((d: any) => d.id)).toEqual(["d37", "d38", "d39", "d40"]);
    expect(json.data.pagination).toMatchObject({ page: 3, limit: 18, total: 40, hasNext: false });

    // A page size over the cap is CLAMPED to 100, never an error (pagination.ts lenient rule).
    const capped = await app.handle(req("GET", "/api/w/ws_1/docs?limit=500"));
    const cappedJson = (await capped.json()) as any;
    expect(cappedJson.status ?? capped.status).toBe(200);
    expect(cappedJson.data.pagination.limit).toBe(100);
    expect(cappedJson.data.docs).toHaveLength(40); // all 40 fit under the 100 cap
  });

  test("AS-026: access filtering before paging and the total — out-of-access docs absent from page and total", async () => {
    // 50 docs: 22 accessible (anyone_in_workspace), 28 restricted with u_x uninvited → filtered out.
    // pA: 12 accessible + 18 restricted. pB: 10 accessible + 10 restricted.
    const f = fakeRepo([
      { id: "pA", workspaceId: WS, name: "Alpha", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
      { id: "pB", workspaceId: WS, name: "Beta", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
    ]);
    const restricted = (n: number, p: string, name: string): WorkspaceDocRow =>
      wDoc(n, p, name, {
        id: `secret${n}`,
        slug: `secret-${n}`,
        title: `Secret ${n}`,
        workspaceShared: false,
        generalAccess: "restricted",
        workspaceRole: null,
        linkRole: null,
      });
    const union: WorkspaceDocRow[] = [
      ...Array.from({ length: 12 }, (_, i) => wDoc(i + 1, "pA", "Alpha")),
      ...Array.from({ length: 18 }, (_, i) => restricted(i + 100, "pA", "Alpha")),
      ...Array.from({ length: 10 }, (_, i) => wDoc(i + 13, "pB", "Beta")),
      ...Array.from({ length: 10 }, (_, i) => restricted(i + 200, "pB", "Beta")),
    ];
    const app = buildApp(asUser("u_x"), f.repo, fakeCtx({ workspaceDocs: union }));

    const page1 = (await (await app.handle(req("GET", "/api/w/ws_1/docs?limit=20"))).json()) as any;
    // Total reflects only the 22 accessible docs, never 50 — filter runs before the total.
    expect(page1.data.pagination).toMatchObject({ total: 22, totalPages: 2, hasNext: true });
    expect(page1.data.docs).toHaveLength(20);

    const page2 = (await (await app.handle(req("GET", "/api/w/ws_1/docs?page=2&limit=20"))).json()) as any;
    expect(page2.data.docs).toHaveLength(2);

    // Existence-hiding across BOTH pages: no restricted doc's bytes appear anywhere.
    const raw = JSON.stringify(page1) + JSON.stringify(page2);
    expect(raw).not.toContain("secret");
    expect(raw).not.toContain("Secret ");
  });

  test("AS-008: the move/copy target picker (GET /docs projects payload) offers B's own + public, never A's private project", async () => {
    // project-visibility S-002 / C-002: B requests the workspace-docs read that feeds the
    // move/copy target picker; A's private project must NOT appear (no name leak), but B's own
    // private + the public one must.
    const f = fakeRepo([
      { id: "p_a_priv", workspaceId: WS, name: "Alice Secret", ownerId: "u_a", isDefault: false, visibility: "private", archivedAt: null },
      { id: "p_a_pub", workspaceId: WS, name: "Alice Public", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
      { id: "p_b_priv", workspaceId: WS, name: "Bob Secret", ownerId: "u_b", isDefault: false, visibility: "private", archivedAt: null },
    ]);
    const app = buildApp(asUser("u_b"), f.repo, fakeCtx({ workspaceDocs: [] }));
    const res = await app.handle(req("GET", "/api/w/ws_1/docs"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    const ids = json.data.projects.map((p: any) => p.id);
    expect(ids).toContain("p_b_priv"); // B's own private project — visible to B
    expect(ids).toContain("p_a_pub"); // A's public project — visible to all
    expect(ids).not.toContain("p_a_priv"); // A's private project — ABSENT for B
    // No name leak of the private project anywhere in the payload (existence-hiding).
    expect(JSON.stringify(json)).not.toContain("Alice Secret");
  });

  test("AS-008: the projects-list (which feeds the New-doc picker) omits another member's private project", async () => {
    const f = fakeRepo([
      { id: "p_a_priv", workspaceId: WS, name: "Alice Secret", ownerId: "u_a", isDefault: false, visibility: "private", archivedAt: null },
      { id: "p_a_pub", workspaceId: WS, name: "Alice Public", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
    ]);
    const app = buildApp(asUser("u_b"), f.repo, fakeCtx({}));
    const res = await app.handle(req("GET", "/api/w/ws_1/projects"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    const ids = json.data.projects.map((p: any) => p.id);
    expect(ids).toContain("p_a_pub");
    expect(ids).not.toContain("p_a_priv");
    expect(JSON.stringify(json)).not.toContain("Alice Secret");
  });

  // ── project-visibility S-003: PATCH …/projects/:id/visibility toggle (C-008/C-011) ──────
  test("AS-011: the owner toggles a public project → private over HTTP (200; row persisted private)", async () => {
    const f = fakeRepo([
      { id: "p_1", workspaceId: WS, name: "Vantage", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
    ]);
    const app = buildApp(asUser("u_a"), f.repo, fakeCtx({}));
    const res = await app.handle(
      req("PATCH", "/api/w/ws_1/projects/p_1/visibility", { visibility: "private" }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data).toMatchObject({ id: "p_1", visibility: "private" });
    expect(f.state.projects.find((p) => p.id === "p_1")!.visibility).toBe("private");
  });

  test("AS-012: a non-owner non-admin toggle is refused (403 FORBIDDEN); visibility unchanged", async () => {
    const f = fakeRepo([
      { id: "p_1", workspaceId: WS, name: "Vantage", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
    ]);
    const app = buildApp(asUser("u_b"), f.repo, fakeCtx({})); // u_b: not owner, not admin
    const res = await app.handle(
      req("PATCH", "/api/w/ws_1/projects/p_1/visibility", { visibility: "private" }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe("FORBIDDEN");
    expect(f.state.projects.find((p) => p.id === "p_1")!.visibility).toBe("public");
  });

  test("AS-013: a workspace admin toggles a PUBLIC project they can see (200)", async () => {
    const f = fakeRepo([
      { id: "p_1", workspaceId: WS, name: "Vantage", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
    ]);
    const app = buildApp(asUser("u_c"), f.repo, fakeCtx({}), { admins: new Set(["u_c"]) });
    const res = await app.handle(
      req("PATCH", "/api/w/ws_1/projects/p_1/visibility", { visibility: "private" }),
    );
    expect(res.status).toBe(200);
    expect(f.state.projects.find((p) => p.id === "p_1")!.visibility).toBe("private");
  });

  test("C-008: an admin CANNOT toggle another member's PRIVATE project (404/403 existence-hiding)", async () => {
    // Admin gets no C-002 exception: a private project they don't own is not visible (C-003), so
    // the toggle is refused (FORBIDDEN) and never writes.
    const f = fakeRepo([
      { id: "p_priv", workspaceId: WS, name: "Alice Secret", ownerId: "u_a", isDefault: false, visibility: "private", archivedAt: null },
    ]);
    const app = buildApp(asUser("u_c"), f.repo, fakeCtx({}), { admins: new Set(["u_c"]) });
    const res = await app.handle(
      req("PATCH", "/api/w/ws_1/projects/p_priv/visibility", { visibility: "public" }),
    );
    expect(res.status).toBe(403);
    expect(f.state.projects.find((p) => p.id === "p_priv")!.visibility).toBe("private");
  });

  test("AS-012: an invalid visibility value → 400 VALIDATION_ERROR (boundary)", async () => {
    const f = fakeRepo([
      { id: "p_1", workspaceId: WS, name: "Vantage", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
    ]);
    const app = buildApp(asUser("u_a"), f.repo, fakeCtx({}));
    const res = await app.handle(
      req("PATCH", "/api/w/ws_1/projects/p_1/visibility", { visibility: "secret" }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("VALIDATION_ERROR");
  });

  test("AS-015: the projects-list payload carries isDefault AND visibility for each row (C-011)", async () => {
    const f = fakeRepo([
      { id: "p_def", workspaceId: WS, name: "Alice's docs", ownerId: "u_a", isDefault: true, visibility: "private", archivedAt: null },
      { id: "p_pub", workspaceId: WS, name: "Vantage", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
    ]);
    const app = buildApp(asUser("u_a"), f.repo, fakeCtx({}));
    const res = await app.handle(req("GET", "/api/w/ws_1/projects"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    const byId = (id: string) => json.data.projects.find((p: any) => p.id === id);
    expect(byId("p_def")).toMatchObject({ isDefault: true, visibility: "private" });
    expect(byId("p_pub")).toMatchObject({ isDefault: false, visibility: "public" });
  });

  test("AS-015: each row carries a server-computed canToggleVisibility mirroring the C-008 toggle gate", async () => {
    // u_a owns both projects; u_b is a workspace admin (non-owner); u_c is a plain member (non-owner).
    // p_priv is u_a's PRIVATE project — only u_a (owner) sees it; admin/member don't (S-002/C-003),
    // so it never reaches their list, but where it DOES list (the owner) the flag is true.
    const seed: ProjectRow[] = [
      { id: "p_pub", workspaceId: WS, name: "Public", ownerId: "u_a", isDefault: false, visibility: "public", archivedAt: null },
      { id: "p_priv", workspaceId: WS, name: "Private", ownerId: "u_a", isDefault: false, visibility: "private", archivedAt: null },
    ];

    // Owner viewer (u_a): may toggle every project they own — both rows true.
    const owner = buildApp(asUser("u_a"), fakeRepo(seed).repo, fakeCtx({}));
    const ownerJson = (await (await owner.handle(req("GET", "/api/w/ws_1/projects"))).json()) as any;
    const ownerBy = (id: string) => ownerJson.data.projects.find((p: any) => p.id === id);
    expect(ownerBy("p_pub").canToggleVisibility).toBe(true);
    expect(ownerBy("p_priv").canToggleVisibility).toBe(true);

    // Admin non-owner (u_b): sees only the PUBLIC project (private one is filtered out) and MAY toggle it.
    const admin = buildApp(asUser("u_b"), fakeRepo(seed).repo, fakeCtx({}), { admins: new Set(["u_b"]) });
    const adminJson = (await (await admin.handle(req("GET", "/api/w/ws_1/projects"))).json()) as any;
    const adminBy = (id: string) => adminJson.data.projects.find((p: any) => p.id === id);
    expect(adminBy("p_priv")).toBeUndefined(); // private project of another member is absent (S-002)
    expect(adminBy("p_pub").canToggleVisibility).toBe(true); // admin on a visible (public) project → may toggle

    // Plain member non-owner (u_c): sees the public project but may NOT toggle it (not owner, not admin).
    const member = buildApp(asUser("u_c"), fakeRepo(seed).repo, fakeCtx({}));
    const memberJson = (await (await member.handle(req("GET", "/api/w/ws_1/projects"))).json()) as any;
    const memberBy = (id: string) => memberJson.data.projects.find((p: any) => p.id === id);
    expect(memberBy("p_priv")).toBeUndefined(); // private project of another member is absent
    expect(memberBy("p_pub").canToggleVisibility).toBe(false); // public, but viewer neither owns nor admins
  });
});
