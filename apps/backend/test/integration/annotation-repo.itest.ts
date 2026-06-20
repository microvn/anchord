// Integration tier (guarded by RUN_INTEGRATION): the CONCRETE Drizzle-backed
// annotation-core repos driven through the real service functions against a REAL
// Postgres. This is the glue the unit suite deferred behind fake repos — here we prove
// the full lifecycle round-trips through actual rows: create annotation → reply →
// resolve/reopen → guest comment (name only — no email, AS-017) → suggestion
// create/decide. Mirrors version-repo.itest.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDocRepo } from "../../src/publish/repo";
import { annotations, comments, user } from "../../src/db/schema";
import { buildAnchor, createAnnotation, createAnnotationWithComment, listAnnotations } from "../../src/annotation/annotation";
import { addReply } from "../../src/annotation/reply";
import { setResolution } from "../../src/annotation/resolve";
import { createGuestComment } from "../../src/annotation/guest";
import { createSuggestion, decideSuggestion } from "../../src/annotation/suggestion";
import {
  createAnnotationRepo,
  createCommentRepo,
  createGuestCommentRepo,
  createResolutionRepo,
  createSuggestionRepo,
  createDeleteRepo,
} from "../../src/annotation/repo";
import { withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;

// doc-access-routing S-001: listAnnotations now takes a PRE-RESOLVED `canView` (the
// route's single resolveAccess gate decides it). These itests pass `canView: true`
// directly since the seeded doc is anyone_with_link.

let docSeq = 0;
/** Seed a doc (with version 1) via the real publish repo; return its id. */
async function newDoc(h: MigratedDb, content = "<p>v1 body</p>"): Promise<string> {
  const slug = `ann-itest-${process.pid}-${++docSeq}`;
  const { id } = await createDocRepo(h.db).createDocWithV1({
    slug,
    title: `Doc ${slug}`,
    kind: "html",
    content,
    contentHash: `hash-${slug}`,
  });
  return id;
}

describe.skipIf(!RUN)("annotation-core repos (real Postgres)", () => {
  let h: MigratedDb;

  beforeAll(async () => {
    h = await withMigratedDb();
  });

  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  });

  test("S-001: createAnnotation (commenter) persists a row; listAnnotations returns it", async () => {
    const docId = await newDoc(h);
    const annRepo = createAnnotationRepo(h.db);

    const anchor = buildAnchor({ blockId: "b1", text: "v1 body", offset: 0, length: 7 });
    expect(anchor).not.toBeNull();

    const created = await createAnnotation(
      {
        docId,
        anchor: anchor!,
        viewer: { kind: "user", userId: "u1" },
        sessionRole: "commenter",
      },
      annRepo,
    );
    expect(created.created).toBe(true);
    const annId = created.created ? created.id : "";

    const listed = await listAnnotations(
      { docId, canView: true },
      annRepo,
    );
    expect(listed.allowed).toBe(true);
    expect(listed.annotations.map((a) => a.id)).toContain(annId);
    const persisted = listed.annotations.find((a) => a.id === annId)!;
    expect(persisted.type).toBe("range");
    expect(persisted.status).toBe("unresolved");
    expect(persisted.anchor.textSnippet).toBe("v1 body");
  });

  // ── C-018: atomic create-annotation-with-comment against REAL Postgres ──────
  // AS-001 strengthened: the annotation row AND its first comment persist in ONE transaction.
  // The no-orphan claim is a DB-rollback claim — a fake can't prove it, so it MUST run here.

  test("AS-001: insertAnnotationWithComment persists the annotation AND its first comment in ONE transaction (real Postgres)", async () => {
    const docId = await newDoc(h, '<p id="b1">atomic body text</p>');
    const annRepo = createAnnotationRepo(h.db);
    // A real account so the comment's author_id FK is satisfiable.
    const author = `u-atomic-${docId}`;
    await h.db.insert(user).values({ id: author, name: "Atomic", email: `${author}@example.com` });

    const anchor = buildAnchor({ blockId: "b1", text: "atomic", offset: 0, length: 6 })!;
    const created = await createAnnotationWithComment(
      {
        docId,
        anchor,
        viewer: { kind: "user", userId: author },
        sessionRole: "commenter",
        comment: { body: "this is the first comment" },
        authorId: author,
      },
      annRepo,
    );
    expect(created.created).toBe(true);
    const annId = created.created ? created.id : "";
    const commentId = created.created ? created.commentId : undefined;
    expect(commentId).toBeString();

    // The annotation row is present...
    const annRows = await h.db.select({ id: annotations.id }).from(annotations).where(eq(annotations.id, annId));
    expect(annRows).toHaveLength(1);
    // ...AND its first comment is present, FK-linked to it (both persisted by the one call).
    const cmtRows = await h.db
      .select({ id: comments.id, body: comments.body, authorId: comments.authorId })
      .from(comments)
      .where(eq(comments.annotationId, annId));
    expect(cmtRows).toHaveLength(1);
    expect(cmtRows[0]!.body).toBe("this is the first comment");
    expect(cmtRows[0]!.authorId).toBe(author);
  });

  test("AS-001: when the first-comment insert FAILS, the transaction ROLLS BACK — NO orphan annotation remains (real Postgres)", async () => {
    const docId = await newDoc(h, '<p id="b1">rollback body text</p>');
    const annRepo = createAnnotationRepo(h.db);

    // Count annotations on this doc before — must be unchanged after the failed create.
    const before = await annRepo.listByDoc(docId);

    const anchor = buildAnchor({ blockId: "b1", text: "rollback", offset: 0, length: 8 })!;
    // Drive the REPO directly so we can hand it a comment whose author_id references a user that
    // does NOT exist → the comment INSERT violates the FK and throws INSIDE the transaction, AFTER
    // the annotation insert. If the write were two separate statements (the bug), the annotation
    // would survive as an orphan. With one transaction it must roll back.
    let threw = false;
    try {
      await annRepo.insertAnnotationWithComment(
        { docId, type: "range", anchor, label: null, authorId: null, suggestion: null, suggestionStatus: null },
        { body: "doomed comment", authorId: "user-that-does-not-exist", guestName: null },
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // The whole tx rolled back: no NEW annotation row exists on this doc (no orphan), and no
    // dangling comment was committed either.
    const after = await annRepo.listByDoc(docId);
    expect(after).toHaveLength(before.length);
    const allCmts = await h.db
      .select({ id: comments.id })
      .from(comments)
      .where(eq(comments.body, "doomed comment"));
    expect(allCmts).toHaveLength(0);
  });

  test("#4 (2026-06-12): listAnnotations returns annotations NEWEST-FIRST (top of the rail)", async () => {
    const docId = await newDoc(h, '<p id="b1">first second third body</p>');
    const annRepo = createAnnotationRepo(h.db);

    // Create three annotations in sequence. createdAt defaults to now(); to make the order
    // deterministic regardless of same-millisecond inserts, force distinct timestamps after insert.
    const ids: string[] = [];
    for (const snippet of ["first", "second", "third"]) {
      const anchor = buildAnchor({
        blockId: "b1",
        text: snippet,
        offset: "first second third body".indexOf(snippet),
        length: snippet.length,
      })!;
      const created = await createAnnotation(
        { docId, anchor, viewer: { kind: "user", userId: "u1" }, sessionRole: "commenter" },
        annRepo,
      );
      ids.push(created.created ? created.id : "");
    }
    // Stamp strictly increasing created_at so "newest" is unambiguous: first < second < third.
    await h.db
      .update(annotations)
      .set({ createdAt: new Date("2026-01-01T00:00:01.000Z") })
      .where(eq(annotations.id, ids[0]));
    await h.db
      .update(annotations)
      .set({ createdAt: new Date("2026-01-01T00:00:02.000Z") })
      .where(eq(annotations.id, ids[1]));
    await h.db
      .update(annotations)
      .set({ createdAt: new Date("2026-01-01T00:00:03.000Z") })
      .where(eq(annotations.id, ids[2]));

    const listed = await listAnnotations(
      { docId, canView: true },
      annRepo,
    );
    expect(listed.allowed).toBe(true);
    // Newest (third, ids[2]) first → oldest (first, ids[0]) last.
    expect(listed.annotations.map((a) => a.id)).toEqual([ids[2], ids[1], ids[0]]);
  });

  test("AS-014: a soft-deleted annotation is EXCLUDED from listByDoc (real Postgres) and restore brings it back", async () => {
    // annotation-actions S-005 / C-007: the SQL `deleted_at is null` filter on listByDoc — the
    // active list (and, via the shared listByDoc, the re-anchor enumeration) must drop a
    // tombstoned row, and clearing the tombstone (restore) must return it.
    const docId = await newDoc(h, '<p id="b1">secret body text</p>');
    const annRepo = createAnnotationRepo(h.db);
    const delRepo = createDeleteRepo(h.db);

    const anchor = buildAnchor({ blockId: "b1", text: "secret", offset: 0, length: 6 })!;
    const created = await createAnnotation(
      { docId, anchor, viewer: { kind: "user", userId: "u1" }, sessionRole: "commenter" },
      annRepo,
    );
    const annId = created.created ? created.id : "";

    // Present before delete.
    expect((await annRepo.listByDoc(docId)).map((a) => a.id)).toContain(annId);

    // Soft-delete → absent from the active list (its highlight gone).
    await delRepo.setDeletedAt(annId);
    expect((await annRepo.listByDoc(docId)).map((a) => a.id)).not.toContain(annId);

    // Restore (clear the tombstone) → back in the active list.
    await delRepo.clearDeletedAt(annId);
    expect((await annRepo.listByDoc(docId)).map((a) => a.id)).toContain(annId);
  });

  test("S-003: addReply persists a FLAT comment under the annotation", async () => {
    const docId = await newDoc(h);
    const annRepo = createAnnotationRepo(h.db);
    const commentRepo = createCommentRepo(h.db);

    const anchor = buildAnchor({ blockId: "b1", text: "v1 body", offset: 0, length: 7 })!;
    const created = await createAnnotation(
      { docId, anchor, viewer: { kind: "user", userId: "u1" }, sessionRole: "commenter" },
      annRepo,
    );
    const annId = created.created ? created.id : "";

    // The reply author is a real user (comments.author_id FKs the user table).
    const replier = `u2-${docId}`;
    await h.db
      .insert(user)
      .values({ id: replier, name: "Replier", email: `${replier}@example.com` });

    // Seed a root comment directly, then reply to it through the service.
    const [root] = await h.db
      .insert(comments)
      .values({ annotationId: annId, authorId: null, guestName: "Root", body: "root comment" })
      .returning({ id: comments.id });

    const reply = await addReply(
      {
        annotationId: annId,
        parentCommentId: root.id,
        body: "a reply",
        author: { kind: "user", userId: replier },
        sessionRole: "commenter",
      },
      commentRepo,
    );
    expect(reply.created).toBe(true);
    expect(reply.created && reply.parentId).toBe(root.id); // C-004: flattened to root.

    const thread = await commentRepo.listByAnnotation(annId);
    expect(thread.length).toBe(2);
    const persistedReply = thread.find((c) => c.body === "a reply")!;
    expect(persistedReply.parentId).toBe(root.id); // flat: reply's parent is the root.
  });

  test("S-004: setResolution resolve→reopen round-trips the status in the DB", async () => {
    const docId = await newDoc(h);
    const annRepo = createAnnotationRepo(h.db);
    const resRepo = createResolutionRepo(h.db);

    const anchor = buildAnchor({ blockId: "b1", text: "v1 body", offset: 0, length: 7 })!;
    const created = await createAnnotation(
      { docId, anchor, viewer: { kind: "user", userId: "u1" }, sessionRole: "commenter" },
      annRepo,
    );
    const annId = created.created ? created.id : "";

    const resolved = await setResolution(
      { annotationId: annId, resolved: true, sessionRole: "commenter" },
      resRepo,
    );
    expect(resolved.ok && resolved.status).toBe("resolved");
    let [row] = await h.db
      .select({ status: annotations.status })
      .from(annotations)
      .where(eq(annotations.id, annId));
    expect(row.status).toBe("resolved");

    const reopened = await setResolution(
      { annotationId: annId, resolved: false, sessionRole: "commenter" },
      resRepo,
    );
    expect(reopened.ok && reopened.status).toBe("unresolved");
    [row] = await h.db
      .select({ status: annotations.status })
      .from(annotations)
      .where(eq(annotations.id, annId));
    expect(row.status).toBe("unresolved");
  });

  test("S-007: createGuestComment persists null authorId + guest_name (no email) end-to-end", async () => {
    const docId = await newDoc(h);
    const annRepo = createAnnotationRepo(h.db);
    const guestRepo = createGuestCommentRepo(h.db);

    const anchor = buildAnchor({ blockId: "b1", text: "v1 body", offset: 0, length: 7 })!;
    const created = await createAnnotation(
      { docId, anchor, viewer: { kind: "user", userId: "u1" }, sessionRole: "commenter" },
      annRepo,
    );
    const annId = created.created ? created.id : "";

    const guest = await createGuestComment(
      {
        annotationId: annId,
        guestName: "Visiting Otter",
        body: "a guest note",
      },
      guestRepo,
    );
    expect(guest.created).toBe(true);

    const [row] = await h.db
      .select({
        authorId: comments.authorId,
        guestName: comments.guestName,
        body: comments.body,
      })
      .from(comments)
      .where(eq(comments.id, guest.created ? guest.id : ""));
    expect(row.authorId).toBeNull(); // AS-017: no account.
    expect(row.guestName).toBe("Visiting Otter"); // AS-017: name only — no email column.
    expect(row.body).toBe("a guest note");
  });

  test("S-006: createSuggestion persists a suggestion; decideSuggestion accept + stale update status", async () => {
    // Block-id-injected-friendly content: the re-anchor matcher pulls block text by id.
    const docId = await newDoc(h, '<p id="b1">deploy within 24h please</p>');
    const sugRepo = createSuggestionRepo(h.db);

    const anchor = buildAnchor({ blockId: "b1", text: "24h", offset: 14, length: 3 })!;
    const created = await createSuggestion(
      {
        docId,
        anchor,
        from: "24h",
        to: "48h",
        againstVersion: 1,
        sessionRole: "commenter",
      },
      sugRepo,
    );
    expect(created.created).toBe(true);
    const sugId = created.created ? created.id : "";

    // Persisted as a suggestion-type annotation with the payload + pending status.
    const [persisted] = await h.db
      .select({
        type: annotations.type,
        suggestion: annotations.suggestion,
        suggestionStatus: annotations.suggestionStatus,
      })
      .from(annotations)
      .where(eq(annotations.id, sugId));
    expect(persisted.type).toBe("suggestion");
    expect(persisted.suggestionStatus).toBe("pending");
    expect((persisted.suggestion as { from: string }).from).toBe("24h");

    // accept against content that STILL contains "24h" at the anchor → accepted.
    const accepted = await decideSuggestion(
      {
        suggestionId: sugId,
        decision: "accept",
        currentVersionContentHtml: '<p id="b1">deploy within 24h please</p>',
      },
      sugRepo,
    );
    expect(accepted.ok && accepted.status).toBe("accepted");
    let [row] = await h.db
      .select({ suggestionStatus: annotations.suggestionStatus })
      .from(annotations)
      .where(eq(annotations.id, sugId));
    expect(row.suggestionStatus).toBe("accepted");

    // AS-022: re-decide accept against content where "24h" was rewritten → stale.
    const stale = await decideSuggestion(
      {
        suggestionId: sugId,
        decision: "accept",
        currentVersionContentHtml: '<p id="b1">deploy within 48 hours please</p>',
      },
      sugRepo,
    );
    expect(stale.ok && stale.status).toBe("stale");
    [row] = await h.db
      .select({ suggestionStatus: annotations.suggestionStatus })
      .from(annotations)
      .where(eq(annotations.id, sugId));
    expect(row.suggestionStatus).toBe("stale");
  });
});
