import { test, expect } from "bun:test";
import {
  buildAnchor,
  createAnnotation,
  listAnnotations,
  type Anchor,
  type AnnotationRepo,
  type AnnotationRow,
  type NewAnnotation,
  type ViewerComment,
} from "./annotation";
import type { Viewer } from "../sharing/access";

// annotation-core S-001 — anchor model + create-path SERVER re-auth (C-009/AS-020) +
// read authz (C-010/AS-021). Pure logic against a fake repo (mirrors access.test.ts).

// A recording fake repo: captures what was inserted, serves a canned annotation list +
// a canned comment list (S-003 read attaches each annotation's thread).
function fakeRepo(
  seed: AnnotationRow[] = [],
  commentSeed: (ViewerComment & { annotationId: string })[] = [],
): AnnotationRepo & { inserted: NewAnnotation[] } {
  const inserted: NewAnnotation[] = [];
  return {
    inserted,
    async insertAnnotation(input: NewAnnotation) {
      inserted.push(input);
      return { id: `ann-${inserted.length}` };
    },
    async listByDoc(_docId: string) {
      return seed;
    },
    async listCommentsByDoc(_docId: string) {
      return commentSeed;
    },
  };
}

const commenter: Viewer = { kind: "user", userId: "u-commenter" };
const anon: Viewer = { kind: "anon" };

test("AS-001: create a block-anchored text annotation on an HTML doc", async () => {
  const repo = fakeRepo();
  // The sentence "Payment expires after 24h" selected in the 7th block.
  const anchor = buildAnchor({
    blockId: "block-p-7",
    text: "Payment expires after 24h",
    offset: 0,
    length: 26,
  });
  expect(anchor).not.toBeNull();

  const res = await createAnnotation(
    { docId: "doc-1", anchor: anchor!, viewer: commenter, sessionRole: "commenter" },
    repo,
  );

  expect(res).toEqual({ created: true, id: "ann-1" });
  expect(repo.inserted).toHaveLength(1);
  expect(repo.inserted[0].anchor).toEqual({
    blockId: "block-p-7",
    textSnippet: "Payment expires after 24h",
    offset: 0,
    length: 26,
  });
  expect(repo.inserted[0].type).toBe("range");
});

test("AS-002: create a block-anchored text annotation on a Markdown doc (range inside a bullet)", async () => {
  const repo = fakeRepo();
  const anchor = buildAnchor({
    blockId: "block-li-2",
    text: "second bullet text",
    offset: 3,
    length: 6,
  });

  const res = await createAnnotation(
    { docId: "doc-md", anchor: anchor!, viewer: commenter, sessionRole: "commenter" },
    repo,
  );

  expect(res.created).toBe(true);
  expect(repo.inserted[0].anchor.blockId).toBe("block-li-2");
});

test("AS-003: a duplicate quote in two blocks anchors to the CHOSEN block_id (block-9)", async () => {
  const repo = fakeRepo();
  // "see below" exists in block-p-3 and block-p-9; user selected it in block-p-9.
  const anchor = buildAnchor({
    blockId: "block-p-9",
    text: "see below",
    offset: 0,
    length: 9,
  });

  await createAnnotation(
    { docId: "doc-dup", anchor: anchor!, viewer: commenter, sessionRole: "commenter" },
    repo,
  );

  // Anchors to the chosen block, NOT block-p-3.
  expect(repo.inserted[0].anchor.blockId).toBe("block-p-9");
  expect(repo.inserted[0].anchor.blockId).not.toBe("block-p-3");
});

test("AS-004: empty/whitespace-only selection is ignored — buildAnchor returns null, no annotation", async () => {
  expect(buildAnchor({ blockId: "block-p-1", text: "", offset: 0, length: 0 })).toBeNull();
  expect(buildAnchor({ blockId: "block-p-1", text: "   \n\t ", offset: 0, length: 5 })).toBeNull();
  // A null anchor never reaches createAnnotation, so the repo is never touched.
  // (Guarding against a manufactured non-null whitespace anchor is the buildAnchor job above.)
});

