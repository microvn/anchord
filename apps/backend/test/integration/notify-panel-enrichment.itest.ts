// Integration tier (guarded by RUN_INTEGRATION): the in-app notification panel ENRICHMENT read
// (notifications-email S-006, AS-026/AS-027/AS-028/AS-029) against a REAL Postgres. The list read is
// a multi-LEFT-JOIN (notifications → annotations → docs, and → comments → user) — a mock would hide a
// join bug, so this seeds real rows and asserts the read derives docTitle / actorName / snippet and
// degrades NULL-safely. C-014: snippet is in-app only; the email path is asserted body-free elsewhere.
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/notify-panel-enrichment.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  annotations,
  comments,
  docs,
  notifications,
  projects,
  user,
  workspaces,
} from "../../src/db/schema";
import { createNotificationReadRepo } from "../../src/notify/read-repo";
import { withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;

describe.skipIf(!RUN)("notification panel enrichment (real Postgres)", () => {
  let h: MigratedDb;
  // The recipient whose bell we read, plus the member commenter "Mara".
  const BOB = `u_bob_${process.pid}`;
  const MARA = `u_mara_${process.pid}`;
  let docId: string;
  let annId: string;
  // Comment ids threaded onto notification rows.
  let memberCommentId: string;
  let guestCommentId: string;
  let longCommentId: string;
  let deletedCommentId: string;

  beforeAll(async () => {
    h = await withMigratedDb();

    await h.db.insert(user).values([
      { id: BOB, name: "Bob", email: `bob-${process.pid}@example.com`, emailVerified: true },
      { id: MARA, name: "Mara", email: `mara-${process.pid}@example.com`, emailVerified: true },
    ]);

    const [doc] = await h.db
      .insert(docs)
      .values({ slug: `refund-${process.pid}`, title: "Refund Spec", kind: "html" })
      .returning({ id: docs.id });
    docId = doc!.id;

    const [ann] = await h.db
      .insert(annotations)
      .values({ docId, type: "range", anchor: {} })
      .returning({ id: annotations.id });
    annId = ann!.id;

    // A member comment (author Mara) + a guest comment (guest_name, null author) on the thread.
    const seeded = await h.db
      .insert(comments)
      .values([
        { annotationId: annId, parentId: null, authorId: MARA, guestName: null, body: "Mara's note" },
        { annotationId: annId, parentId: null, authorId: null, guestName: "swift-otter-k7m2", body: "guest note" },
        {
          annotationId: annId,
          parentId: null,
          authorId: MARA,
          guestName: null,
          body: "can we cap the partial refund at 50% of the original charge so finance stays whole here",
        },
        { annotationId: annId, parentId: null, authorId: MARA, guestName: null, body: "to be deleted" },
      ])
      .returning({ id: comments.id });
    memberCommentId = seeded[0]!.id;
    guestCommentId = seeded[1]!.id;
    longCommentId = seeded[2]!.id;
    deletedCommentId = seeded[3]!.id;
  });

  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  });

  test("AS-026: a doc-scoped row carries its doc title; a non-doc row carries none", async () => {
    const repo = createNotificationReadRepo(h.db);
    // A doc-scoped row (refId → the annotation on "Refund Spec") + a non-doc `invited` row.
    await h.db.insert(notifications).values([
      { userId: BOB, type: "thread_activity", refId: annId, commentId: memberCommentId },
      { userId: BOB, type: "invited", refId: `ws-${process.pid}`, commentId: null },
    ]);

    const rows = await repo.listForUser(BOB, { offset: 0, limit: 50 });
    const docRow = rows.find((r) => r.type === "thread_activity" && r.refId === annId);
    const invitedRow = rows.find((r) => r.type === "invited");

    expect(docRow?.docTitle).toBe("Refund Spec");
    expect(invitedRow?.docTitle).toBeNull(); // non-doc row → no title
  });

  test("AS-027: a comment-type row carries the actor — member name, then guest name", async () => {
    const repo = createNotificationReadRepo(h.db);
    const memberRefMarker = `${annId}`; // shared annotation; distinguish by commentId via the row id
    const inserted = await h.db
      .insert(notifications)
      .values([
        { userId: BOB, type: "thread_activity", refId: memberRefMarker, commentId: memberCommentId },
        { userId: BOB, type: "thread_activity", refId: memberRefMarker, commentId: guestCommentId },
      ])
      .returning({ id: notifications.id });

    const rows = await repo.listForUser(BOB, { offset: 0, limit: 50 });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const memberRow = byId.get(inserted[0]!.id);
    const guestRow = byId.get(inserted[1]!.id);

    expect(memberRow?.actorName).toBe("Mara"); // member commenter → user.name
    expect(guestRow?.actorName).toBe("swift-otter-k7m2"); // guest commenter → guest_name
  });

  test("AS-028: a comment-type row carries a (truncated) excerpt of the comment body", async () => {
    const repo = createNotificationReadRepo(h.db);
    const [ins] = await h.db
      .insert(notifications)
      .values({ userId: BOB, type: "new_feedback", refId: annId, commentId: longCommentId })
      .returning({ id: notifications.id });

    const rows = await repo.listForUser(BOB, { offset: 0, limit: 50 });
    const row = rows.find((r) => r.id === ins!.id);
    expect(row?.snippet).toBeTruthy();
    // The excerpt is a prefix of the real body, bounded (≤140) — IN-APP ONLY (C-014).
    expect("can we cap the partial refund at 50% of the original charge so finance stays whole here").toContain(
      row!.snippet!,
    );
    expect(row!.snippet!.length).toBeLessThanOrEqual(140);
  });

  test("quote: a row carries the anchored text (annotation textSnippet); empty/non-anchor → null", async () => {
    const repo = createNotificationReadRepo(h.db);
    // A NEW annotation whose anchor captures the quoted text, on the same doc.
    const [quotedAnn] = await h.db
      .insert(annotations)
      .values({
        docId,
        type: "range",
        anchor: { blockId: "b1", offset: 0, length: 12, textSnippet: "All AI-generated HTML is sanitized." },
      })
      .returning({ id: annotations.id });
    const ins = await h.db
      .insert(notifications)
      .values([
        { userId: BOB, type: "reply", refId: quotedAnn!.id, commentId: memberCommentId },
        // The shared `annId` annotation has an EMPTY anchor → quote must be null (null-safe).
        { userId: BOB, type: "reply", refId: annId, commentId: memberCommentId },
        // A non-annotation row (invited) → quote null.
        { userId: BOB, type: "invited", refId: `ws-q-${process.pid}`, commentId: null },
      ])
      .returning({ id: notifications.id });

    const rows = await repo.listForUser(BOB, { offset: 0, limit: 100 });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(ins[0]!.id)?.quote).toBe("All AI-generated HTML is sanitized.");
    expect(byId.get(ins[1]!.id)?.quote).toBeNull(); // empty anchor → no textSnippet
    expect(byId.get(ins[2]!.id)?.quote).toBeNull(); // non-annotation row
  });

  test("AS-029: a non-comment row and a deleted-comment row carry no actor/snippet, no error", async () => {
    const repo = createNotificationReadRepo(h.db);
    // An `invited` row (no comment) + a comment-type row whose comment is then DELETED (set-null FK).
    const [inv] = await h.db
      .insert(notifications)
      .values({ userId: BOB, type: "invited", refId: `ws2-${process.pid}`, commentId: null })
      .returning({ id: notifications.id });
    const [orphan] = await h.db
      .insert(notifications)
      .values({ userId: BOB, type: "thread_activity", refId: annId, commentId: deletedCommentId })
      .returning({ id: notifications.id });

    // Delete the triggering comment → the FK set-null fires; the read must degrade, never throw.
    await h.db.delete(comments).where(eq(comments.id, deletedCommentId));

    const rows = await repo.listForUser(BOB, { offset: 0, limit: 50 });
    const invitedRow = rows.find((r) => r.id === inv!.id);
    const orphanRow = rows.find((r) => r.id === orphan!.id);

    expect(invitedRow?.actorName).toBeNull();
    expect(invitedRow?.snippet).toBeNull();
    expect(orphanRow?.actorName).toBeNull(); // comment gone → no actor (AS-029)
    expect(orphanRow?.snippet).toBeNull(); // comment gone → no excerpt
  });

  // your-activity-inbox S-001 (BE-enrich): workspaceId+workspaceName flow through the read so the
  // cross-workspace For-you inbox renders a per-item workspace chip (AS-003). Two derivation paths:
  // the doc chain (annotation → doc → project → workspace) and the `workspace_*` refId/refLabel path.
  describe("your-activity-inbox S-001 — workspace enrichment", () => {
    test("AS-003: a doc-backed row carries its owning workspace via the doc→project→workspace chain", async () => {
      const repo = createNotificationReadRepo(h.db);
      const [ws] = await h.db
        .insert(workspaces)
        .values({ name: "Acme Platform", slug: `acme-${process.pid}`, settings: {} })
        .returning({ id: workspaces.id });
      const [proj] = await h.db
        .insert(projects)
        .values({ workspaceId: ws!.id, name: "Core", ownerId: MARA })
        .returning({ id: projects.id });
      const [doc2] = await h.db
        .insert(docs)
        .values({
          slug: `web-core-${process.pid}`,
          title: "Web-core behavior contract",
          kind: "html",
          projectId: proj!.id,
        })
        .returning({ id: docs.id });
      const [ann2] = await h.db
        .insert(annotations)
        .values({ docId: doc2!.id, type: "range", anchor: {} })
        .returning({ id: annotations.id });
      const [ins] = await h.db
        .insert(notifications)
        .values({ userId: BOB, type: "reply", refId: ann2!.id, commentId: memberCommentId })
        .returning({ id: notifications.id });

      const rows = await repo.listForUser(BOB, { offset: 0, limit: 50 });
      const row = rows.find((r) => r.id === ins!.id);
      expect(row?.workspaceId).toBe(ws!.id);
      expect(row?.workspaceName).toBe("Acme Platform");
    });

    test("BE-enrich: a workspace_invited row takes workspaceId from refId + name from refLabel (no doc chain)", async () => {
      const repo = createNotificationReadRepo(h.db);
      const [ws] = await h.db
        .insert(workspaces)
        .values({ name: "Field IO", slug: `field-${process.pid}`, settings: {} })
        .returning({ id: workspaces.id });
      const [ins] = await h.db
        .insert(notifications)
        .values({ userId: BOB, type: "workspace_invited", refId: ws!.id, refLabel: "Field IO" })
        .returning({ id: notifications.id });

      const rows = await repo.listForUser(BOB, { offset: 0, limit: 50 });
      const row = rows.find((r) => r.id === ins!.id);
      // refId IS the workspace id; refLabel is the emit-time name snapshot.
      expect(row?.workspaceId).toBe(ws!.id);
      expect(row?.workspaceName).toBe("Field IO");
    });

    test("BE-enrich: a doc-less, non-workspace row resolves workspaceId/Name to null (NULL-safe)", async () => {
      const repo = createNotificationReadRepo(h.db);
      const [ins] = await h.db
        .insert(notifications)
        .values({ userId: BOB, type: "invited", refId: `nows-${process.pid}`, commentId: null })
        .returning({ id: notifications.id });

      const rows = await repo.listForUser(BOB, { offset: 0, limit: 50 });
      const row = rows.find((r) => r.id === ins!.id);
      expect(row?.workspaceId).toBeNull();
      expect(row?.workspaceName).toBeNull();
    });
  });
});
