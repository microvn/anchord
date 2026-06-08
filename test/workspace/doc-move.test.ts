// Unit tests for the move/copy doc service (workspace-project S-004). Pure logic over
// fake repos: the validate-target + authz + move (project_id only) + copy (current →
// new doc v1, no annotations, source unchanged) rules — no DB, no HTTP.
//
// AS map (workspace-project S-004):
//   AS-008  move a doc to another project; only project_id changes (everything else kept)
//   AS-013  copy a doc → NEW doc, new slug, current version as v1, NO annotations
//   C-008   copy = new doc no annotations; move = doc as-is

import { describe, expect, test } from "bun:test";
import {
  moveDoc,
  copyDoc,
  DocMoveRejected,
  type DocMoveRepo,
  type SourceDoc,
  type DocMoveDeps,
} from "../../src/workspace/doc-move";
import type { Role } from "../../src/sharing/roles";

const SRC: SourceDoc = {
  id: "doc_src",
  slug: "billing-doc",
  title: "Billing Spec",
  kind: "markdown",
  projectId: "p_billing",
};

/** A fake repo recording move + copy effects, with seeded versions for the copy path. */
function fakeRepo(opts: {
  doc?: SourceDoc | null;
  workspaceProjects?: Set<string>;
  versions?: { content: string; contentHash: string }[]; // ascending; last = current
} = {}) {
  const state = {
    movedTo: null as string | null,
    copies: [] as Parameters<DocMoveRepo["createCopy"]>[0][],
    setProjectIdCalls: 0,
    copyN: 0,
  };
  const versions = opts.versions ?? [{ content: "v3 body", contentHash: "h3" }];
  const repo: DocMoveRepo = {
    async findDocBySlug(slug) {
      const doc = opts.doc === undefined ? SRC : opts.doc;
      return doc && doc.slug === slug ? doc : null;
    },
    async projectInWorkspace(projectId) {
      return (opts.workspaceProjects ?? new Set(["p_billing", "p_payments"])).has(projectId);
    },
    async currentVersion(_docId) {
      return versions.length ? versions[versions.length - 1]! : null;
    },
    async setProjectId(_docId, projectId) {
      state.movedTo = projectId;
      state.setProjectIdCalls++;
    },
    async createCopy(input) {
      state.copies.push(input);
      return { id: `doc_copy_${++state.copyN}`, slug: `copy-slug-${state.copyN}` };
    },
  };
  return { repo, state };
}

const asRole =
  (role: Role | null) =>
  async (): Promise<Role | null> =>
    role;

function deps(
  repo: DocMoveRepo,
  role: Role | null,
  extra: Partial<DocMoveDeps> = {},
): DocMoveDeps {
  return {
    repo,
    resolveDocRole: asRole(role),
    extractText: (content) => `extracted:${content}`,
    ...extra,
  };
}

