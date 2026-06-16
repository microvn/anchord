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
  suggestionResets: string[];
} {
  const state = { status: initial, writes: [] as Status[], suggestionResets: [] as string[] };
  return {
    get status() {
      return state.status;
    },
    get writes() {
      return state.writes;
    },
    get suggestionResets() {
      return state.suggestionResets;
    },
    async setAnnotationStatus(_id: string, status: Status) {
      state.status = status;
      state.writes.push(status);
    },
    // S-006 / AS-026 / C-016: records a decided-suggestion reset to pending.
    async resetSuggestionStatusToPending(id: string) {
      state.suggestionResets.push(id);
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

// ── S-006 / AS-026 / C-016: reopening a DECIDED suggestion (owner-only reset) ──

test("AS-026 / C-016: the OWNER reopening an accepted suggestion resets it to pending and unresolves the thread", async () => {
  // Given a suggestion the owner already accepted (its thread auto-resolved).
  const repo = fakeRepo("resolved");

  // When the OWNER reopens it (resolved=false) — and the annotation is a DECIDED suggestion.
  const res = await setResolution(
    { annotationId: "sug-1", resolved: false, sessionRole: "owner", suggestionStatus: "accepted" },
    repo,
  );

  // Then the thread returns to unresolved AND the suggestion_status is reset to pending.
  expect(res).toEqual({ ok: true, status: "unresolved", suggestionStatus: "pending" });
  expect(repo.status).toBe("unresolved");
  expect(repo.suggestionResets).toEqual(["sug-1"]);
});

test("AS-026 / C-016: a rejected suggestion is also reset to pending on owner reopen", async () => {
  const repo = fakeRepo("resolved");
  const res = await setResolution(
    { annotationId: "sug-2", resolved: false, sessionRole: "owner", suggestionStatus: "rejected" },
    repo,
  );
  expect(res).toEqual({ ok: true, status: "unresolved", suggestionStatus: "pending" });
  expect(repo.suggestionResets).toEqual(["sug-2"]);
});

test("AS-026 / C-016: a NON-OWNER (commenter) reopening a DECIDED suggestion is refused — nothing changes", async () => {
  // Distinct from an ordinary reopen (any commenter may toggle, C-005): reopening a DECIDED
  // suggestion is OWNER-only, so even a commenter who could toggle an ordinary thread is refused.
  const repo = fakeRepo("resolved");

  const res = await setResolution(
    { annotationId: "sug-1", resolved: false, sessionRole: "commenter", suggestionStatus: "accepted" },
    repo,
  );

  expect(res).toEqual({ ok: false, reason: "forbidden" });
  expect(repo.status).toBe("resolved"); // untouched
  expect(repo.writes).toHaveLength(0);
  expect(repo.suggestionResets).toHaveLength(0);
});

test("AS-026 / C-016: RESOLVING a decided suggestion (resolved=true) stays the ordinary commenter+ path (not owner-gated)", async () => {
  // Only REOPEN of a decided suggestion is owner-only; resolving the thread is still C-005.
  const repo = fakeRepo("unresolved");
  const res = await setResolution(
    { annotationId: "sug-1", resolved: true, sessionRole: "commenter", suggestionStatus: "accepted" },
    repo,
  );
  expect(res).toEqual({ ok: true, status: "resolved" });
  expect(repo.suggestionResets).toHaveLength(0); // resolve never resets the decision
});

test("C-016: reopening a PENDING suggestion is the ordinary path — a commenter may toggle, no reset", async () => {
  // A pending (un-decided) suggestion has no decision to clear, so its reopen is the ordinary
  // commenter+ toggle (C-005), NOT the owner-gated reset.
  const repo = fakeRepo("resolved");
  const res = await setResolution(
    { annotationId: "sug-1", resolved: false, sessionRole: "commenter", suggestionStatus: "pending" },
    repo,
  );
  expect(res).toEqual({ ok: true, status: "unresolved" });
  expect(repo.suggestionResets).toHaveLength(0);
});

test("AS-015: resolve / reopen on a SOFT-DELETED annotation is REFUSED (terminal) — reads as gone, status untouched", async () => {
  // annotation-actions S-005 / C-007: a soft-deleted annotation is TERMINAL — neither resolve
  // (resolved=true) nor reopen (resolved=false) may change its status, so a concurrent
  // delete + resolve can never desync. Refused as not_found (existence-hiding), checked BEFORE
  // any authz/toggle so the repo is never written. Even an OWNER (highest role) is refused.
  const resolveRepo = fakeRepo("unresolved");
  const onResolve = await setResolution(
    { annotationId: "ann-del", resolved: true, sessionRole: "owner", deleted: true },
    resolveRepo,
  );
  expect(onResolve).toEqual({ ok: false, reason: "not_found" });
  expect(resolveRepo.writes).toHaveLength(0); // never written — terminal.

  const reopenRepo = fakeRepo("resolved");
  const onReopen = await setResolution(
    { annotationId: "ann-del", resolved: false, sessionRole: "commenter", deleted: true },
    reopenRepo,
  );
  expect(onReopen).toEqual({ ok: false, reason: "not_found" });
  expect(reopenRepo.writes).toHaveLength(0);

  // The terminal refusal takes precedence over the owner-only decided-suggestion reopen path:
  // a deleted decided suggestion still reads as gone (no reset of suggestion_status either).
  const decidedRepo = fakeRepo("resolved");
  const onDeletedDecided = await setResolution(
    { annotationId: "sug-del", resolved: false, sessionRole: "owner", suggestionStatus: "accepted", deleted: true },
    decidedRepo,
  );
  expect(onDeletedDecided).toEqual({ ok: false, reason: "not_found" });
  expect(decidedRepo.suggestionResets).toHaveLength(0);
});
