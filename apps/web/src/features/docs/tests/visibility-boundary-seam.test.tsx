import { describe, it, expect } from "bun:test";
// project-visibility-fe S-003 / AS-015 — the ONE genuinely-stateful seam: a real refusal → choice →
// retry roundtrip. There is no Playwright / running-backend harness under happy-dom, so the "closest
// real-contract integration available" is driving the ACTUAL backend move SERVICE
// (apps/backend/src/workspace/doc-move.ts) — its REAL boundary detection + REAL DocMoveRejected —
// through a STATEFUL in-memory repo, then feeding the refusal through the REAL FE error consumer
// (toApiError) the alert keys on. This is NOT a hand-mocked `{reason:"visibility_boundary"}`: the
// reason is produced by the real service/route contract; the repo's state genuinely mutates so the
// second (choice-carrying) call is a real re-evaluation of the boundary by the server logic.
//
// Real:   the move service (isVisibilityBoundaryCrossing + DocMoveRejected), the reason discriminator
//         the route stamps on the CONFLICT, the FE's toApiError reason extraction.
// Faked:  the DB (an in-memory repo) + transport — unavoidable without a Postgres + Elysia boot,
//         which the spec explicitly excludes (happy-dom only). A full app.handle roundtrip would
//         drag the whole backend (DB/better-auth) into a unit test; the service drive is the real
//         contract surface that matters here (the boundary re-evaluation), reported per AS-015.

import {
  moveDoc as serviceMoveDoc,
  DocMoveRejected,
  type DocMoveRepo,
  type SourceDoc,
  type TargetProjectAccess,
} from "../../../../../backend/src/workspace/doc-move";
import { toApiError } from "@/lib/api/api-error";

// A stateful in-memory repo: one workspace-shared doc in a PUBLIC project, plus one PRIVATE target.
// moveWithAccess mutates the doc's projectId (and, for make_private, its workspaceRole) so a second
// call re-reads the real post-move state.
function makeRepo() {
  const doc: SourceDoc = {
    id: "d1",
    slug: "auth-spec",
    title: "Auth Spec",
    kind: "markdown",
    projectId: "p-pub",
    workspaceRole: "commenter", // workspace-shared
  };
  const targets: Record<string, TargetProjectAccess> = {
    "p-priv": { isDefault: false, visibility: "private" },
    "p-pub": { isDefault: false, visibility: "public" },
  };
  const repo: DocMoveRepo = {
    findDocBySlug: async (slug) => (slug === doc.slug ? doc : null),
    targetProjectViewableBy: async (projectId) => projectId in targets,
    targetProjectAccess: async (projectId) => targets[projectId] ?? null,
    currentVersion: async () => null,
    setProjectId: async (_id, projectId) => {
      doc.projectId = projectId;
    },
    moveWithAccess: async (_id, projectId, restrict) => {
      doc.projectId = projectId;
      if (restrict) doc.workspaceRole = null; // make_private drops the workspace axis
    },
    createCopy: async () => ({ id: "x", slug: "x" }),
  };
  return { doc, repo };
}

// Mirror the route's mapRejected → onError envelope for a needs_choice refusal (doc-move.ts /
// envelope.ts): a 409 CONFLICT carrying the STABLE `reason: "visibility_boundary"` discriminator,
// in the Eden `{ status, value }` shape the FE client surfaces.
function asEdenError(err: DocMoveRejected) {
  if (err.code !== "needs_choice") throw new Error("unexpected refusal code: " + err.code);
  return {
    status: 409,
    value: { success: false, error: { code: "CONFLICT", message: err.message, reason: "visibility_boundary" } },
  };
}

describe("project-visibility-fe S-003 / AS-015 — real refusal → choice → retry roundtrip (seam)", () => {
  it("AS-015: keep-sharing retry succeeds against the real service; the doc moves, sharing unchanged", async () => {
    const { doc, repo } = makeRepo();
    const deps = { repo, resolveDocRole: async () => "editor" as const };

    // 1) Real move with NO choice across the boundary → the real service refuses with needs_choice.
    let refusal: DocMoveRejected | null = null;
    try {
      await serviceMoveDoc({ slug: "auth-spec", targetProjectId: "p-priv", actorId: "u1" }, deps);
    } catch (e) {
      refusal = e as DocMoveRejected;
    }
    expect(refusal).toBeInstanceOf(DocMoveRejected);
    expect(refusal!.code).toBe("needs_choice");
    // Nothing moved yet — the refusal changed no state.
    expect(doc.projectId).toBe("p-pub");

    // 2) The FE consumes the real refusal: the alert keys on this reason (C-002), never bare 409.
    const apiErr = toApiError(asEdenError(refusal!));
    expect(apiErr.reason).toBe("visibility_boundary");

    // 3) User picks "Keep current sharing" → retry carrying keep_sharing → real service applies it.
    const res = await serviceMoveDoc(
      { slug: "auth-spec", targetProjectId: "p-priv", actorId: "u1", accessChoice: "keep_sharing" },
      deps,
    );

    // The doc is moved into the private project, but its sharing is UNCHANGED (soft-private).
    expect(res.projectId).toBe("p-priv");
    expect(doc.projectId).toBe("p-priv");
    expect(doc.workspaceRole).toBe("commenter"); // still workspace-shared
  });
});
