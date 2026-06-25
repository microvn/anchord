// Integration tier (guarded by RUN_INTEGRATION): the ATOMIC view-limit consume against
// a REAL Postgres. Headline case (sharing S-004 / AS-017 / C-011): with view_limit = N,
// firing N+M opens nearly simultaneously must serve at most N — the surplus get no row
// back and are denied. This is the multi-writer correctness the unit suite could only
// stub behind a fake (decideConsumeView); the single-statement conditional UPDATE is
// the real arbiter. Mirrors version-repo.itest.ts's concurrency proof.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDocRepo } from "../../src/publish/repo";
import { shareLinks } from "../../src/db/schema";
import { setLinkControls, tryConsumeView } from "../../src/sharing/link-controls-repo";
import { eq } from "drizzle-orm";
import { withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;

let docSeq = 0;
/** Create a fresh doc (with version 1) via the real publish repo; return its id. */
async function newDoc(h: MigratedDb): Promise<string> {
  const slug = `sharelink-itest-${process.pid}-${++docSeq}`;
  const { id } = await createDocRepo(h.db).createDocWithV1({
    slug,
    title: `Doc ${slug}`,
    kind: "markdown",
    content: "# v1",
    contentHash: "hash-v1",
  });
  return id;
}

/** Insert a share_links row for a doc with the given view_limit (null = unlimited). */
async function newShareLink(h: MigratedDb, docId: string, viewLimit: number | null) {
  await h.db.insert(shareLinks).values({ docId, linkRole: "viewer", viewLimit });
}

describe.skipIf(!RUN)("share-link view-limit (real Postgres)", () => {
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

  test("AS-017: view-limit=5, 20 PARALLEL opens → exactly 5 served, 15 denied (atomic increment)", async () => {
    const docId = await newDoc(h);
    const N = 5;
    const TOTAL = 20;
    await newShareLink(h, docId, N);

    // Fire 20 consumes at once. The conditional UPDATE serializes per-row in Postgres,
    // so only the 5 that find view_count < 5 win; the rest get no row → denied.
    const results = await Promise.all(
      Array.from({ length: TOTAL }, () => tryConsumeView(h.db, docId)),
    );

    const served = results.filter((r) => r.allowed);
    const denied = results.filter((r) => !r.allowed);
    expect(served.length).toBe(N); // EXACTLY 5 — never 6, never the limit exceeded
    expect(denied.length).toBe(TOTAL - N); // 15 surplus denied

    // The served counts are the distinct totals 1..5 (C-008: each open the same TOTAL).
    const counts = served
      .map((r) => (r.allowed ? r.viewCount : -1))
      .sort((a, b) => a - b);
    expect(counts).toEqual([1, 2, 3, 4, 5]);

    // Persisted truth: view_count parked at exactly the limit, never above (C-011).
    const [row] = await h.db.select().from(shareLinks);
    expect(row.viewCount).toBe(N);
  });

  test("C-008: an unlimited link (view_limit NULL) always allows and keeps counting TOTAL opens", async () => {
    const docId = await newDoc(h);
    await newShareLink(h, docId, null);

    const r1 = await tryConsumeView(h.db, docId);
    const r2 = await tryConsumeView(h.db, docId);
    const r3 = await tryConsumeView(h.db, docId);
    expect([r1.allowed, r2.allowed, r3.allowed]).toEqual([true, true, true]);
    expect(r3.allowed && r3.viewCount).toBe(3); // TOTAL opens, monotonic
  });

  test("C-001: setLinkControls applies a PARTIAL update — absent controls are untouched", async () => {
    const docId = await newDoc(h);
    const expiry = new Date("2030-01-01T00:00:00.000Z");
    // Seed all three controls.
    await setLinkControls(h.db, docId, {
      passwordHash: "$argon2id$seeded",
      expiresAt: expiry,
      viewLimit: 50,
    });
    // Update ONLY viewLimit — password + expiry keys absent.
    const persisted = await setLinkControls(h.db, docId, { viewLimit: 5 });
    expect(persisted.passwordSet).toBe(true); // STILL set
    expect(persisted.expiresAt?.toISOString()).toBe(expiry.toISOString()); // STILL set
    expect(persisted.viewLimit).toBe(5);

    // Clearing one control with null leaves the others intact.
    const cleared = await setLinkControls(h.db, docId, { passwordHash: null });
    expect(cleared.passwordSet).toBe(false); // CLEARED
    expect(cleared.expiresAt?.toISOString()).toBe(expiry.toISOString()); // untouched
    expect(cleared.viewLimit).toBe(5); // untouched
  });

  test("AS-033: setting a view limit resets the open count to 0 (fresh budget)", async () => {
    const docId = await newDoc(h);
    await newShareLink(h, docId, null);
    // Open it 3× so view_count = 3.
    await tryConsumeView(h.db, docId);
    await tryConsumeView(h.db, docId);
    await tryConsumeView(h.db, docId);
    const [before] = await h.db.select().from(shareLinks).where(eq(shareLinks.docId, docId));
    expect(before.viewCount).toBe(3);

    // Setting a limit resets the open count.
    const persisted = await setLinkControls(h.db, docId, { viewLimit: 20 });
    expect(persisted.viewLimit).toBe(20);
    expect(persisted.viewCount).toBe(0); // RESET
    const [after] = await h.db.select().from(shareLinks).where(eq(shareLinks.docId, docId));
    expect(after.viewCount).toBe(0);

    // Clearing the limit (null) does NOT reset the count again.
    await tryConsumeView(h.db, docId); // count → 1
    const clearedLimit = await setLinkControls(h.db, docId, { viewLimit: null });
    expect(clearedLimit.viewLimit).toBeNull();
    expect(clearedLimit.viewCount).toBe(1); // left as-is
  });
});
