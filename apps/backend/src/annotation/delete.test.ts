import { test, expect } from "bun:test";
import { deleteAnnotation, type DeleteRepo } from "./delete";

// annotation-actions S-004 — delete (soft) an annotation: own, or owner moderation.
// Pure authz + the soft-delete write against a fake repo (mirrors resolve.test.ts). The
// route owns session-required + existence-hiding 404 + parent-doc binding; this module owns
// the own/owner authorization (C-006) and stamping the tombstone via setDeletedAt.

// A fake DeleteRepo recording every soft-delete write so a no-op (forbidden) path is
// observable — the annotation must be untouched when the actor isn't author or owner.
function fakeRepo(): DeleteRepo & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    get deleted() {
      return deleted;
    },
    async setDeletedAt(annotationId: string) {
      deleted.push(annotationId);
    },
  };
}

test("AS-008: an author (account-holder whose author_id is the actor) deletes their own → soft-deleted", async () => {
  // Given an annotation created by commenter Lan (author_id = Lan); Lan is signed in (commenter, NOT owner).
  const repo = fakeRepo();
  const res = await deleteAnnotation(
    { annotationId: "ann-lan", actorUserId: "u_lan", sessionRole: "commenter", authorId: "u_lan" },
    repo,
  );
  // Then it is soft-deleted (the tombstone write fired for this id), authorized by delete-own — not role.
  expect(res).toEqual({ ok: true });
  expect(repo.deleted).toEqual(["ann-lan"]);
});

test("AS-009: the owner (≠ author) deletes another person's annotation (moderation) → soft-deleted", async () => {
  // Given Lan's annotation on a doc owned by Sara; Sara acts as owner, is NOT the author.
  const repo = fakeRepo();
  const res = await deleteAnnotation(
    { annotationId: "ann-lan", actorUserId: "u_sara", sessionRole: "owner", authorId: "u_lan" },
    repo,
  );
  // Then it is soft-deleted by owner-moderation (delete-any), even though Sara didn't author it.
  expect(res).toEqual({ ok: true });
  expect(repo.deleted).toEqual(["ann-lan"]);
});

test("AS-010: a non-owner non-author (Bob, commenter) cannot delete someone else's → refused, unchanged", async () => {
  // Bob has commenter permission but is neither the author (Lan) nor the owner.
  const repo = fakeRepo();
  const res = await deleteAnnotation(
    { annotationId: "ann-lan", actorUserId: "u_bob", sessionRole: "commenter", authorId: "u_lan" },
    repo,
  );
  // Then refused; the repo is never written (the annotation is untouched).
  expect(res).toEqual({ ok: false, reason: "forbidden" });
  expect(repo.deleted).toHaveLength(0);
});

test("AS-011: a viewer cannot delete → refused, unchanged", async () => {
  // Error path: a viewer-only user (lacks both owner-moderation and authorship) on a doc with
  // someone else's annotation.
  const repo = fakeRepo();
  const res = await deleteAnnotation(
    { annotationId: "ann-1", actorUserId: "u_viewer", sessionRole: "viewer", authorId: "u_other" },
    repo,
  );
  expect(res).toEqual({ ok: false, reason: "forbidden" });
  expect(repo.deleted).toHaveLength(0);
});

test("C-006: a null author_id (guest-created) is NOT delete-own by anyone — only owner-moderation removes it", async () => {
  // Edge: a guest-created annotation has author_id null. A signed-in commenter (even one who
  // 'feels' like the creator) cannot delete-own it — null author matches no actor.
  const repo = fakeRepo();
  const asCommenter = await deleteAnnotation(
    { annotationId: "ann-guest", actorUserId: "u_anyone", sessionRole: "commenter", authorId: null },
    repo,
  );
  expect(asCommenter).toEqual({ ok: false, reason: "forbidden" });
  expect(repo.deleted).toHaveLength(0);

  // ...but the OWNER can still moderate-delete a guest-created annotation.
  const asOwner = await deleteAnnotation(
    { annotationId: "ann-guest", actorUserId: "u_owner", sessionRole: "owner", authorId: null },
    repo,
  );
  expect(asOwner).toEqual({ ok: true });
  expect(repo.deleted).toEqual(["ann-guest"]);
});

test("C-006: a null actor on a null-author annotation must NOT match delete-own (null === null is guarded)", async () => {
  // Boundary: the load-bearing `actorUserId != null` guard. A guest actor (null id) on a
  // guest annotation (null author) must NOT be treated as the owner of it — even though
  // null === null. As a viewer/commenter-equivalent guest, this is refused.
  const repo = fakeRepo();
  const res = await deleteAnnotation(
    { annotationId: "ann-guest", actorUserId: null, sessionRole: "commenter", authorId: null },
    repo,
  );
  expect(res).toEqual({ ok: false, reason: "forbidden" });
  expect(repo.deleted).toHaveLength(0);
});
