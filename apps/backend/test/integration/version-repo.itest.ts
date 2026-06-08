// Integration tier (guarded by RUN_INTEGRATION): the Drizzle-backed VersionRepo +
// appendVersionTx against a REAL Postgres. The headline case is CONCURRENT appends
// on one doc landing distinct, gap-free sequential version numbers — the multi-writer
// row-lock / MVCC correctness (versioning-diff C-002) the unit suite could only stub
// behind a fake repo. SQLite would serialize this; Postgres is the whole reason.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDocRepo } from "../../src/publish/repo";
import { appendVersion, listVersionHistory, restoreVersion } from "../../src/services/version";
import { appendVersionTx, createVersionRepo } from "../../src/services/version-repo";
import { withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;

let docSeq = 0;
/** Create a fresh doc (with version 1) via the real publish repo; return its id. */
async function newDoc(h: MigratedDb): Promise<string> {
  const slug = `itest-${process.pid}-${++docSeq}`;
  const { id } = await createDocRepo(h.db).createDocWithV1({
    slug,
    title: `Doc ${slug}`,
    kind: "markdown",
    content: "# v1",
    contentHash: "hash-v1",
  });
  return id;
}

describe.skipIf(!RUN)("version repo (real Postgres)", () => {
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

  test("sequential appendVersion yields 1,2,3… and listVersionHistory marks current", async () => {
    const docId = await newDoc(h); // already at v1
    const repo = createVersionRepo(h.db);

    const r2 = await appendVersion(docId, "# v2", "hash-v2", repo);
    const r3 = await appendVersion(docId, "# v3", "hash-v3", repo);
    expect(r2.version).toBe(2);
    expect(r2.previousVersion).toBe(1);
    expect(r3.version).toBe(3);
    expect(r3.previousVersion).toBe(2);

    const history = await listVersionHistory(docId, repo);
    expect(history.map((h) => h.version)).toEqual([1, 2, 3]);
    expect(history.filter((h) => h.isCurrent).map((h) => h.version)).toEqual([3]);
  });

  test("restoreVersion appends a copy of the target content as a new version", async () => {
    const docId = await newDoc(h); // v1 content "# v1"
    const repo = createVersionRepo(h.db);
    await appendVersion(docId, "# v2", "hash-v2", repo); // now at v2

    const restored = await restoreVersion(docId, 1, repo); // copy v1 forward
    expect(restored.version).toBe(3);

    const v3 = await repo.getVersion(docId, 3);
    expect(v3).toEqual({ content: "# v1", contentHash: "hash-v1" }); // verbatim copy of v1

    // History intact: nothing mutated/deleted (C-001 / C-004).
    const history = await listVersionHistory(docId, repo);
    expect(history.map((h) => h.version)).toEqual([1, 2, 3]);
  });

  test("CONCURRENT appendVersionTx → distinct gap-free version numbers (C-002 row lock)", async () => {
    const docId = await newDoc(h); // starts at v1
    const N = 12;

    // Fire N appends at once. Each tx does max()+1 under a row lock, so no two may
    // compute the same N+1. A correct DB yields exactly v2..v(N+1), all distinct.
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        appendVersionTx(h.db, docId, `# concurrent ${i}`, `hash-c-${i}`),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    // None should be lost. (If two raced to the same version, the unique(doc_id,version)
    // index rejects the loser — which would prove a bug, not pass it off as fine.)
    expect(rejected.length).toBe(0);
    expect(fulfilled.length).toBe(N);

    // The persisted truth, read straight from the table.
    const repo = createVersionRepo(h.db);
    const history = await listVersionHistory(docId, repo);
    const versions = history.map((h) => h.version).sort((a, b) => a - b);
    const expected = Array.from({ length: N + 1 }, (_, i) => i + 1); // 1..N+1
    expect(versions).toEqual(expected); // distinct, sequential, gap-free
    expect(new Set(versions).size).toBe(versions.length); // no duplicates
  });
});
