// Integration tier (RUN_INTEGRATION): annotation-core C-017 / mcp-roundtrip AS-008 — the
// (updated_at, id) changed-since query on a REAL Postgres. The unit suite proves the bump
// CALLS and the cursor math against fakes; what only real Postgres can prove is the
// LEXICOGRAPHIC tie-break: two rows sharing an updated_at are split by snowflake id, so a
// watermark sitting between them returns the second WITHOUT repeating the first. Faking the
// same-timestamp order would be circular — it is asserted live here.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDocRepo } from "../../src/publish/repo";
import { annotations } from "../../src/db/schema";
import { createMcpPullPorts } from "../../src/mcp/tools/pull-tools-wiring";
import type { PullCursor } from "../../src/mcp/tools/pull-tools";
import { withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;

let docSeq = 0;
async function newDoc(h: MigratedDb): Promise<string> {
  const slug = `cs-itest-${process.pid}-${++docSeq}`;
  const { id } = await createDocRepo(h.db).createDocWithV1({
    slug,
    title: `Doc ${slug}`,
    kind: "html",
    content: "<p>body</p>",
    contentHash: `hash-${slug}`,
  });
  return id;
}

/** Insert an annotation with an EXPLICIT updated_at + id, so we control the watermark order. */
async function seedAnnotation(
  h: MigratedDb,
  docId: string,
  id: string,
  updatedAtMillis: number,
): Promise<void> {
  await h.db
    .insert(annotations)
    .values({
      id,
      docId,
      type: "range",
      anchor: { blockId: "b", textSnippet: "x", offset: 0, length: 1 },
    })
    .returning({ id: annotations.id });
  // Force updated_at to a known instant so the (updated_at, id) order is deterministic.
  await h.db
    .update(annotations)
    .set({ updatedAt: new Date(updatedAtMillis) })
    .where(eq(annotations.id, id));
}

describe.skipIf(!RUN)("changed-since (updated_at, id) on real Postgres (C-017 / AS-008)", () => {
  let h: MigratedDb;
  // resolveAccess stub — these tests exercise the changed-since SQL, not authz.
  const ports = () =>
    createMcpPullPorts({ db: h.db, resolveAccess: async () => ({ role: "owner" }) as never });

  beforeAll(async () => {
    h = await withMigratedDb();
  });
  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  });

  test("AS-008: a cursor returns ONLY rows strictly after (updated_at, id), changed-since included", async () => {
    const docId = await newDoc(h);
    // ids chosen so string-order is a1 < a2 < a3 < a4.
    await seedAnnotation(h, docId, "a1_old", 1000);
    await seedAnnotation(h, docId, "a2_changed", 5000); // a since-changed row (later updated_at)
    await seedAnnotation(h, docId, "a3_new", 6000);

    // Watermark just before the changed rows: ts 1000 / a1_old.
    const cursor: PullCursor = { updatedAt: 1000, id: "a1_old" };
    const rows = await ports().listAllByDoc(docId, cursor);
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain("a1_old"); // already handled — not repeated
    expect(ids).toEqual(["a2_changed", "a3_new"]); // changed-since, in (updated_at,id) order
  });

  test("AS-008: SAME updated_at tie-break — two rows share a timestamp, the id splits them", async () => {
    const docId = await newDoc(h);
    const TS = 9000;
    // Three rows at the SAME updated_at; ids order tie_a < tie_b < tie_c.
    await seedAnnotation(h, docId, "tie_a", TS);
    await seedAnnotation(h, docId, "tie_b", TS);
    await seedAnnotation(h, docId, "tie_c", TS);

    // Watermark sits ON tie_a's (updated_at, id): the same-ts predicate must return tie_b + tie_c
    // (id strictly greater) and NOT repeat tie_a — the core monotonic guarantee.
    const cursor: PullCursor = { updatedAt: TS, id: "tie_a" };
    const rows = await ports().listAllByDoc(docId, cursor);
    expect(rows.map((r) => r.id)).toEqual(["tie_b", "tie_c"]);

    // Advancing onto tie_b returns only tie_c — no skip, no repeat across the shared timestamp.
    const next: PullCursor = { updatedAt: TS, id: "tie_b" };
    const rows2 = await ports().listAllByDoc(docId, next);
    expect(rows2.map((r) => r.id)).toEqual(["tie_c"]);

    // Advancing onto the last (tie_c) returns an empty changed-set (nothing strictly greater).
    const last: PullCursor = { updatedAt: TS, id: "tie_c" };
    const rows3 = await ports().listAllByDoc(docId, last);
    expect(rows3).toHaveLength(0);
  });

  test("C-017: a reply (comment insert) bumps the PARENT annotation's updated_at past a prior cursor", async () => {
    const docId = await newDoc(h);
    await seedAnnotation(h, docId, "p_ann", 1000);
    // Cursor at the annotation's current watermark — nothing changed yet.
    const cursor: PullCursor = { updatedAt: 1000, id: "p_ann" };
    expect(await ports().listAllByDoc(docId, cursor)).toHaveLength(0);

    // A comment arrives → the repo bumps p_ann.updated_at to now() (a real timestamp > 1000).
    const { createCommentRepo } = await import("../../src/annotation/repo");
    await createCommentRepo(h.db).insertComment({
      annotationId: "p_ann",
      parentId: null,
      authorId: null,
      guestName: "G",
      body: "a late reply on an old annotation",
    });

    // Now the same cursor surfaces p_ann — the reply made it changed-since (AS-008 reply path).
    const after = await ports().listAllByDoc(docId, cursor);
    expect(after.map((r) => r.id)).toEqual(["p_ann"]);
    // and its updated_at really advanced past the cursor.
    const [row] = await h.db
      .select({ updatedAt: annotations.updatedAt })
      .from(annotations)
      .where(eq(annotations.id, "p_ann"));
    expect(row!.updatedAt.getTime()).toBeGreaterThan(1000);
  });
});
