import { test, expect } from "bun:test";
import {
  addReply,
  addComment,
  flattenedParentId,
  threadDepth,
  type CommentRepo,
  type CommentRow,
  type NewComment,
} from "./reply";

// annotation-core S-003 — reply in a thread. Flatness (C-004): a reply anchors to the
// annotation's ROOT comment, one level, never deeply nested. Server re-auth via
// can(role,"comment") (like S-001 create). Pure logic against a fake CommentRepo
// (mirrors annotation.test.ts).

// A recording fake repo: seeds an existing thread, captures inserts, assigns ids.
function fakeRepo(seed: CommentRow[] = []): CommentRepo & {
  inserted: NewComment[];
  rows: CommentRow[];
} {
  const rows = [...seed];
  const inserted: NewComment[] = [];
  return {
    inserted,
    rows,
    async listByAnnotation(annotationId: string) {
      return rows.filter((c) => c.annotationId === annotationId);
    },
    async insertComment(input: NewComment) {
      inserted.push(input);
      const id = `c-${rows.length + 1}`;
      rows.push({
        id,
        annotationId: input.annotationId,
        parentId: input.parentId,
        authorId: input.authorId,
        guestName: input.guestName,
        body: input.body,
      });
      return { id };
    },
  };
}

// An annotation (ann-1) that already has a first/root comment (c-1), per AS-008 Data.
function withFirstComment(): CommentRow[] {
  return [
    {
      id: "c-1",
      annotationId: "ann-1",
      parentId: null,
      authorId: "u-author",
      guestName: null,
      body: "the original comment",
    },
  ];
}

test("AS-008: Flat reply under an annotation — reply stored with parent = root comment, one level", async () => {
  const repo = fakeRepo(withFirstComment());

  // Another person clicks Reply on the first comment and enters content.
  const res = await addReply(
    {
      annotationId: "ann-1",
      parentCommentId: "c-1",
      body: "I disagree, see below",
      author: { kind: "user", userId: "u-replier" },
      sessionRole: "commenter",
    },
    repo,
  );

  expect(res).toEqual({ created: true, id: "c-2", parentId: "c-1" });

  // Stored flat: the reply's parent is the root comment c-1.
  expect(repo.inserted).toHaveLength(1);
  expect(repo.inserted[0].parentId).toBe("c-1");
  expect(repo.inserted[0].annotationId).toBe("ann-1");

  // Listing the thread returns [root, reply] at ONE level — depth never exceeds 1.
  const thread = await repo.listByAnnotation("ann-1");
  expect(thread.map((c) => c.id)).toEqual(["c-1", "c-2"]);
  expect(thread.find((c) => c.id === "c-1")!.parentId).toBeNull(); // root
  expect(thread.find((c) => c.id === "c-2")!.parentId).toBe("c-1"); // reply → root
  expect(threadDepth(thread)).toBe(1);
});

test("C-004: replying to a REPLY flattens to one level (parent = root, not the reply) — depth stays 1", async () => {
  // Thread: root c-1, existing reply c-2 (parent c-1). Now reply to c-2.
  const repo = fakeRepo([
    { id: "c-1", annotationId: "ann-1", parentId: null, authorId: "u-a", guestName: null, body: "root" },
    { id: "c-2", annotationId: "ann-1", parentId: "c-1", authorId: "u-b", guestName: null, body: "first reply" },
  ]);

  const res = await addReply(
    {
      annotationId: "ann-1",
      parentCommentId: "c-2", // targeting a reply...
      body: "replying to the reply",
      author: { kind: "user", userId: "u-c" },
      sessionRole: "commenter",
    },
    repo,
  );

  // ...flattens to the ROOT c-1, NOT to c-2 (which would be depth 2).
  expect(res).toEqual({ created: true, id: "c-3", parentId: "c-1" });
  expect(repo.inserted[0].parentId).toBe("c-1");
  expect(repo.inserted[0].parentId).not.toBe("c-2");

  // No comment's parent is itself a reply → depth never exceeds 1.
  const thread = await repo.listByAnnotation("ann-1");
  expect(threadDepth(thread)).toBe(1);
  for (const c of thread) {
    if (c.parentId != null) {
      const parent = thread.find((p) => p.id === c.parentId)!;
      expect(parent.parentId).toBeNull(); // every parent is a ROOT, never a reply
    }
  }
});

test("C-004: flattenedParentId resolves a reply target to its root (helper, falsifiability)", () => {
  const thread: CommentRow[] = [
    { id: "c-1", annotationId: "ann-1", parentId: null, authorId: "u-a", guestName: null, body: "root" },
    { id: "c-2", annotationId: "ann-1", parentId: "c-1", authorId: "u-b", guestName: null, body: "reply" },
  ];
  // Target a root → parent is the root itself.
  expect(flattenedParentId("c-1", thread)).toBe("c-1");
  // Target a reply → parent flattens to the reply's root.
  expect(flattenedParentId("c-2", thread)).toBe("c-1");
});

