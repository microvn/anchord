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
  // project-visibility S-005: the doc is workspace-shared by default (the common case).
  workspaceRole: "commenter",
};

/** A fake repo recording move + copy effects, with seeded versions for the copy path. */
function fakeRepo(opts: {
  doc?: SourceDoc | null;
  workspaceProjects?: Set<string>;
  /** project-visibility S-002 / C-006: targets the actor canNOT view (private of another member). */
  notViewable?: Set<string>;
  versions?: { content: string; contentHash: string }[]; // ascending; last = current
  /** project-visibility S-005: per-target access class (isDefault + visibility). Unset → public. */
  targetAccess?: Map<string, { isDefault: boolean; visibility: "private" | "public" }>;
} = {}) {
  const state = {
    movedTo: null as string | null,
    copies: [] as Parameters<DocMoveRepo["createCopy"]>[0][],
    setProjectIdCalls: 0,
    copyN: 0,
    // project-visibility S-005: the atomic move+access write. Records the relocation + whether
    // the doc was restricted, so a test can assert both happened in the SAME call (one tx).
    moveWithAccessCalls: 0,
    moveWithAccessTo: null as string | null,
    restricted: null as boolean | null,
  };
  const versions = opts.versions ?? [{ content: "v3 body", contentHash: "h3" }];
  const repo: DocMoveRepo = {
    async findDocBySlug(slug) {
      const doc = opts.doc === undefined ? SRC : opts.doc;
      return doc && doc.slug === slug ? doc : null;
    },
    async targetProjectViewableBy(projectId, _actorId) {
      // project-visibility S-002 / C-006: the fake mirrors "the actor may VIEW this target".
      // The default set is the viewable targets; a `notViewable` set models a private project
      // the actor cannot see (→ refused, indistinguishable from not-found — AS-009).
      if (opts.notViewable?.has(projectId)) return false;
      return (opts.workspaceProjects ?? new Set(["p_billing", "p_payments"])).has(projectId);
    },
    async targetProjectAccess(projectId) {
      // project-visibility S-005: default = a non-default PUBLIC project (no boundary crossing),
      // so the legacy AS-008 moves stay ordinary. Tests override per-target for the crossing path.
      return opts.targetAccess?.get(projectId) ?? { isDefault: false, visibility: "public" };
    },
    async currentVersion(_docId) {
      return versions.length ? versions[versions.length - 1]! : null;
    },
    async setProjectId(_docId, projectId) {
      state.movedTo = projectId;
      state.setProjectIdCalls++;
    },
    async moveWithAccess(_docId, projectId, restrict) {
      // project-visibility S-005 / C-009: the ONE atomic write — relocation + (optional) restrict
      // together. The fake records both in a single call so the test asserts no half-state.
      state.moveWithAccessCalls++;
      state.moveWithAccessTo = projectId;
      state.restricted = restrict;
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

  // ── project-visibility S-005 / C-009: boundary-crossing move requires an explicit choice ──
  // The crossing case across these tests: a workspace-shared doc (workspaceRole=commenter) moved
  // into a NON-DEFAULT PRIVATE target ("p_private"). The fake reports that target as private.
  const crossingTargets = () =>
    new Map([["p_private", { isDefault: false, visibility: "private" as const }]]);

  test("AS-021: a boundary-crossing move WITHOUT accessChoice is refused (server-enforced); nothing moved, share_links untouched", async () => {
    const f = fakeRepo({
      workspaceProjects: new Set(["p_billing", "p_private"]),
      targetAccess: crossingTargets(),
    });
    await expect(
      moveDoc(
        // No accessChoice supplied — the server MUST refuse a crossing move, not silently decide.
        { slug: "billing-doc", targetProjectId: "p_private", actorId: "u_owner" },
        deps(f.repo, "owner"),
      ),
    ).rejects.toMatchObject({ code: "needs_choice" });
    // Nothing moved, nothing changed — neither the plain move nor the atomic move+access fired.
    expect(f.state.movedTo).toBeNull();
    expect(f.state.setProjectIdCalls).toBe(0);
    expect(f.state.moveWithAccessCalls).toBe(0);
    expect(f.state.restricted).toBeNull();
  });

  test("AS-022: accessChoice=make_private moves AND restricts in ONE atomic write (no half-state)", async () => {
    const f = fakeRepo({
      workspaceProjects: new Set(["p_billing", "p_private"]),
      targetAccess: crossingTargets(),
    });
    const res = await moveDoc(
      { slug: "billing-doc", targetProjectId: "p_private", actorId: "u_owner", accessChoice: "make_private" },
      deps(f.repo, "owner"),
    );
    expect(res.projectId).toBe("p_private");
    // The move + access change happen via the SINGLE atomic call (one tx), restrict=true; the
    // plain non-atomic setProjectId is NEVER used on a crossing move (would be a half-state risk).
    expect(f.state.moveWithAccessCalls).toBe(1);
    expect(f.state.moveWithAccessTo).toBe("p_private");
    expect(f.state.restricted).toBe(true);
    expect(f.state.setProjectIdCalls).toBe(0);
  });

  test("AS-023: accessChoice=keep_sharing moves but leaves share_links unchanged (soft-private)", async () => {
    const f = fakeRepo({
      workspaceProjects: new Set(["p_billing", "p_private"]),
      targetAccess: crossingTargets(),
    });
    const res = await moveDoc(
      { slug: "billing-doc", targetProjectId: "p_private", actorId: "u_owner", accessChoice: "keep_sharing" },
      deps(f.repo, "owner"),
    );
    expect(res.projectId).toBe("p_private");
    // Still the atomic move path (one tx), but restrict=false → share_links is NOT touched: the
    // doc stays workspace=commenter inside the private project (soft-private).
    expect(f.state.moveWithAccessCalls).toBe(1);
    expect(f.state.restricted).toBe(false);
    expect(f.state.setProjectIdCalls).toBe(0);
  });

  test("C-009: a NON-crossing move (shared doc → public target) needs no choice and behaves as before (no regression)", async () => {
    // Target is the default non-default PUBLIC (the fake default) → no boundary → an ordinary
    // setProjectId move, even though the doc is workspace-shared and no accessChoice was given.
    const f = fakeRepo();
    const res = await moveDoc(
      { slug: "billing-doc", targetProjectId: "p_payments", actorId: "u_owner" },
      deps(f.repo, "owner"),
    );
    expect(res.projectId).toBe("p_payments");
    expect(f.state.setProjectIdCalls).toBe(1); // ordinary move
    expect(f.state.moveWithAccessCalls).toBe(0); // no atomic access change
  });

  test("C-009: an already-restricted doc moving into a private project does NOT cross (no choice needed)", async () => {
    // workspaceRole=null ⇒ the doc is already restricted; moving it into a private project implies
    // no access change → no boundary → ordinary move, no accessChoice required.
    const f = fakeRepo({
      doc: { ...SRC, workspaceRole: null },
      workspaceProjects: new Set(["p_billing", "p_private"]),
      targetAccess: crossingTargets(),
    });
    const res = await moveDoc(
      { slug: "billing-doc", targetProjectId: "p_private", actorId: "u_owner" },
      deps(f.repo, "owner"),
    );
    expect(res.projectId).toBe("p_private");
    expect(f.state.setProjectIdCalls).toBe(1);
    expect(f.state.moveWithAccessCalls).toBe(0);
  });

  test("AS-009: moving into a project the actor cannot SEE is refused as not-found (existence-hiding, C-006)", async () => {
    // The target exists in the workspace but is another member's PRIVATE project the actor
    // can't view → targetProjectViewableBy returns false → 404, indistinguishable from a
    // missing project (B cannot use the move to confirm the private project exists).
    const f = fakeRepo({
      workspaceProjects: new Set(["p_billing", "p_a_private"]),
      notViewable: new Set(["p_a_private"]),
    });
    await expect(
      moveDoc(
        { slug: "billing-doc", targetProjectId: "p_a_private", actorId: "u_b" },
        deps(f.repo, "editor"),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(f.state.movedTo).toBeNull(); // nothing mutated
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

  test("C-007: copy carries no per-doc access into createCopy — the repo applies the fixed new-doc default", async () => {
    // doc-access-two-axis S-002 (C-007): a copy is a fresh doc whose share_links access
    // config is created by the repo with the FIXED new-doc default (workspace_role=
    // commenter, link_role=null), NOT inherited from the source and NOT a per-workspace
    // setting. So the service must NOT plumb any access value into createCopy.
    const f = fakeRepo();
    await copyDoc(
      { slug: "billing-doc", targetProjectId: "p_payments", actorId: "u_reader" },
      deps(f.repo, "viewer"),
    );
    expect(f.state.copies).toHaveLength(1);
    expect(f.state.copies[0]!).not.toHaveProperty("generalAccess");
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
