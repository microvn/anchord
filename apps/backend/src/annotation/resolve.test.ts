import { test, expect } from "bun:test";
import { setResolution, type ResolutionRepo } from "./resolve";

// annotation-core S-004 — resolve / reopen an annotation. Pure authz + toggle logic
// against a fake repo (mirrors annotation.test.ts / reply pattern). The mark dim/undim
// UI is FRONTEND/integration [→MANUAL]; this module owns the SERVER-side authz
// (can(role,"resolve")) and the idempotent status toggle.

type Status = "unresolved" | "resolved";

// A fake repo backing one annotation's status. Records every write so a no-op write is
// still observable, and serves the current status back to setResolution if it reads.
function fakeRepo(initial: Status = "unresolved"): ResolutionRepo & {
  status: Status;
  writes: Status[];
} {
  const state = { status: initial, writes: [] as Status[] };
  return {
    get status() {
      return state.status;
    },
    get writes() {
      return state.writes;
    },
    async setAnnotationStatus(_id: string, status: Status) {
      state.status = status;
      state.writes.push(status);
    },
  };
}

test("AS-009: resolve then reopen toggles status resolved -> unresolved", async () => {
  // Given an unresolved annotation.
  const repo = fakeRepo("unresolved");

  // When the user clicks resolve...
  const r1 = await setResolution(
    { annotationId: "ann-1", resolved: true, sessionRole: "commenter" },
    repo,
  );
  // Then status -> resolved (the mark dims).
  expect(r1).toEqual({ ok: true, status: "resolved" });
  expect(repo.status).toBe("resolved");

  // ...then reopen.
  const r2 = await setResolution(
    { annotationId: "ann-1", resolved: false, sessionRole: "commenter" },
    repo,
  );
  // Then status -> unresolved (the mark undims). Data: toggled twice.
  expect(r2).toEqual({ ok: true, status: "unresolved" });
  expect(repo.status).toBe("unresolved");

  // Toggle a third time to prove resolve->reopen->resolve works (AS-009 idempotent toggle).
  const r3 = await setResolution(
    { annotationId: "ann-1", resolved: true, sessionRole: "commenter" },
    repo,
  );
  expect(r3).toEqual({ ok: true, status: "resolved" });
  expect(repo.status).toBe("resolved");
});

test("AS-010: anyone with comment permission can resolve, not only the creator", async () => {
  // Given an annotation created by user A; user B (NOT the creator) has commenter permission.
  // The actor's relationship to the creator is irrelevant — only the role matters, so
  // setResolution takes no author/creator field at all. B resolves with role=commenter.
  const repo = fakeRepo("unresolved");

  const res = await setResolution(
    { annotationId: "ann-by-A", resolved: true, sessionRole: "commenter" },
    repo,
  );

  // Then it becomes resolved (resolving isn't limited to the creator).
  expect(res).toEqual({ ok: true, status: "resolved" });
  expect(repo.status).toBe("resolved");
});

test("C-005: editor and owner can also resolve/reopen (comment-permission-or-higher)", async () => {
  for (const role of ["commenter", "editor", "owner"] as const) {
    const repo = fakeRepo("unresolved");
    const res = await setResolution(
      { annotationId: "ann-1", resolved: true, sessionRole: role },
      repo,
    );
    expect(res).toEqual({ ok: true, status: "resolved" });
    expect(repo.status).toBe("resolved");
  }
});

test("C-005: a viewer is forbidden to resolve — nothing changes", async () => {
  // Edge / error path: viewer lacks the "resolve" capability. The status must not move
  // and the repo must never be written (server-side authz, like S-001 create).
  const repo = fakeRepo("unresolved");

  const res = await setResolution(
    { annotationId: "ann-1", resolved: true, sessionRole: "viewer" },
    repo,
  );

  expect(res).toEqual({ ok: false, reason: "forbidden" });
  expect(repo.status).toBe("unresolved");
  expect(repo.writes).toHaveLength(0);
});

test("C-005: resolving an already-resolved annotation is an idempotent no-op", async () => {
  // Boundary: resolve when already resolved → still resolved, returns resolved.
  const repo = fakeRepo("resolved");

  const res = await setResolution(
    { annotationId: "ann-1", resolved: true, sessionRole: "commenter" },
    repo,
  );

  expect(res).toEqual({ ok: true, status: "resolved" });
  expect(repo.status).toBe("resolved");
});
