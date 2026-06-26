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
  // project-visibility S-005: workspace-shared by default (the common case).
  workspaceRole: "commenter",
};

function fakeRepo(
  opts: {
    doc?: SourceDoc | null;
    workspaceProjects?: Set<string>;
    notViewable?: Set<string>;
    /** project-visibility S-005: per-target access class. Unset → non-default PUBLIC (no boundary). */
    targetAccess?: Map<string, { isDefault: boolean; visibility: "private" | "public" }>;
  } = {},
) {
  const state = {
    movedTo: null as string | null,
    copies: 0,
    moveWithAccessTo: null as string | null,
    restricted: null as boolean | null,
  };
  const repo: DocMoveRepo = {
    async findDocBySlug(slug) {
      const doc = opts.doc === undefined ? SRC : opts.doc;
      return doc && doc.slug === slug ? doc : null;
    },
    async targetProjectViewableBy(projectId, _actorId) {
      // project-visibility S-002 / C-006: a target the actor cannot view (notViewable) is
      // refused identically to a missing one (existence-hiding — AS-009).
      if (opts.notViewable?.has(projectId)) return false;
      return (opts.workspaceProjects ?? new Set([PROJECT, "p_billing"])).has(projectId);
    },
    async targetProjectAccess(projectId) {
      // project-visibility S-005: default a non-default PUBLIC project so legacy moves are ordinary.
      return opts.targetAccess?.get(projectId) ?? { isDefault: false, visibility: "public" };
    },
    async currentVersion() {
      return { content: "current body", contentHash: "h" };
    },
    async setProjectId(_docId, projectId) {
      state.movedTo = projectId;
    },
    async moveWithAccess(_docId, projectId, restrict) {
      // project-visibility S-005 / C-009: the atomic move+restrict write (one tx in prod).
      state.moveWithAccessTo = projectId;
      state.restricted = restrict;
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

  test("AS-009: MOVE into a project the actor cannot SEE → 404 (existence-hiding, C-006), nothing moved", async () => {
    // FOREIGN exists in the workspace but is another member's PRIVATE project the actor can't
    // view → refused indistinguishably from a missing project (same 404 as the bad-target case),
    // so the move can't be used to probe for the private project's existence.
    const { repo, state } = fakeRepo({
      workspaceProjects: new Set([PROJECT, "p_billing", FOREIGN]),
      notViewable: new Set([FOREIGN]),
    });
    const app = buildApp({ repo, resolveDocRole: asRole("editor"), resolveSession: asUser("u_b") });
    const res = await app.handle(req("POST", "/api/w/ws_1/docs/billing-doc/move", { projectId: FOREIGN }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.code).toBe("NOT_FOUND");
    expect(state.movedTo).toBeNull();
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

  test("AS-021: a boundary-crossing MOVE with no accessChoice → 409 CONFLICT (server-enforced), nothing moved", async () => {
    // The target is a non-default PRIVATE project + the doc is workspace-shared (SRC default) →
    // the server detects the boundary and refuses with 409 unless an accessChoice is supplied. A
    // direct API call cannot bypass this — the FE dialog only COLLECTS the choice.
    const { repo, state } = fakeRepo({
      workspaceProjects: new Set([PROJECT, "p_billing"]),
      targetAccess: new Map([[PROJECT, { isDefault: false, visibility: "private" }]]),
    });
    const app = buildApp({ repo, resolveDocRole: asRole("owner") });
    const res = await app.handle(req("POST", "/api/w/ws_1/docs/billing-doc/move", { projectId: PROJECT }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("CONFLICT");
    // The refusal carries a STABLE machine-readable discriminator in the HTTP response body so
    // the FE keys on `reason`, not the 409 status or the human message text.
    expect(body.error.reason).toBe("visibility_boundary");
    expect(state.movedTo).toBeNull();
    expect(state.moveWithAccessTo).toBeNull(); // nothing moved or changed
  });

  test("AS-021 (negative): a DIFFERENT move refusal does NOT carry reason 'visibility_boundary'", async () => {
    // The move endpoint produces no OTHER 409 today, so the negative is asserted on a non-boundary
    // refusal path: a viewer attempting a move → 403 FORBIDDEN. Its body has NO `reason` field, so
    // the FE keying on `reason === "visibility_boundary"` can never mistake another refusal for the
    // boundary case (the whole point of the discriminator — distinct from any other conflict/error).
    const f = fakeRepo();
    const app = buildApp({ repo: f.repo, resolveDocRole: asRole("viewer") });
    const res = await app.handle(req("POST", "/api/w/ws_1/docs/billing-doc/move", { projectId: PROJECT }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.reason).toBeUndefined();
  });

  test("AS-022: a boundary-crossing MOVE with accessChoice=make_private → 200, moved + restricted (atomic)", async () => {
    const { repo, state } = fakeRepo({
      workspaceProjects: new Set([PROJECT, "p_billing"]),
      targetAccess: new Map([[PROJECT, { isDefault: false, visibility: "private" }]]),
    });
    const app = buildApp({ repo, resolveDocRole: asRole("owner") });
    const res = await app.handle(
      req("POST", "/api/w/ws_1/docs/billing-doc/move", { projectId: PROJECT, accessChoice: "make_private" }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.projectId).toBe(PROJECT);
    // Routed through the atomic move+access write with restrict=true; never the plain setProjectId.
    expect(state.moveWithAccessTo).toBe(PROJECT);
    expect(state.restricted).toBe(true);
    expect(state.movedTo).toBeNull();
  });

  test("AS-023: a boundary-crossing MOVE with accessChoice=keep_sharing → 200, moved, access unchanged", async () => {
    const { repo, state } = fakeRepo({
      workspaceProjects: new Set([PROJECT, "p_billing"]),
      targetAccess: new Map([[PROJECT, { isDefault: false, visibility: "private" }]]),
    });
    const app = buildApp({ repo, resolveDocRole: asRole("owner") });
    const res = await app.handle(
      req("POST", "/api/w/ws_1/docs/billing-doc/move", { projectId: PROJECT, accessChoice: "keep_sharing" }),
    );
    expect(res.status).toBe(200);
    expect(state.moveWithAccessTo).toBe(PROJECT);
    expect(state.restricted).toBe(false); // soft-private: share_links untouched
  });

  test("C-009: a bad accessChoice value → 400 VALIDATION_ERROR (enum guarded at the boundary)", async () => {
    const app = buildApp({ resolveDocRole: asRole("owner") });
    const res = await app.handle(
      req("POST", "/api/w/ws_1/docs/billing-doc/move", { projectId: PROJECT, accessChoice: "nuke_it" }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("VALIDATION_ERROR");
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
