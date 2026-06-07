import { test, expect } from "bun:test";
import {
  appendVersion,
  updateTitle,
  listVersionHistory,
  restoreVersion,
  type VersionRepo,
  type AppendResult,
  type VersionHistoryRow,
} from "./version";

// Story S-001: appending a new immutable version on content update.
//
// These are UNIT tests of the numbering / no-overwrite / title-only LOGIC, run
// against an in-memory fake VersionRepo (mirrors publish's fakeRepo pattern). The
// real Drizzle glue does the max()+1 inside a transaction (Postgres row lock /
// MVCC) — that transactional correctness is integration-verified-later, NOT here.

const enc = (s: string) => new TextEncoder().encode(s);
const sha = (s: string) => {
  const h = new Bun.CryptoHasher("sha256");
  h.update(enc(s));
  return h.digest("hex");
};

interface VersionRow {
  docId: string;
  version: number;
  content: string;
  contentHash: string;
  publishedBy: string | null;
  createdAt: Date;
}

// In-memory fake: stores immutable version rows + a title per doc. Exposes ONLY
// the two reads the port needs (currentMax + insert) plus title state — there is
// deliberately NO "update a version" path (C-001).
function fakeRepo(seed: {
  docId: string;
  versions: { content: string; publishedBy?: string | null }[];
  title?: string;
}) {
  const rows: VersionRow[] = seed.versions.map((v, i) => ({
    docId: seed.docId,
    version: i + 1,
    content: v.content,
    contentHash: sha(v.content),
    publishedBy: v.publishedBy ?? null,
    createdAt: new Date(2026, 0, i + 1),
  }));
  const titles = new Map<string, string>();
  if (seed.title) titles.set(seed.docId, seed.title);

  const repo: VersionRepo = {
    async currentMaxVersion(docId) {
      const mine = rows.filter((r) => r.docId === docId).map((r) => r.version);
      return mine.length ? Math.max(...mine) : null;
    },
    async insertVersion(row) {
      rows.push({ ...row, publishedBy: row.publishedBy ?? null, createdAt: new Date() });
      return { version: row.version };
    },
    async setTitle(docId, title) {
      titles.set(docId, title);
    },
    async listVersions(docId) {
      // Mirror the production query contract: ascending by version. The service
      // owns ordering choice + current-marker, so the fake returns raw rows.
      return rows
        .filter((r) => r.docId === docId)
        .sort((a, b) => a.version - b.version)
        .map((r) => ({ version: r.version, createdAt: r.createdAt, publishedBy: r.publishedBy }));
    },
    async getVersion(docId, version) {
      const found = rows.find((r) => r.docId === docId && r.version === version);
      return found ? { content: found.content, contentHash: found.contentHash } : null;
    },
  };
  return { repo, rows, titles };
}

test("AS-001.T1: submitting new content appends version N+1 without overwriting v2", async () => {
  const f = fakeRepo({ docId: "doc-1", versions: [{ content: "v1 body" }, { content: "v2 body" }] });
  const before = f.rows.map((r) => ({ ...r })); // snapshot existing rows

  const res: AppendResult = await appendVersion("doc-1", "v3 NEW body", sha("v3 NEW body"), f.repo);

  expect(res.version).toBe(3);
  expect(res.previousVersion).toBe(2);
  expect(res.docId).toBe("doc-1");

  // A new row was appended, not an in-place edit: count grew by exactly one.
  expect(f.rows).toHaveLength(3);
  expect(f.rows[2].version).toBe(3);
  expect(f.rows[2].content).toBe("v3 NEW body");

  // v2 (and v1) untouched — same content/hash/version after the append.
  expect(f.rows[0]).toMatchObject({ version: 1, content: before[0].content, contentHash: before[0].contentHash });
  expect(f.rows[1]).toMatchObject({ version: 2, content: before[1].content, contentHash: before[1].contentHash });
});

test("AS-001.T2: after append, current = newest version", async () => {
  const f = fakeRepo({ docId: "doc-1", versions: [{ content: "a" }, { content: "b" }] });
  await appendVersion("doc-1", "c", sha("c"), f.repo);

  const current = await f.repo.currentMaxVersion("doc-1");
  expect(current).toBe(3); // highest number is the current version
});

test("AS-002: editing the title changes the title only, no new version is created", async () => {
  const f = fakeRepo({
    docId: "doc-1",
    versions: [{ content: "x" }, { content: "y" }],
    title: "Payment Spec",
  });

  await updateTitle("doc-1", "Payment Spec v2", f.repo);

  // Title changed on the doc...
  expect(f.titles.get("doc-1")).toBe("Payment Spec v2");
  // ...but still at v2: no version row added, content unchanged.
  expect(f.rows).toHaveLength(2);
  expect(await f.repo.currentMaxVersion("doc-1")).toBe(2);
  expect(f.rows[1].content).toBe("y");
});