test("AS-020 / C-009: a forged postMessage (viewer session) does NOT create an annotation — server re-auth", async () => {
  const repo = fakeRepo();
  const anchor: Anchor = { blockId: "block-p-1", text_snippet: "x" } as any; // shape irrelevant; gate fires first
  // Simulate the untrusted iframe trying to spoof authority: the payload's own
  // "role"/"authorized" claims are STRUCTURALLY absent from the API — only sessionRole
  // gates the write, and this session is a viewer.
  const forged = {
    docId: "doc-1",
    anchor: { blockId: "block-p-1", textSnippet: "x", offset: 0, length: 1 } as Anchor,
    viewer: anon,
    // sessionRole resolved SERVER-side from the (viewer) session — not from the message.
    sessionRole: "viewer" as const,
  };

  const res = await createAnnotation(forged, repo);

  expect(res).toEqual({ created: false, reason: "forbidden" });
  expect(repo.inserted).toHaveLength(0); // nothing persisted
  void anchor;
});

test("AS-020 / C-009: a commenter session is authorized (control for the forged-message test)", async () => {
  const repo = fakeRepo();
  const anchor = buildAnchor({ blockId: "block-p-1", text: "hi", offset: 0, length: 2 })!;
  const res = await createAnnotation(
    { docId: "doc-1", anchor, viewer: commenter, sessionRole: "commenter" },
    repo,
  );
  expect(res.created).toBe(true);
});

test("AS-021 / C-010: a user without doc permission cannot read annotations — denied, no content", async () => {
  const repo = fakeRepo([
    {
      id: "ann-secret",
      docId: "doc-restricted",
      type: "range",
      anchor: { blockId: "block-p-1", textSnippet: "secret", offset: 0, length: 6 },
      isOrphaned: false,
      status: "unresolved",
    },
  ]);

  // S-001: the route's single resolveAccess gate decided this reader cannot view → canView false.
  const res = await listAnnotations({ docId: "doc-restricted", canView: false }, repo);

  expect(res.allowed).toBe(false);
  expect(res.annotations).toEqual([]); // NO content leaks
});

test("C-010: an authorized reader gets the doc's annotations", async () => {
  const row: AnnotationRow = {
    id: "ann-1",
    docId: "doc-ok",
    type: "range",
    anchor: { blockId: "block-p-1", textSnippet: "hello", offset: 0, length: 5 },
    isOrphaned: false,
    status: "unresolved",
  };
  const repo = fakeRepo([row]);

  const res = await listAnnotations({ docId: "doc-ok", canView: true }, repo);

  expect(res.allowed).toBe(true);
  // S-003: every annotation now carries its (possibly empty) comment thread.
  expect(res.annotations).toEqual([{ ...row, comments: [] }]);
});

test("AS-027 / C-015: create a labeled annotation persists the label (out-of-scope)", async () => {
  const repo = fakeRepo();
  const anchor = buildAnchor({ blockId: "block-p-1", text: "scope creep", offset: 0, length: 11 })!;

  const res = await createAnnotation(
    { docId: "doc-1", anchor, viewer: commenter, sessionRole: "commenter", label: "out-of-scope" },
    repo,
  );

  expect(res).toEqual({ created: true, id: "ann-1" });
  // The chosen preset id is stored verbatim on the new annotation.
  expect(repo.inserted[0].label).toBe("out-of-scope");
});

test("AS-027 / C-015: a Like is the same path with label looks-good", async () => {
  const repo = fakeRepo();
  const anchor = buildAnchor({ blockId: "block-p-1", text: "nice", offset: 0, length: 4 })!;

  const res = await createAnnotation(
    { docId: "doc-1", anchor, viewer: commenter, sessionRole: "commenter", label: "looks-good" },
    repo,
  );

  expect(res.created).toBe(true);
  expect(repo.inserted[0].label).toBe("looks-good");
});