describe("moveDoc (workspace-project S-004)", () => {
  test("AS-008: move updates ONLY project_id (Billing → Payments); slug/id unchanged", async () => {
    const f = fakeRepo();
    const res = await moveDoc(
      { slug: "billing-doc", targetProjectId: "p_payments", actorId: "u_editor" },
      deps(f.repo, "editor"),
    );
    expect(res.docId).toBe("doc_src"); // same doc id
    expect(res.slug).toBe("billing-doc"); // same slug
    expect(res.projectId).toBe("p_payments");
    expect(f.state.movedTo).toBe("p_payments");
    // The only write is setProjectId — no copy was created (the doc is relocated, not duplicated).
    expect(f.state.copies).toHaveLength(0);
  });

  test("AS-008: owner may move", async () => {
    const f = fakeRepo();
    const res = await moveDoc(
      { slug: "billing-doc", targetProjectId: "p_payments", actorId: "u_owner" },
      deps(f.repo, "owner"),
    );
    expect(res.projectId).toBe("p_payments");
  });

  test("C-008: a viewer cannot move (move mutates) → 403 forbidden, nothing moved", async () => {
    const f = fakeRepo();
    const p = moveDoc(
      { slug: "billing-doc", targetProjectId: "p_payments", actorId: "u_viewer" },
      deps(f.repo, "viewer"),
    );
    await expect(p).rejects.toMatchObject({ code: "forbidden" });
    expect(f.state.movedTo).toBeNull();
  });

  test("C-008: a commenter cannot move → 403 forbidden", async () => {
    const f = fakeRepo();
    await expect(
      moveDoc(
        { slug: "billing-doc", targetProjectId: "p_payments", actorId: "u_c" },
        deps(f.repo, "commenter"),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  test("AS-008: a workspace admin may move even with no doc-scoped role", async () => {
    const f = fakeRepo();
    const res = await moveDoc(
      { slug: "billing-doc", targetProjectId: "p_payments", actorId: "u_admin" },
      deps(f.repo, null, { isWorkspaceAdmin: () => true }),
    );
    expect(res.projectId).toBe("p_payments");
  });

  test("existence-hiding: a source the actor cannot access at all → 404 (not 403)", async () => {
    const f = fakeRepo();
    await expect(
      moveDoc(
        { slug: "billing-doc", targetProjectId: "p_payments", actorId: "u_nobody" },
        deps(f.repo, null),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(f.state.movedTo).toBeNull();
  });

  test("missing source slug → 404", async () => {
    const f = fakeRepo({ doc: null });
    await expect(
      moveDoc(
        { slug: "nope", targetProjectId: "p_payments", actorId: "u_editor" },
        deps(f.repo, "editor"),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("target project not in workspace → 404, nothing mutated", async () => {
    const f = fakeRepo({ workspaceProjects: new Set(["p_billing"]) });
    await expect(
      moveDoc(
        { slug: "billing-doc", targetProjectId: "p_foreign", actorId: "u_editor" },
        deps(f.repo, "editor"),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(f.state.movedTo).toBeNull();
  });

  test("move to the SAME project is an idempotent no-op (still ok)", async () => {
    const f = fakeRepo();
    const res = await moveDoc(
      { slug: "billing-doc", targetProjectId: "p_billing", actorId: "u_editor" },
      deps(f.repo, "editor"),
    );
    expect(res.projectId).toBe("p_billing");
    expect(f.state.movedTo).toBe("p_billing");
    expect(f.state.setProjectIdCalls).toBe(1);
  });
});

describe("copyDoc (workspace-project S-004)", () => {
  test("AS-013: copy creates a NEW doc with a NEW slug, current version as v1", async () => {
    const f = fakeRepo({
      versions: [
        { content: "v1 body", contentHash: "h1" },
        { content: "v2 body", contentHash: "h2" },
        { content: "v3 body", contentHash: "h3" }, // current
      ],
    });
    const res = await copyDoc(
      { slug: "billing-doc", targetProjectId: "p_payments", actorId: "u_reader" },
      deps(f.repo, "viewer"),
    );
    expect(res.docId).not.toBe("doc_src"); // a NEW doc
    expect(res.slug).not.toBe("billing-doc"); // a NEW slug
    expect(res.projectId).toBe("p_payments");
    expect(f.state.copies).toHaveLength(1);
    const copy = f.state.copies[0]!;
    // v1 content = the source's CURRENT (v3) content, hash recomputed/carried.
    expect(copy.content).toBe("v3 body");
    expect(copy.contentHash).toBe("h3");
    // owner = the copier, project = target, extracted text recomputed.
    expect(copy.ownerId).toBe("u_reader");
    expect(copy.projectId).toBe("p_payments");
    expect(copy.extractedText).toBe("extracted:v3 body");
    // title kept from source (documented decision).
    expect(copy.title).toBe("Billing Spec");
    expect(copy.kind).toBe("markdown");
  });

  test("C-008: copy does NOT relocate the source (no setProjectId) — source unchanged", async () => {
    const f = fakeRepo();
    await copyDoc(
      { slug: "billing-doc", targetProjectId: "p_payments", actorId: "u_reader" },
      deps(f.repo, "viewer"),
    );
    expect(f.state.movedTo).toBeNull(); // source not moved
    expect(f.state.setProjectIdCalls).toBe(0);
  });

  test("AS-013: read access (viewer) is enough to copy", async () => {
    const f = fakeRepo();
    const res = await copyDoc(
      { slug: "billing-doc", targetProjectId: "p_payments", actorId: "u_v" },
      deps(f.repo, "viewer"),
    );
    expect(res.slug).toBeTruthy();
  });

  test("existence-hiding: a source the actor cannot access at all → 404, no copy made", async () => {
    const f = fakeRepo();
    await expect(
      copyDoc(
        { slug: "billing-doc", targetProjectId: "p_payments", actorId: "u_nobody" },
        deps(f.repo, null),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(f.state.copies).toHaveLength(0);
  });

  test("copy target not in workspace → 404, no copy made", async () => {
    const f = fakeRepo({ workspaceProjects: new Set(["p_billing"]) });
    await expect(
      copyDoc(
        { slug: "billing-doc", targetProjectId: "p_foreign", actorId: "u_reader" },
        deps(f.repo, "viewer"),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(f.state.copies).toHaveLength(0);
  });

  test("copy a source with no versions → 404 (nothing to seed v1)", async () => {
    const f = fakeRepo({ versions: [] });
    await expect(
      copyDoc(
        { slug: "billing-doc", targetProjectId: "p_payments", actorId: "u_reader" },
        deps(f.repo, "viewer"),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("DocMoveRejected is the thrown type", async () => {
    const f = fakeRepo({ doc: null });
    try {
      await copyDoc(
        { slug: "x", targetProjectId: "p_payments", actorId: "u" },
        deps(f.repo, "viewer"),
      );
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DocMoveRejected);
    }
  });
});
