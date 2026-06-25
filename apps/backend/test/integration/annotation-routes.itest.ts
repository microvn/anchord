// Integration tier (guarded by RUN_INTEGRATION): the full route→service→DB path
// for the annotation-core /api routes against a REAL Postgres. Proves the HTTP glue
// persists and reads back through actual rows: create annotation → listable, reply →
// flat, resolve → reopen, guest comment with email, suggestion create + accept.
//
// The better-auth cookie flow is heavy to drive in-test, so resolveSession +
// resolveDocRole are injected with fakes (a member acting as owner) — the point of
// THIS test is the live DB read/write through the routes, not auth.
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/annotation-routes.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { annotations, comments, docs, shareLinks, user } from "../../src/db/schema";
import { createApp } from "../../src/app";
import { createDocRepo } from "../../src/publish/repo";
import type { SessionResolver, WorkspaceRoleResolver } from "../../src/http/auth-gate";
import { withMigratedDb, seedWorkspace, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;
const member: SessionResolver = async () => ({ userId: "u_itest" });
const noSession: SessionResolver = async () => null;
const asMember: WorkspaceRoleResolver = async () => "member";

describe.skipIf(!RUN)("annotation-core routes (real Postgres)", () => {
  let h: MigratedDb;
  let app: ReturnType<typeof createApp>;
  let guestApp: ReturnType<typeof createApp>;
  let slug: string;
  let docId: string;
  let WS = "";

  beforeAll(async () => {
    h = await withMigratedDb();
    // comments.author_id FKs user.id — seed the session user so a signed-in reply inserts.
    await h.db
      .insert(user)
      .values({ id: "u_itest", name: "Itest User", email: `itest-${process.pid}@example.com`, emailVerified: true });
    ({ workspaceId: WS } = await seedWorkspace(h.db, { userId: "u_itest" }));
    slug = `annroutes-${process.pid}`;
    const created = await createDocRepo(h.db).createDocWithV1({
      slug,
      title: "Annotated Doc",
      kind: "html",
      content: "<p>hello world</p>",
      contentHash: "hash-v1",
    });
    docId = created.id;
    // anyone_with_link → the doc carries a share_links row with the link axis on.
    await h.db.insert(shareLinks).values({ docId, linkRole: "commenter" });

    const base = {
      db: h.db,
      resolveSession: member,
      resolveWorkspaceRole: asMember,
      resolveDocRole: async () => "owner" as const,
      // S-001: the single read gate. The seeded doc is anyone_with_link → both the member
      // and the anon guest may view; member resolves to owner, anon to the link role.
      resolveAccess: async (_docId: string, viewer: { kind: string }) =>
        viewer.kind === "user"
          ? { role: "owner" as const, canView: true }
          : { role: "commenter" as const, canView: true },
    };
    app = createApp({ dbCheck: async () => {}, annotations: base });
    // A second app whose session resolver returns null → drives the guest path.
    guestApp = createApp({
      dbCheck: async () => {},
      annotations: { ...base, resolveSession: noSession },
    });
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

  test("create annotation → 201 + listable; reply → flat; resolve → reopen; on real DB", async () => {
    // Create a text annotation
    const createRes = await app.handle(
      req(`/api/w/${WS}/docs/${slug}/annotations`, {
        method: "POST",
        body: JSON.stringify({ anchor: { blockId: "block-p-1", textSnippet: "hello", offset: 0, length: 5 } }),
      }),
    );
    expect(createRes.status).toBe(201);
    const annId = ((await createRes.json()) as any).data.annotationId;
    expect(annId).toBeString();

    // It is listable
    const listRes = await app.handle(req(`/api/w/${WS}/docs/${slug}/annotations`));
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as any;
    expect(list.data.items.some((a: any) => a.id === annId)).toBe(true);

    // Seed a root comment directly, then reply via the route → flat parentId
    const [root] = await h.db
      .insert(comments)
      .values({ annotationId: annId, parentId: null, authorId: null, guestName: "Root", body: "root comment" })
      .returning({ id: comments.id });

    const replyRes = await app.handle(
      req(`/api/w/${WS}/annotations/${annId}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "a reply", parentId: root.id }),
      }),
    );
    expect(replyRes.status).toBe(201);
    const replyId = ((await replyRes.json()) as any).data.commentId;

    const rows = await h.db.select().from(comments).where(eq(comments.annotationId, annId));
    const reply = rows.find((r) => r.id === replyId)!;
    expect(reply.parentId).toBe(root.id); // C-004: flat — points at the root

    // Resolve → status resolved on the real row
    const resolveRes = await app.handle(
      req(`/api/w/${WS}/annotations/${annId}/resolution`, { method: "PATCH", body: JSON.stringify({ resolved: true }) }),
    );
    expect(resolveRes.status).toBe(200);
    expect(((await resolveRes.json()) as any).data.status).toBe("resolved");
    let [annRow] = await h.db.select().from(annotations).where(eq(annotations.id, annId));
    expect(annRow.status).toBe("resolved");

    // Reopen → unresolved
    const reopenRes = await app.handle(
      req(`/api/w/${WS}/annotations/${annId}/resolution`, { method: "PATCH", body: JSON.stringify({ resolved: false }) }),
    );
    expect(((await reopenRes.json()) as any).data.status).toBe("unresolved");
    [annRow] = await h.db.select().from(annotations).where(eq(annotations.id, annId));
    expect(annRow.status).toBe("unresolved");
  });

  test("AS-007: a signed-in reply records the session user as author_id (no guest name)", async () => {
    // Create an annotation, seed a root comment, then reply via the route as the
    // u_itest session → the persisted reply's author_id is u_itest, guest_name null.
    const createRes = await app.handle(
      req(`/api/w/${WS}/docs/${slug}/annotations`, {
        method: "POST",
        body: JSON.stringify({ anchor: { blockId: "block-p-1", textSnippet: "hello", offset: 0, length: 5 } }),
      }),
    );
    const annId = ((await createRes.json()) as any).data.annotationId;
    const [root] = await h.db
      .insert(comments)
      .values({ annotationId: annId, parentId: null, authorId: null, guestName: "Root", body: "root" })
      .returning({ id: comments.id });

    const replyRes = await app.handle(
      req(`/api/w/${WS}/annotations/${annId}/comments`, {
        method: "POST",
        // forged identity in the body must be ignored (C-005) — author comes from session.
        body: JSON.stringify({ body: "session reply", parentId: root.id, authorId: "attacker" }),
      }),
    );
    expect(replyRes.status).toBe(201);
    const cid = ((await replyRes.json()) as any).data.commentId;

    const [row] = await h.db.select().from(comments).where(eq(comments.id, cid));
    expect(row.authorId).toBe("u_itest"); // AS-007 / C-005: recorded from the session
    expect(row.guestName).toBeNull();
  });

  test("guest comment with email → 201, persisted with author_id NULL", async () => {
    // Need an annotation to comment on
    const createRes = await app.handle(
      req(`/api/w/${WS}/docs/${slug}/annotations`, {
        method: "POST",
        body: JSON.stringify({ anchor: { blockId: "block-p-1", textSnippet: "world", offset: 6, length: 5 } }),
      }),
    );
    const annId = ((await createRes.json()) as any).data.annotationId;

    const guestRes = await guestApp.handle(
      req(`/api/w/${WS}/annotations/${annId}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "guest feedback", guestName: "Anon Otter" }),
      }),
    );
    expect(guestRes.status).toBe(201);
    const cid = ((await guestRes.json()) as any).data.commentId;

    const [row] = await h.db.select().from(comments).where(eq(comments.id, cid));
    expect(row.authorId).toBeNull();
    expect(row.guestName).toBe("Anon Otter"); // AS-017: name only — no email column.
    expect(row.body).toBe("guest feedback");
  });

  test("suggestion create + accept (from still matches) → accepted on real DB", async () => {
    const createRes = await app.handle(
      req(`/api/w/${WS}/docs/${slug}/suggestions`, {
        method: "POST",
        body: JSON.stringify({
          anchor: { blockId: "block-p-1", textSnippet: "hello world", offset: 0, length: 11 },
          from: "hello",
          to: "hi",
          againstVersion: 1,
        }),
      }),
    );
    expect(createRes.status).toBe(201);
    const sugId = ((await createRes.json()) as any).data.suggestionId;

    // Accept — current version content still contains "hello" → accepted
    const acceptRes = await app.handle(
      req(`/api/w/${WS}/suggestions/${sugId}`, { method: "PATCH", body: JSON.stringify({ decision: "accept" }) }),
    );
    expect(acceptRes.status).toBe(200);
    expect(((await acceptRes.json()) as any).data.status).toBe("accepted");

    const [row] = await h.db.select().from(annotations).where(eq(annotations.id, sugId));
    expect(row.type).toBe("suggestion");
    expect(row.suggestionStatus).toBe("accepted");
    // C-003: doc content untouched — the version body is unchanged.
  });
});