test("AS-008: a guest can reply — authorId null, guestName carried (S-007 author shape)", async () => {
  const repo = fakeRepo(withFirstComment());
  const res = await addReply(
    {
      annotationId: "ann-1",
      parentCommentId: "c-1",
      body: "guest reply",
      author: { kind: "guest", guestName: "Visitor 7" },
      sessionRole: "commenter",
    },
    repo,
  );
  expect(res.created).toBe(true);
  expect(repo.inserted[0].authorId).toBeNull();
  expect(repo.inserted[0].guestName).toBe("Visitor 7");
});

test("AS-008 / C-009: a viewer session cannot reply — forbidden, nothing persisted (server re-auth)", async () => {
  const repo = fakeRepo(withFirstComment());
  const res = await addReply(
    {
      annotationId: "ann-1",
      parentCommentId: "c-1",
      body: "should not persist",
      author: { kind: "user", userId: "u-viewer" },
      sessionRole: "viewer",
    },
    repo,
  );
  expect(res).toEqual({ created: false, reason: "forbidden" });
  expect(repo.inserted).toHaveLength(0);
});

test("AS-008: empty / whitespace-only reply body is rejected — nothing persisted", async () => {
  const repo = fakeRepo(withFirstComment());

  const empty = await addReply(
    { annotationId: "ann-1", parentCommentId: "c-1", body: "", author: { kind: "user", userId: "u-x" }, sessionRole: "commenter" },
    repo,
  );
  expect(empty).toEqual({ created: false, reason: "empty_body" });

  const ws = await addReply(
    { annotationId: "ann-1", parentCommentId: "c-1", body: "  \n\t ", author: { kind: "user", userId: "u-x" }, sessionRole: "commenter" },
    repo,
  );
  expect(ws).toEqual({ created: false, reason: "empty_body" });

  expect(repo.inserted).toHaveLength(0);
});

test("AS-008: replying to a non-existent parent comment is rejected — parent_not_found", async () => {
  const repo = fakeRepo(withFirstComment());
  const res = await addReply(
    {
      annotationId: "ann-1",
      parentCommentId: "c-does-not-exist",
      body: "orphan reply",
      author: { kind: "user", userId: "u-x" },
      sessionRole: "commenter",
    },
    repo,
  );
  expect(res).toEqual({ created: false, reason: "parent_not_found" });
  expect(repo.inserted).toHaveLength(0);
});

// ── addComment: TOP-LEVEL comment (no parent) — the session counterpart to the
// guest top-level path. No thread lookup, no parent_not_found. ──

test("S-001: top-level comment on an annotation (no parent) is created with parentId null", async () => {
  // Empty thread: this is the first/root comment on the annotation.
  const repo = fakeRepo();
  const res = await addComment(
    {
      annotationId: "ann-1",
      body: "the first comment",
      author: { kind: "user", userId: "u-author" },
      sessionRole: "commenter",
    },
    repo,
  );

  expect(res).toEqual({ created: true, id: "c-1", parentId: null });
  expect(repo.inserted).toHaveLength(1);
  expect(repo.inserted[0].parentId).toBeNull(); // top-level: no parent
  expect(repo.inserted[0].annotationId).toBe("ann-1");
  expect(repo.inserted[0].authorId).toBe("u-author");
  expect(repo.inserted[0].guestName).toBeNull();
  // The repo never needed a thread lookup — a top comment has no parent to resolve.
  expect(threadDepth(await repo.listByAnnotation("ann-1"))).toBe(0);
});

test("S-001: a guest can post a top-level comment — authorId null, guestName carried", async () => {
  const repo = fakeRepo();
  const res = await addComment(
    {
      annotationId: "ann-1",
      body: "guest top comment",
      author: { kind: "guest", guestName: "Visitor 9" },
      sessionRole: "commenter",
    },
    repo,
  );
  expect(res).toEqual({ created: true, id: "c-1", parentId: null });
  expect(repo.inserted[0].authorId).toBeNull();
  expect(repo.inserted[0].guestName).toBe("Visitor 9");
});

test("S-001: empty / whitespace-only top-level comment body is rejected — empty_body, nothing persisted", async () => {
  const repo = fakeRepo();

  const empty = await addComment(
    { annotationId: "ann-1", body: "", author: { kind: "user", userId: "u-x" }, sessionRole: "commenter" },
    repo,
  );
  expect(empty).toEqual({ created: false, reason: "empty_body" });

  const ws = await addComment(
    { annotationId: "ann-1", body: "  \n\t ", author: { kind: "user", userId: "u-x" }, sessionRole: "commenter" },
    repo,
  );
  expect(ws).toEqual({ created: false, reason: "empty_body" });

  expect(repo.inserted).toHaveLength(0);
});

test("S-001 / C-009: a viewer session cannot post a top-level comment — forbidden, nothing persisted", async () => {
  const repo = fakeRepo();
  const res = await addComment(
    {
      annotationId: "ann-1",
      body: "should not persist",
      author: { kind: "user", userId: "u-viewer" },
      sessionRole: "viewer",
    },
    repo,
  );
  expect(res).toEqual({ created: false, reason: "forbidden" });
  expect(repo.inserted).toHaveLength(0);
});