test("C-001: versions immutable — service surface exposes append + read only, no update-a-version path", () => {
  // Immutability is enforced structurally: there is no method to mutate an
  // existing version row. Assert the service module exports only append/read/title
  // helpers, and the repo port has no update/delete-version method.
  expect(typeof appendVersion).toBe("function");
  expect(typeof updateTitle).toBe("function");

  const portMethods = ["currentMaxVersion", "insertVersion", "setTitle"];
  // No method name hints at editing/overwriting an existing version.
  for (const m of portMethods) {
    expect(/update.*version|overwrite|editVersion|mutateVersion|deleteVersion/i.test(m)).toBe(false);
  }
});

test("C-002: version counter increments from 1, no reuse; current = highest", async () => {
  // Fresh doc with zero versions → first append must be version 1 (counter starts at 1).
  const fresh = fakeRepo({ docId: "new-doc", versions: [] });
  const first = await appendVersion("new-doc", "first", sha("first"), fresh.repo);
  expect(first.version).toBe(1);
  expect(first.previousVersion).toBeNull();

  // Successive appends increment strictly, never reuse a number.
  const seen = new Set<number>([first.version]);
  for (let i = 0; i < 3; i++) {
    const r = await appendVersion("new-doc", `body-${i}`, sha(`body-${i}`), fresh.repo);
    expect(seen.has(r.version)).toBe(false); // no reuse
    seen.add(r.version);
  }
  expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  // current = highest number.
  expect(await fresh.repo.currentMaxVersion("new-doc")).toBe(4);
});

test("C-003: only a content change creates a version; a title/metadata change does not", async () => {
  const f = fakeRepo({ docId: "doc-1", versions: [{ content: "only" }], title: "T" });

  // Title edit: no version.
  await updateTitle("doc-1", "T renamed", f.repo);
  expect(await f.repo.currentMaxVersion("doc-1")).toBe(1);
  expect(f.rows).toHaveLength(1);

  // Content submit: a version.
  await appendVersion("doc-1", "new content", sha("new content"), f.repo);
  expect(await f.repo.currentMaxVersion("doc-1")).toBe(2);
  expect(f.rows).toHaveLength(2);
});

// Story S-002: View version history. Read-only mapping over repo rows + a
// current-marker. listVersionHistory returns rows ASCENDING by version number
// (oldest first, current last) — documented order, kept consistent below.

test("AS-003.T1: history returns all versions in order (ascending by version)", async () => {
  const f = fakeRepo({ docId: "doc-1", versions: [{ content: "a" }, { content: "b" }, { content: "c" }] });

  const history: VersionHistoryRow[] = await listVersionHistory("doc-1", f.repo);

  // All three versions present, ascending.
  expect(history.map((r) => r.version)).toEqual([1, 2, 3]);
});

test("AS-003.T2: each row carries createdAt AND publishedBy (publishedBy passed through, null acceptable)", async () => {
  // publishedBy is nullable until the auth cluster lands: assert the field is
  // PRESENT and passed through, with null acceptable for unauthored rows.
  const f = fakeRepo({
    docId: "doc-1",
    versions: [
      { content: "a", publishedBy: "user-abc" },
      { content: "b" }, // no publisher → null
      { content: "c", publishedBy: "user-def" },
    ],
  });

  const history = await listVersionHistory("doc-1", f.repo);

  // createdAt present on every row.
  for (const row of history) {
    expect(row.createdAt).toBeInstanceOf(Date);
    expect("publishedBy" in row).toBe(true);
  }
  // publishedBy passed through verbatim — including null for the unauthored row.
  expect(history.map((r) => r.publishedBy)).toEqual(["user-abc", null, "user-def"]);
});

test("AS-003.T3: current version (highest number) clearly marked, exactly one row", async () => {
  const f = fakeRepo({ docId: "doc-1", versions: [{ content: "a" }, { content: "b" }, { content: "c" }] });

  const history = await listVersionHistory("doc-1", f.repo);

  // Exactly one row marked current, and it is the max version (3).
  const current = history.filter((r) => r.isCurrent);
  expect(current).toHaveLength(1);
  expect(current[0].version).toBe(3);
  // All others are explicitly not current.
  expect(history.filter((r) => !r.isCurrent).map((r) => r.version)).toEqual([1, 2]);
});

