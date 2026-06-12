// In-process route tests for the workspace-project S-004 /api/docs/:slug/{move,copy}
// mounts (no DB). HTTP GLUE only — envelope + auth gate + Zod + DocMoveRejected→
// DomainError mapping — via app.handle(Request)→Response with a fake repo + a fake
// resolveSession + a fake resolveDocRole. The real-Postgres path (versions/annotations/
// sharing intact after move; clean copy) is covered by test/integration/doc-move.itest.ts.
//
// AS map (workspace-project S-004):
//   AS-008  move ok for editor/owner → 200 { docId, slug, projectId }
//   AS-013  copy ok for a reader → 201 { docId (new), slug (new), projectId }
//   C-008   copy is a clean new doc; move relocates as-is
//   (gates) viewer move → 403; no-access → 404; bad target → 404; no session → 401

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { SessionResolver } from "../../src/http/auth-gate";
import type { Role } from "../../src/sharing/roles";
import type { DocMoveRepo, SourceDoc } from "../../src/workspace/doc-move";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "22222222-2222-4222-8222-222222222222";

const asUser = (userId: string): SessionResolver => async () => ({ userId });
const noSession: SessionResolver = async () => null;
const asRole =
  (role: Role | null) =>
  async (): Promise<Role | null> =>
    role;

const SRC: SourceDoc = {
  id: "doc_src",
  slug: "billing-doc",
  title: "Billing Spec",
  kind: "markdown",
  projectId: "p_billing",
};

function fakeRepo(opts: { doc?: SourceDoc | null; workspaceProjects?: Set<string> } = {}) {
  const state = { movedTo: null as string | null, copies: 0 };
  const repo: DocMoveRepo = {
    async findDocBySlug(slug) {
      const doc = opts.doc === undefined ? SRC : opts.doc;
      return doc && doc.slug === slug ? doc : null;
    },
    async projectInWorkspace(projectId) {
      return (opts.workspaceProjects ?? new Set([PROJECT, "p_billing"])).has(projectId);
    },
    async currentVersion() {
      return { content: "current body", contentHash: "h" };
    },
    async setProjectId(_docId, projectId) {
      state.movedTo = projectId;
    },
    async createCopy() {
      state.copies++;
      return { id: "doc_copy", slug: "copy-slug-abc" };
    },
  };
  return { repo, state };
}

function buildApp(opts: {
  resolveSession?: SessionResolver;
  resolveDocRole?: (docId: string, userId: string) => Promise<Role | null>;
  repo?: DocMoveRepo;
  isWorkspaceAdmin?: (workspaceId: string, userId: string) => boolean | Promise<boolean>;
}) {
  const { repo } = opts.repo ? { repo: opts.repo } : fakeRepo();
  return createApp({
    dbCheck: async () => {},
    docMove: {
      repo,
      resolveSession: opts.resolveSession ?? asUser("u_a"),
      resolveWorkspaceRole: async () => "member",
      resolveDocRole: opts.resolveDocRole ?? asRole("editor"),
      isWorkspaceAdmin: opts.isWorkspaceAdmin,
    },
  });
}

