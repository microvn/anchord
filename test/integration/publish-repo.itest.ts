// Integration tier (guarded by RUN_INTEGRATION): the Drizzle-backed DocRepo's
// createDocWithV1 against a REAL Postgres. Proves the doc + its version-1 row land
// in ONE transaction and are readable, and that the unique(doc_id, version) index
// actually rejects a duplicate version-1 insert (render-publish C-004 persistence).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { docVersions, docs } from "../../src/db/schema";
import { createDocRepo } from "../../src/publish/repo";
import { withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;

describe.skipIf(!RUN)("publish repo (real Postgres)", () => {
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

  test("createDocWithV1 inserts doc + version-1 in one tx; both rows are readable", async () => {
    const slug = `publish-itest-${process.pid}-1`;
    const { id } = await createDocRepo(h.db).createDocWithV1({
      slug,
      title: "Hello",
      kind: "html",
      content: "<h1>hi</h1>",
      contentHash: "h1-hash",
    });

    const docRows = await h.db.select().from(docs).where(eq(docs.id, id));
    expect(docRows).toHaveLength(1);
    expect(docRows[0]?.slug).toBe(slug);
    expect(docRows[0]?.kind).toBe("html");

    const verRows = await h.db.select().from(docVersions).where(eq(docVersions.docId, id));
    expect(verRows).toHaveLength(1);
    expect(verRows[0]?.version).toBe(1);
    expect(verRows[0]?.content).toBe("<h1>hi</h1>");
    expect(verRows[0]?.contentHash).toBe("h1-hash");
  });

  test("unique(doc_id, version) rejects a duplicate version-1 insert", async () => {
    const slug = `publish-itest-${process.pid}-2`;
    const { id } = await createDocRepo(h.db).createDocWithV1({
      slug,
      title: "Dup",
      kind: "markdown",
      content: "# dup",
      contentHash: "dup-hash",
    });

    // A second version-1 for the same doc must violate doc_version_uq.
    let threw = false;
    try {
      await h.db.insert(docVersions).values({
        docId: id,
        version: 1,
        content: "# dup again",
        contentHash: "dup-hash-2",
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // The original version-1 row is untouched by the failed insert.
    const verRows = await h.db.select().from(docVersions).where(eq(docVersions.docId, id));
    expect(verRows).toHaveLength(1);
    expect(verRows[0]?.content).toBe("# dup");
  });
});
