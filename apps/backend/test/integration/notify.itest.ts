// Integration tier (guarded by RUN_INTEGRATION): the full reply→notify→DB path for
// notify-on-reply (workspace-project S-006, AS-011 / C-004) against a REAL Postgres.
// Proves the route dispatches notifications that persist as real `notifications` rows
// and that the right recipients (participants ∪ owner − replier) are reached, with
// owner==participant deduped.
//
// As in annotation-routes.itest, the better-auth cookie flow is too heavy to drive, so
// resolveSession + resolveDocRole are injected with fakes; the point of THIS test is the
// live DB read/write through the route + the notify dispatch.
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/notify.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { annotations, comments, docs, notifications, user } from "../../src/db/schema";
import * as schema from "../../src/db/schema";
import { createApp } from "../../src/app";
import { createDocRepo } from "../../src/publish/repo";
import { MailQueue } from "../../src/auth/mail-queue";
import type { SessionResolver, WorkspaceRoleResolver } from "../../src/http/auth-gate";
import type { LoadShareConfig } from "../../src/routes/annotations";
import { withMigratedDb, seedWorkspace, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;
const guestOn: LoadShareConfig = async () => ({ guestCommentingEnabled: true });

describe.skipIf(!RUN)("notify on reply (real Postgres)", () => {
  let h: MigratedDb;
  let slug: string;
  let docId: string;
  let WS = "";
  const asMember: WorkspaceRoleResolver = async () => "member";
  // Unique user ids per process so parallel files don't collide.
  const A = `u_A_${process.pid}`;
  const B = `u_B_${process.pid}`;
  const C = `u_C_${process.pid}`;

  beforeAll(async () => {
    h = await withMigratedDb();
    // Seed three account-holders. C will own the doc.
    await h.db.insert(user).values([
      { id: A, name: "Alice", email: `alice-${process.pid}@example.com`, emailVerified: true },
      { id: B, name: "Bob", email: `bob-${process.pid}@example.com`, emailVerified: true },
      { id: C, name: "Cara", email: `cara-${process.pid}@example.com`, emailVerified: true },
    ]);

    ({ workspaceId: WS } = await seedWorkspace(h.db, { userId: C }));
    await h.db.insert(schema.workspaceMembers).values([
      { workspaceId: WS, userId: A, role: "member" },
      { workspaceId: WS, userId: B, role: "member" },
    ]);

    slug = `notify-${process.pid}`;
    const created = await createDocRepo(h.db).createDocWithV1({
      slug,
      title: "Notified Doc",
      kind: "html",
      content: "<p>hello world</p>",
      contentHash: "hash-v1",
    });
    docId = created.id;
    // C is the owner; doc is anyone-with-link so the reply route's access gate passes.
    await h.db
      .update(docs)
      .set({ generalAccess: "anyone_with_link", ownerId: C })
      .where(eq(docs.id, docId));
  });

  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  });

  function req(path: string, init: RequestInit = {}) {
    return new Request(`http://localhost${path}`, {
      headers: { "content-type": "application/json" },
      ...init,
    });
  }

  // Build an app whose session resolves to a given user; notify wired to the real DB +
  // a real (in-memory) MailQueue we can inspect.
  function appAs(userId: string, mail: MailQueue) {
    const resolveSession: SessionResolver = async () => ({ userId });
    return createApp({
      dbCheck: async () => {},
      annotations: {
        db: h.db,
        resolveSession,
        resolveWorkspaceRole: asMember,
        resolveDocRole: async () => "owner" as const,
        accessDeps: { isInvited: () => true, isWorkspaceMember: () => true },
        loadShareConfig: guestOn,
        notify: { mail },
      },
    });
  }

  test("AS-011: A replies thread {A,B} owner C → B and C each get 1 in-app row + 1 email; A none", async () => {
    // Create an annotation on the doc (as some user); seed A's and B's comments so both
    // are thread participants.
    const mailSetup = new MailQueue();
    const createRes = await appAs(A, mailSetup).handle(
      req(`/api/w/${WS}/docs/${slug}/annotations`, {
        method: "POST",
        body: JSON.stringify({ anchor: { blockId: "block-p-1", textSnippet: "hello", offset: 0, length: 5 } }),
      }),
    );
    expect(createRes.status).toBe(201);
    const annId = ((await createRes.json()) as any).data.annotationId;

    // A and B both comment on the annotation (participants A, B). Keep B's comment id
    // as the reply target (a real root comment in the thread).
    const seeded = await h.db
      .insert(comments)
      .values([
        { annotationId: annId, parentId: null, authorId: A, guestName: null, body: "A's comment" },
        { annotationId: annId, parentId: null, authorId: B, guestName: null, body: "B's comment" },
      ])
      .returning({ id: comments.id });
    const rootId = seeded[0].id;

    // A replies → notify B and C (owner), NOT A.
    const mail = new MailQueue();
    const replyRes = await appAs(A, mail).handle(
      req(`/api/w/${WS}/annotations/${annId}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "A's reply", parentId: rootId }),
      }),
    );
    expect(replyRes.status).toBe(201);

    const rows = await h.db.select().from(notifications).where(eq(notifications.refId, annId));
    const recipients = rows.map((r) => r.userId).sort();
    expect(recipients).toEqual([B, C].sort());
    expect(recipients).not.toContain(A);
    // One row per recipient (B, C) — no duplicates.
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.type === "reply" && r.read === false)).toBe(true);

    // Email: one enqueued per recipient (B, C) → 2 pending in the queue.
    expect(mail.statusCounts().pending).toBe(2);
  });

  test("C-004: owner C is also a participant → C deduped to exactly ONE notification", async () => {
    const mailSetup = new MailQueue();
    const createRes = await appAs(A, mailSetup).handle(
      req(`/api/w/${WS}/docs/${slug}/annotations`, {
        method: "POST",
        body: JSON.stringify({ anchor: { blockId: "block-p-1", textSnippet: "world", offset: 6, length: 5 } }),
      }),
    );
    const annId = ((await createRes.json()) as any).data.annotationId;

    // B and C BOTH comment (C is participant AND owner); A replies.
    const seeded = await h.db
      .insert(comments)
      .values([
        { annotationId: annId, parentId: null, authorId: B, guestName: null, body: "B" },
        { annotationId: annId, parentId: null, authorId: C, guestName: null, body: "C" },
      ])
      .returning({ id: comments.id });
    const rootId = seeded[0].id;

    const mail = new MailQueue();
    const replyRes = await appAs(A, mail).handle(
      req(`/api/w/${WS}/annotations/${annId}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "A's reply", parentId: rootId }),
      }),
    );
    expect(replyRes.status).toBe(201);

    const rows = await h.db.select().from(notifications).where(eq(notifications.refId, annId));
    // Recipients {B, C}; C exactly once despite being owner + participant.
    expect(rows.map((r) => r.userId).sort()).toEqual([B, C].sort());
    expect(rows.filter((r) => r.userId === C)).toHaveLength(1);
    expect(mail.statusCounts().pending).toBe(2);
  });
});
