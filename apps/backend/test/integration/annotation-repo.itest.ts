// Integration tier (guarded by RUN_INTEGRATION): the CONCRETE Drizzle-backed
// annotation-core repos driven through the real service functions against a REAL
// Postgres. This is the glue the unit suite deferred behind fake repos — here we prove
// the full lifecycle round-trips through actual rows: create annotation → reply →
// resolve/reopen → guest comment (with the just-added guest_email column) → suggestion
// create/decide → re-anchor ledger idempotency (C-012). Mirrors version-repo.itest.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDocRepo } from "../../src/publish/repo";
import { appendVersion } from "../../src/services/version";
import { createVersionRepo } from "../../src/services/version-repo";
import { annotations, comments, docVersions, reanchorLedger, user } from "../../src/db/schema";
import { buildAnchor, createAnnotation, listAnnotations } from "../../src/annotation/annotation";
import { addReply } from "../../src/annotation/reply";
import { setResolution } from "../../src/annotation/resolve";
import { createGuestComment } from "../../src/annotation/guest";
import { createSuggestion, decideSuggestion } from "../../src/annotation/suggestion";
import { reanchorForVersion } from "../../src/annotation/reanchor";
import {
  createAnnotationRepo,
  createCommentRepo,
  createGuestCommentRepo,
  createResolutionRepo,
  createSuggestionRepo,
  createReanchorLedgerRepo,
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

/** Read the doc_versions row id for a (docId, version) — the ledger keys on it. */
async function versionId(h: MigratedDb, docId: string, version: number): Promise<string> {
  const rows = await h.db
    .select({ id: docVersions.id, version: docVersions.version })
    .from(docVersions)
    .where(eq(docVersions.docId, docId));
  const match = rows.find((r) => r.version === version);
  if (!match) throw new Error(`no doc_versions row for doc ${docId} v${version}`);
  return match.id;
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

  test("S-007: createGuestComment persists null authorId + guest_email end-to-end", async () => {
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
        email: "otter@example.com",
        body: "a guest note",
        guestCommentingEnabled: true,
      },
      guestRepo,
    );
    expect(guest.created).toBe(true);

    const [row] = await h.db
      .select({
        authorId: comments.authorId,
        guestName: comments.guestName,
        guestEmail: comments.guestEmail,
        body: comments.body,
      })
      .from(comments)
      .where(eq(comments.id, guest.created ? guest.id : ""));
    expect(row.authorId).toBeNull(); // AS-017: no account.
    expect(row.guestName).toBe("Visiting Otter");
    expect(row.guestEmail).toBe("otter@example.com"); // the just-added column, proven live.
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

  test("S-005 / C-012: reanchorForVersion ledger is idempotent — re-run yields identical result, no dup row", async () => {
    // v1 content with a clearly anchorable block; append a v2 to re-anchor onto.
    const docId = await newDoc(h, '<p id="b1">the quick brown fox</p>');
    const annRepo = createAnnotationRepo(h.db);
    const verRepo = createVersionRepo(h.db);

    // An annotation anchored at v1.
    const anchor = buildAnchor({ blockId: "b1", text: "quick brown", offset: 4, length: 11 })!;
    const created = await createAnnotation(
      { docId, anchor, viewer: { kind: "user", userId: "u1" }, sessionRole: "commenter" },
      annRepo,
    );
    const annId = created.created ? created.id : "";

    // Publish v2 (text essentially preserved → the annotation should carry).
    const v2Content = '<p id="b1">the quick brown fox jumps</p>';
    await appendVersion(docId, v2Content, "hash-v2", verRepo);
    const v2Id = await versionId(h, docId, 2);

    const ledgerRepo = createReanchorLedgerRepo(h.db);

    // --- first run ---
    await ledgerRepo.loadEntries(v2Id); // empty cache
    const run1 = reanchorForVersion(
      { annotations: [{ id: annId, anchor }], newContentHtml: v2Content, versionId: v2Id },
      ledgerRepo,
    );
    // Persist each computed ledger entry (idempotent insert).
    for (const e of run1.ledger) {
      const inserted = await ledgerRepo.persistEntry(e);
      expect(inserted).toBe(true); // first time → a real insert.
    }
    expect(run1.ledger.length).toBe(1);
    expect(run1.carried.length + run1.detached.length).toBe(1);

    // Exactly one ledger row in the DB for this (annotation, version).
    let dbRows = await h.db
      .select({ id: reanchorLedger.id, status: reanchorLedger.status })
      .from(reanchorLedger)
      .where(eq(reanchorLedger.versionId, v2Id));
    expect(dbRows.length).toBe(1);
    const firstStatus = dbRows[0].status;

    // --- second run (re-run for the SAME version) ---
    const ledgerRepo2 = createReanchorLedgerRepo(h.db);
    await ledgerRepo2.loadEntries(v2Id); // loads the persisted entry → short-circuits recompute
    const run2 = reanchorForVersion(
      { annotations: [{ id: annId, anchor }], newContentHtml: v2Content, versionId: v2Id },
      ledgerRepo2,
    );
    // Identical result.
    expect(run2.ledger).toEqual(run1.ledger);
    expect(run2.carried).toEqual(run1.carried);
    expect(run2.detached).toEqual(run1.detached);

    // Re-persisting must NOT add a duplicate row (unique constraint / ON CONFLICT).
    for (const e of run2.ledger) {
      const inserted = await ledgerRepo2.persistEntry(e);
      expect(inserted).toBe(false); // already there → no second insert.
    }
    dbRows = await h.db
      .select({ id: reanchorLedger.id, status: reanchorLedger.status })
      .from(reanchorLedger)
      .where(eq(reanchorLedger.versionId, v2Id));
    expect(dbRows.length).toBe(1); // C-012: still exactly one row, no double-apply.
    expect(dbRows[0].status).toBe(firstStatus);
  });
});
