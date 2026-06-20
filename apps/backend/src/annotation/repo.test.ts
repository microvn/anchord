// annotation-core C-017 (mcp-roundtrip AS-008 producer) — the updated_at BUMP invariant.
//
// Proves every annotation/comment mutation site in repo.ts stamps `updated_at = now()` so a
// changed-since pull surfaces the row: resolve/reopen, suggestion-decide, suggestion-reset,
// delete/restore, re-anchor (carried AND detached), dismiss/reattach — AND that adding a
// comment/reply bumps its PARENT annotation's updated_at (so a reply surfaces via the
// annotation's watermark). The lexicographic (updated_at, id) changed-since ORDER with a
// same-timestamp tie-break is a live-Postgres concern → test/integration/changed-since.itest.ts.
//
// We drive the REAL repo factories against a tiny chainable fake `db` that records what each
// .set()/.values() carried — no DB needed for the bump-call invariant (the fake-repo pattern).

import { describe, expect, test } from "bun:test";
import {
  createResolutionRepo,
  createSuggestionRepo,
  createDeleteRepo,
  createReanchorApplyRepo,
  createDismissReattachRepo,
  createCommentRepo,
  createGuestCommentRepo,
} from "./repo";
import type { DB } from "../db/client";

interface UpdateCall {
  set: Record<string, unknown>;
}
interface InsertCall {
  values: Record<string, unknown>;
}

/**
 * A chainable fake matching the slice of the Drizzle query builder repo.ts uses:
 *   db.update(t).set(payload).where(...)            → records the set payload
 *   db.insert(t).values(payload).returning(...)     → records values, returns [{id}]
 *   db.transaction(cb)                              → runs cb with the same fake (records too)
 */
function fakeDb() {
  const updates: UpdateCall[] = [];
  const inserts: InsertCall[] = [];
  const handle: any = {
    update(_t: unknown) {
      return {
        set(payload: Record<string, unknown>) {
          const call: UpdateCall = { set: payload };
          updates.push(call);
          return {
            where(_w: unknown) {
              return Promise.resolve(undefined);
            },
          };
        },
      };
    },
    insert(_t: unknown) {
      return {
        values(payload: Record<string, unknown>) {
          inserts.push({ values: payload });
          return {
            returning(_cols: unknown) {
              return Promise.resolve([{ id: "generated_id" }]);
            },
          };
        },
      };
    },
    async transaction(cb: (tx: unknown) => Promise<unknown>) {
      return cb(handle); // same fake — sub-calls record into the same arrays
    },
  };
  return { db: handle as DB, updates, inserts };
}

/** True iff the call carried a fresh `updatedAt` Date (the C-017 bump). */
function bumpedUpdatedAt(call: UpdateCall): boolean {
  return call.set.updatedAt instanceof Date;
}

describe("C-017: updated_at is bumped at every annotation mutation site", () => {
  test("C-017: resolve/reopen (setAnnotationStatus) bumps updated_at", async () => {
    const { db, updates } = fakeDb();
    await createResolutionRepo(db).setAnnotationStatus("a1", "resolved");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.set.status).toBe("resolved");
    expect(bumpedUpdatedAt(updates[0]!)).toBe(true);
  });

  test("C-017: suggestion-reset-to-pending (reopen of a decided suggestion) bumps updated_at", async () => {
    const { db, updates } = fakeDb();
    await createResolutionRepo(db).resetSuggestionStatusToPending("a1");
    expect(updates[0]!.set.suggestionStatus).toBe("pending");
    expect(bumpedUpdatedAt(updates[0]!)).toBe(true);
  });

  test("C-017: suggestion-decide (accept/reject/stale) bumps updated_at", async () => {
    const { db, updates } = fakeDb();
    await createSuggestionRepo(db).setSuggestionStatus("a1", "accepted");
    expect(updates[0]!.set.suggestionStatus).toBe("accepted");
    expect(bumpedUpdatedAt(updates[0]!)).toBe(true);
  });

  test("C-017: soft-delete + restore both bump updated_at", async () => {
    const repoDb = fakeDb();
    const repo = createDeleteRepo(repoDb.db);
    await repo.setDeletedAt("a1");
    await repo.clearDeletedAt("a1");
    expect(repoDb.updates).toHaveLength(2);
    expect(repoDb.updates[0]!.set.deletedAt).toBeInstanceOf(Date); // delete stamps tombstone
    expect(bumpedUpdatedAt(repoDb.updates[0]!)).toBe(true);
    expect(repoDb.updates[1]!.set.deletedAt).toBeNull(); // restore clears it
    expect(bumpedUpdatedAt(repoDb.updates[1]!)).toBe(true);
  });

  test("C-017: re-anchor carried AND detached both bump updated_at", async () => {
    const repoDb = fakeDb();
    const repo = createReanchorApplyRepo(repoDb.db);
    const anchor = { blockId: "b", textSnippet: "t", offset: 0, length: 1 };
    await repo.applyCarried("a1", anchor as never);
    await repo.markDetached("a1");
    expect(repoDb.updates[0]!.set.isOrphaned).toBe(false); // carried clears orphan
    expect(bumpedUpdatedAt(repoDb.updates[0]!)).toBe(true);
    expect(repoDb.updates[1]!.set.isOrphaned).toBe(true); // detached sets orphan — easy to miss
    expect(bumpedUpdatedAt(repoDb.updates[1]!)).toBe(true);
  });

  test("C-017: dismiss + reattach both bump updated_at", async () => {
    const repoDb = fakeDb();
    const repo = createDismissReattachRepo(repoDb.db);
    await repo.dismiss("a1");
    await repo.reattach("a1", { blockId: "b", textSnippet: "t", offset: 0, length: 1 } as never);
    expect(repoDb.updates[0]!.set.dismissedAt).toBeInstanceOf(Date);
    expect(bumpedUpdatedAt(repoDb.updates[0]!)).toBe(true);
    expect(repoDb.updates[1]!.set.isOrphaned).toBe(false);
    expect(bumpedUpdatedAt(repoDb.updates[1]!)).toBe(true);
  });

  test("C-017: adding a comment bumps its PARENT annotation's updated_at (so a reply surfaces)", async () => {
    const { db, updates, inserts } = fakeDb();
    await createCommentRepo(db).insertComment({
      annotationId: "a_parent",
      parentId: null,
      authorId: "u1",
      guestName: null,
      body: "a reply",
    });
    // the comment row was inserted...
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.values.annotationId).toBe("a_parent");
    // ...AND the parent annotation's updated_at was bumped in the same transaction (C-017).
    expect(updates).toHaveLength(1);
    expect(bumpedUpdatedAt(updates[0]!)).toBe(true);
  });

  test("C-017: a GUEST comment also bumps its parent annotation's updated_at", async () => {
    const { db, updates, inserts } = fakeDb();
    await createGuestCommentRepo(db).insertComment({
      annotationId: "a_parent",
      parentId: null,
      authorId: null,
      guestName: "Guest",
      body: "guest reply",
    });
    expect(inserts).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(bumpedUpdatedAt(updates[0]!)).toBe(true);
  });
});