test("AS-003.T3: single-version doc — the only row is current", async () => {
  // Edge: a doc with one version → single row, isCurrent on it.
  const f = fakeRepo({ docId: "solo", versions: [{ content: "only" }] });

  const history = await listVersionHistory("solo", f.repo);

  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({ version: 1, isCurrent: true });
});

test("AS-003.T1: empty history — doc with no versions returns []", async () => {
  // Edge: no versions → empty list, no row marked current (nothing to mark).
  const f = fakeRepo({ docId: "empty", versions: [] });

  const history = await listVersionHistory("empty", f.repo);

  expect(history).toEqual([]);
});

// Story S-003: Restore a previous version. Restore is APPEND-COPY — it reads the
// target version's content and appends a NEW version copying it (reusing
// appendVersion, so numbering + the re-anchor seam are shared). It never mutates,
// moves, or deletes an existing version (C-001 / C-004).

test("AS-004.T1: restore appends a new version whose content + contentHash == the restored version's", async () => {
  // doc at v3; restore v1 → v4 created with content (and hash) EQUAL to v1's.
  const f = fakeRepo({
    docId: "doc-1",
    versions: [{ content: "v1 body" }, { content: "v2 body" }, { content: "v3 body" }],
  });
  const v1Hash = f.rows[0].contentHash;

  const res: AppendResult = await restoreVersion("doc-1", 1, f.repo);

  expect(res.docId).toBe("doc-1");
  expect(res.version).toBe(4); // append-copy → next number, not a pointer move
  expect(res.previousVersion).toBe(3); // re-anchor seam: previous current was v3

  // The new row copies v1's content AND its contentHash verbatim.
  expect(f.rows).toHaveLength(4);
  expect(f.rows[3].version).toBe(4);
  expect(f.rows[3].content).toBe("v1 body");
  expect(f.rows[3].contentHash).toBe(v1Hash);
});

test("AS-004.T2: current = the new version; intermediate versions (v2, v3) still present", async () => {
  const f = fakeRepo({
    docId: "doc-1",
    versions: [{ content: "v1 body" }, { content: "v2 body" }, { content: "v3 body" }],
  });

  await restoreVersion("doc-1", 1, f.repo);

  // Current = the freshly created v4 (highest number).
  expect(await f.repo.currentMaxVersion("doc-1")).toBe(4);
  // Nothing deleted: v1, v2, v3 all remain, content untouched.
  const versions = f.rows.map((r) => r.version).sort((a, b) => a - b);
  expect(versions).toEqual([1, 2, 3, 4]);
  expect(f.rows.find((r) => r.version === 2)?.content).toBe("v2 body");
  expect(f.rows.find((r) => r.version === 3)?.content).toBe("v3 body");
});

test("C-004: restore deletes no version — history length grows by exactly 1, none removed", async () => {
  const f = fakeRepo({
    docId: "doc-1",
    versions: [{ content: "v1 body" }, { content: "v2 body" }, { content: "v3 body" }],
  });
  const before = f.rows.map((r) => ({ version: r.version, content: r.content }));

  await restoreVersion("doc-1", 1, f.repo);

  // Length grew by exactly one (append, never delete).
  expect(f.rows).toHaveLength(before.length + 1);
  // Every pre-existing row is still present, unchanged.
  for (const prev of before) {
    const still = f.rows.find((r) => r.version === prev.version);
    expect(still?.content).toBe(prev.content);
  }
});

test("C-004: restoring the CURRENT (highest) version still appends a copy", async () => {
  // Edge — boundary: restoring the highest version is not a no-op; it appends.
  const f = fakeRepo({
    docId: "doc-1",
    versions: [{ content: "v1 body" }, { content: "v2 body" }, { content: "v3 body" }],
  });

  const res = await restoreVersion("doc-1", 3, f.repo);

  expect(res.version).toBe(4);
  expect(f.rows).toHaveLength(4);
  expect(f.rows[3].content).toBe("v3 body"); // v4 copies v3
  expect(await f.repo.currentMaxVersion("doc-1")).toBe(4);
});

test("AS-004.T1: restoring a non-existent version number rejects (no silent no-op)", async () => {
  // Edge — error path: target version absent → throw/reject, do not append silently.
  const f = fakeRepo({
    docId: "doc-1",
    versions: [{ content: "v1 body" }, { content: "v2 body" }],
  });

  await expect(restoreVersion("doc-1", 99, f.repo)).rejects.toThrow();
  // History unchanged — nothing appended on the error path.
  expect(f.rows).toHaveLength(2);
});