function req(method: string, path: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("/api/w/ws_1/docs/:slug/move|copy route glue (workspace-project S-004)", () => {
  test("AS-008: an editor moves the doc → 200 { docId, slug, projectId }", async () => {
    const f = fakeRepo();
    const app = buildApp({ repo: f.repo, resolveDocRole: asRole("editor") });
    const res = await app.handle(req("POST", "/api/w/ws_1/docs/billing-doc/move", { projectId: PROJECT }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.data.docId).toBe("doc_src"); // same doc relocated
    expect(json.data.slug).toBe("billing-doc"); // same slug
    expect(json.data.projectId).toBe(PROJECT);
    expect(f.state.movedTo).toBe(PROJECT);
    expect(f.state.copies).toBe(0); // move never copies
  });

  test("AS-008: an owner may move", async () => {
    const app = buildApp({ resolveDocRole: asRole("owner") });
    const res = await app.handle(req("POST", "/api/w/ws_1/docs/billing-doc/move", { projectId: PROJECT }));
    expect(res.status).toBe(200);
  });

  test("AS-008: a workspace admin may move with no doc role", async () => {
    const app = buildApp({ resolveDocRole: asRole(null), isWorkspaceAdmin: () => true });
    const res = await app.handle(req("POST", "/api/w/ws_1/docs/billing-doc/move", { projectId: PROJECT }));
    expect(res.status).toBe(200);
  });

  test("a viewer attempting MOVE → 403 (move mutates), nothing moved", async () => {
    const f = fakeRepo();
    const app = buildApp({ repo: f.repo, resolveDocRole: asRole("viewer") });
    const res = await app.handle(req("POST", "/api/w/ws_1/docs/billing-doc/move", { projectId: PROJECT }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe("FORBIDDEN");
    expect(f.state.movedTo).toBeNull();
  });

  test("no-access source → 404 MOVE (existence-hiding, not 403)", async () => {
    const app = buildApp({ resolveDocRole: asRole(null) });
    const res = await app.handle(req("POST", "/api/w/ws_1/docs/billing-doc/move", { projectId: PROJECT }));
    expect(res.status).toBe(404);
  });

  test("MOVE to a bad/cross-workspace target → 404", async () => {
    const { repo } = fakeRepo({ workspaceProjects: new Set(["p_billing"]) });
    const app = buildApp({ repo, resolveDocRole: asRole("editor") });
    const res = await app.handle(req("POST", "/api/w/ws_1/docs/billing-doc/move", { projectId: FOREIGN }));
    expect(res.status).toBe(404);
  });

  // Ids are opaque snowflake strings now (no uuid format to malform) — the validation layer
  // only guards an EMPTY projectId; a well-formed-but-nonexistent id is the resolver's job.
  test("MOVE empty projectId → 400 VALIDATION_ERROR", async () => {
    const app = buildApp({ resolveDocRole: asRole("editor") });
    const res = await app.handle(req("POST", "/api/w/ws_1/docs/billing-doc/move", { projectId: "" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("VALIDATION_ERROR");
  });

  test("no session → 401 MOVE (handler never runs)", async () => {
    const f = fakeRepo();
    const app = buildApp({ repo: f.repo, resolveSession: noSession });
    const res = await app.handle(req("POST", "/api/w/ws_1/docs/billing-doc/move", { projectId: PROJECT }));
    expect(res.status).toBe(401);
    expect(f.state.movedTo).toBeNull();
  });

  test("AS-013: a reader copies the doc → 201 { new docId, new slug, projectId }", async () => {
    const f = fakeRepo();
    const app = buildApp({ repo: f.repo, resolveDocRole: asRole("viewer") });
    const res = await app.handle(req("POST", "/api/w/ws_1/docs/billing-doc/copy", { projectId: PROJECT }));
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.data.docId).toBe("doc_copy"); // a NEW doc
    expect(json.data.slug).toBe("copy-slug-abc"); // a NEW slug
    expect(json.data.projectId).toBe(PROJECT);
    expect(f.state.copies).toBe(1);
    expect(f.state.movedTo).toBeNull(); // copy never moves the source
  });

  test("AS-013: no-access source → 404 COPY (existence-hiding)", async () => {
    const f = fakeRepo();
    const app = buildApp({ repo: f.repo, resolveDocRole: asRole(null) });
    const res = await app.handle(req("POST", "/api/w/ws_1/docs/billing-doc/copy", { projectId: PROJECT }));
    expect(res.status).toBe(404);
    expect(f.state.copies).toBe(0);
  });

  test("COPY to a bad target → 404, no copy made", async () => {
    const { repo, state } = fakeRepo({ workspaceProjects: new Set(["p_billing"]) });
    const app = buildApp({ repo, resolveDocRole: asRole("viewer") });
    const res = await app.handle(req("POST", "/api/w/ws_1/docs/billing-doc/copy", { projectId: FOREIGN }));
    expect(res.status).toBe(404);
    expect(state.copies).toBe(0);
  });

  test("no session → 401 COPY", async () => {
    const app = buildApp({ resolveSession: noSession });
    const res = await app.handle(req("POST", "/api/w/ws_1/docs/billing-doc/copy", { projectId: PROJECT }));
    expect(res.status).toBe(401);
  });
});