test("AS-027: listAnnotations serves the stored label on read", async () => {
  const row: AnnotationRow = {
    id: "ann-1",
    docId: "doc-ok",
    type: "range",
    anchor: { blockId: "block-p-1", textSnippet: "x", offset: 0, length: 1 },
    isOrphaned: false,
    status: "unresolved",
    label: "out-of-scope",
  };
  const repo = fakeRepo([row]);

  const res = await listAnnotations({ docId: "doc-ok", canView: true }, repo);

  expect(res.allowed).toBe(true);
  // The read returns the label on the annotation (consumed by the FE rail label line).
  expect(res.annotations[0].label).toBe("out-of-scope");
});

test("AS-028 / C-015: a create with an unknown / forged label is refused — nothing persisted", async () => {
  const repo = fakeRepo();
  const anchor = buildAnchor({ blockId: "block-p-1", text: "x", offset: 0, length: 1 })!;

  const res = await createAnnotation(
    { docId: "doc-1", anchor, viewer: commenter, sessionRole: "commenter", label: "<svg onload=alert(1)>" },
    repo,
  );

  expect(res).toEqual({ created: false, reason: "invalid_label" });
  expect(repo.inserted).toHaveLength(0); // a forged label never reaches the repo
});

test("AS-027: a create with NO label is unaffected (label optional, undefined persisted as no label)", async () => {
  const repo = fakeRepo();
  const anchor = buildAnchor({ blockId: "block-p-1", text: "x", offset: 0, length: 1 })!;

  const res = await createAnnotation(
    { docId: "doc-1", anchor, viewer: commenter, sessionRole: "commenter" },
    repo,
  );

  expect(res.created).toBe(true);
  expect(repo.inserted[0].label ?? null).toBeNull();
});

test("AS-030: listAnnotations serves a suggestion's payload + status on the read (so the viewer renders its lifecycle)", async () => {
  const row: AnnotationRow = {
    id: "sug-1",
    docId: "doc-ok",
    type: "suggestion",
    anchor: { blockId: "block-p-1", textSnippet: "old title", offset: 0, length: 9 },
    isOrphaned: false,
    status: "resolved",
    suggestion: { kind: "delete", from: "old title", againstVersion: 3 },
    suggestionStatus: "stale",
  };
  const repo = fakeRepo([row]);

  const res = await listAnnotations({ docId: "doc-ok", canView: true }, repo);

  expect(res.allowed).toBe(true);
  // The read carries the suggestion payload + its lifecycle status (mirrors AS-027 serving label).
  expect(res.annotations[0].suggestion).toEqual({ kind: "delete", from: "old title", againstVersion: 3 });
  expect(res.annotations[0].suggestionStatus).toBe("stale");
});

test("S-003: list attaches each annotation's comments[] thread (authorName | guestName)", async () => {
  const row: AnnotationRow = {
    id: "ann-1",
    docId: "doc-ok",
    type: "range",
    anchor: { blockId: "block-p-1", textSnippet: "hello", offset: 0, length: 5 },
    isOrphaned: false,
    status: "unresolved",
  };
  const root: ViewerComment & { annotationId: string } = {
    annotationId: "ann-1",
    id: "c-root",
    parentId: null,
    authorName: "Demo Author",
    body: "the root comment",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const reply: ViewerComment & { annotationId: string } = {
    annotationId: "ann-1",
    id: "c-reply",
    parentId: "c-root",
    guestName: "A Guest",
    body: "a guest reply",
    createdAt: "2026-01-01T00:01:00.000Z",
  };
  const repo = fakeRepo([row], [root, reply]);

  const res = await listAnnotations({ docId: "doc-ok", canView: true }, repo);

  expect(res.allowed).toBe(true);
  // The thread is attached, in creation order, with the annotationId stripped (it's the grouping key).
  expect(res.annotations[0].comments).toEqual([
    { id: "c-root", parentId: null, authorName: "Demo Author", body: "the root comment", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "c-reply", parentId: "c-root", guestName: "A Guest", body: "a guest reply", createdAt: "2026-01-01T00:01:00.000Z" },
  ]);
});
