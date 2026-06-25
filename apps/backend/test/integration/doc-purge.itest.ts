// Integration tier (guarded by RUN_INTEGRATION): doc-delete-trash S-007 over REAL Postgres.
// Proves the one claim the no-DB route test can only assert structurally — the PERMANENT delete
// actually CASCADES every child row:
//   AS-034 — purgeDeleted hard-removes a deleted doc whose deleted_workspace_id = the path
//            workspace, and its versions / annotations / comments / share_links go with it via the
//            schema FKs (on delete cascade). Nothing is left orphaned.
//   C-007  — purgeDeleted scoped to deleted_workspace_id: an active doc (deleted_at IS NULL) and a
//            doc in another workspace's Trash are unreachable (0 rows changed), so neither they nor
//            their children are touched.
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/doc-purge.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  annotations,
  comments,
  docVersions,
  docs,
  shareLinks,
  user as userTable,
} from "../../src/db/schema";
import { createDocDeleteRepo } from "../../src/workspace/doc-delete-repo";
import { seedWorkspace, withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;

describe.skipIf(!RUN)("doc-delete-trash S-007: permanent delete cascade (real Postgres)", () => {
  let h: MigratedDb;
  let WS = "";
  let WS_OTHER = "";
  const U = `u-s007-${process.pid}`;

  // Build a doc in WS with one version, one annotation, one comment, and a share_links row, then
  // tombstone it (deleted_at + deleted_workspace_id). Returns the ids so the test can check removal.
  async function mkDeletedDoc(opts: {
    n: number;
    workspaceId: string;
    deleted: boolean;
  }): Promise<{ docId: string; versionId: string; annotationId: string; commentId: string }> {
    const [doc] = await h.db
      .insert(docs)
      .values({
        slug: `s007-${opts.n}-${process.pid}`,
        title: `Doc ${opts.n}`,
        kind: "markdown",
        ownerId: U,
        deletedAt: opts.deleted ? new Date() : null,
        deletedWorkspaceId: opts.deleted ? opts.workspaceId : null,
      })
      .returning({ id: docs.id });
    const docId = doc!.id;
    const [v] = await h.db
      .insert(docVersions)
      .values({ docId, version: 1, content: "# body", contentHash: `h-${opts.n}-${process.pid}` })
      .returning({ id: docVersions.id });
    const [a] = await h.db
      .insert(annotations)
      .values({ docId, type: "doc", anchor: {} })
      .returning({ id: annotations.id });
    const [c] = await h.db
      .insert(comments)
      .values({ annotationId: a!.id, body: "a comment" })
      .returning({ id: comments.id });
    await h.db.insert(shareLinks).values({ docId, workspaceRole: "commenter", linkRole: null });
    return { docId, versionId: v!.id, annotationId: a!.id, commentId: c!.id };
  }

  beforeAll(async () => {
    h = await withMigratedDb();
    await h.db
      .insert(userTable)
      .values({ id: U, name: "Mai", email: `s007-${process.pid}@itest.local`, emailVerified: true });
    WS = (await seedWorkspace(h.db, { userId: U })).workspaceId;
    WS_OTHER = (await seedWorkspace(h.db, { userId: U })).workspaceId;
  });

  afterAll(async () => {
    await h.close();
    await h.stop();
  });

  test("AS-034: purgeDeleted removes the doc AND cascades versions/annotations/comments/share_links", async () => {
    const ids = await mkDeletedDoc({ n: 1, workspaceId: WS, deleted: true });
    const repo = createDocDeleteRepo(h.db);

    const changed = await repo.purgeDeleted(WS, ids.docId);
    expect(changed).toBe(1);

    // The doc row is gone…
    expect(await h.db.select().from(docs).where(eq(docs.id, ids.docId))).toHaveLength(0);
    // …and every child cascaded (nothing orphaned).
    expect(
      await h.db.select().from(docVersions).where(eq(docVersions.id, ids.versionId)),
    ).toHaveLength(0);
    expect(
      await h.db.select().from(annotations).where(eq(annotations.id, ids.annotationId)),
    ).toHaveLength(0);
    expect(await h.db.select().from(comments).where(eq(comments.id, ids.commentId))).toHaveLength(0);
    expect(await h.db.select().from(shareLinks).where(eq(shareLinks.docId, ids.docId))).toHaveLength(
      0,
    );
  });

  test("AS-034 / C-007: an ACTIVE doc cannot be purged via this path (0 rows, doc + children intact)", async () => {
    const ids = await mkDeletedDoc({ n: 2, workspaceId: WS, deleted: false }); // active
    const repo = createDocDeleteRepo(h.db);

    const changed = await repo.purgeDeleted(WS, ids.docId);
    expect(changed).toBe(0);
    // Untouched.
    expect(await h.db.select().from(docs).where(eq(docs.id, ids.docId))).toHaveLength(1);
    expect(
      await h.db.select().from(docVersions).where(eq(docVersions.id, ids.versionId)),
    ).toHaveLength(1);
  });

  test("AS-034 / C-007: a deleted doc in ANOTHER workspace's Trash is unreachable (0 rows, intact)", async () => {
    const ids = await mkDeletedDoc({ n: 3, workspaceId: WS_OTHER, deleted: true });
    const repo = createDocDeleteRepo(h.db);

    // Purge through WS (not WS_OTHER) → scoped on deleted_workspace_id → no match.
    const changed = await repo.purgeDeleted(WS, ids.docId);
    expect(changed).toBe(0);
    expect(await h.db.select().from(docs).where(eq(docs.id, ids.docId))).toHaveLength(1);
  });
});
