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
import { extractText } from "../render/extract-text";

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
  // S-005 / C-006: the searchable text the append/restore path now writes per version.
  extractedText?: string | null;
  createdAt: Date;
}

// In-memory fake: stores immutable version rows + a title per doc. Exposes ONLY
// the two reads the port needs (currentMax + insert) plus title state — there is
// deliberately NO "update a version" path (C-001).
function fakeRepo(seed: {
  docId: string;
  versions: { content: string; publishedBy?: string | null }[];
  title?: string;
  // S-002 / C-006: id→display-name table the listVersions LEFT JOIN resolves against.
  // An id absent here is "unresolved" (no user row) → publishedByName null.
  users?: Record<string, string>;
}) {
  const users = seed.users ?? {};
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
      // Return rows ascending on purpose: the service owns the display ordering (newest-first) and
      // must reorder these, so an ascending fake proves the reorder rather than passing it through.
      return rows
        .filter((r) => r.docId === docId)
        .sort((a, b) => a.version - b.version)
        .map((r) => ({
          version: r.version,
          createdAt: r.createdAt,
          publishedBy: r.publishedBy,
          // C-006: mirror the production LEFT JOIN — resolve id→name, null if unresolved.
          publishedByName: r.publishedBy ? (users[r.publishedBy] ?? null) : null,
        }));
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

// Regression: H-4 version-append bypassed the content size cap
// The 5MB MAX_TEXT_BYTES cap (validateSize) was only enforced in publishDoc, so every
// version-append surface (web POST .../versions, .../restore, MCP update/patch) could
// store an arbitrarily large version → OOM / Postgres bloat. The cap now lives at the
// append seam so all of them inherit it.
test("H-4: appending a version over MAX_TEXT_BYTES is rejected, not written", async () => {
  const { MAX_TEXT_BYTES, PublishRejected } = await import("../publish/sniff");
  const f = fakeRepo({ docId: "doc-1", versions: [{ content: "v1 body" }] });
  const huge = "a".repeat(MAX_TEXT_BYTES + 1); // one byte over the text cap

  await expect(
    appendVersion("doc-1", huge, sha(huge), f.repo, "u1", "markdown"),
  ).rejects.toBeInstanceOf(PublishRejected);

  // Nothing was written: still only the original v1 row.
  expect(f.rows).toHaveLength(1);
  expect(await f.repo.currentMaxVersion("doc-1")).toBe(1);
});

test("H-4: restoring still honors the cap path (oversize restore content rejected)", async () => {
  const { MAX_TEXT_BYTES, PublishRejected } = await import("../publish/sniff");
  // Seed a doc whose v1 content is already over the text cap (e.g. legacy row), then a
  // restore of it append-copies that content through appendVersion → must be rejected.
  const huge = "b".repeat(MAX_TEXT_BYTES + 1);
  const f = fakeRepo({ docId: "doc-2", versions: [{ content: huge }] });

  await expect(
    restoreVersion("doc-2", 1, f.repo, "u1", "markdown"),
  ).rejects.toBeInstanceOf(PublishRejected);

  // No new row appended.
  expect(f.rows).toHaveLength(1);
});

test("H-4: a version at exactly MAX_TEXT_BYTES is allowed (boundary, not over)", async () => {
  const { MAX_TEXT_BYTES } = await import("../publish/sniff");
  const f = fakeRepo({ docId: "doc-3", versions: [{ content: "v1" }] });
  const atCap = "c".repeat(MAX_TEXT_BYTES); // exactly the cap — allowed
  const res = await appendVersion("doc-3", atCap, sha(atCap), f.repo, "u1", "markdown");
  expect(res.version).toBe(2);
  expect(f.rows).toHaveLength(2);
});

// Story S-002: View version history. Read-only mapping over repo rows + a
// current-marker. listVersionHistory returns rows NEWEST-FIRST (descending by
// version, current first) — the versioning-diff-ui timeline contract; the service
// owns the ordering, so the fake repo's row order must not matter.

test("AS-003.T1: history returns all versions newest-first (descending by version)", async () => {
  // The fake repo returns rows ascending; the SERVICE must reorder them newest-first
  // (Regression: listVersionHistory preserved ascending → current rendered last in the panel).
  const f = fakeRepo({ docId: "doc-1", versions: [{ content: "a" }, { content: "b" }, { content: "c" }] });

  const history: VersionHistoryRow[] = await listVersionHistory("doc-1", f.repo);

  // All three versions present, newest (current) first.
  expect(history.map((r) => r.version)).toEqual([3, 2, 1]);
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
  // publishedBy is now the resolved publisher object { id, name } (S-002 / C-006),
  // not the raw id. The id is passed through truthfully (null for the unauthored row);
  // name resolution / fallback is asserted by the AS-011 / AS-012 tests below.
  // Newest-first: v3 (user-def) · v2 (null) · v1 (user-abc).
  expect(history.map((r) => r.publishedBy.id)).toEqual(["user-def", null, "user-abc"]);
});

test("AS-003.T3: current version (highest number) clearly marked, exactly one row", async () => {
  const f = fakeRepo({ docId: "doc-1", versions: [{ content: "a" }, { content: "b" }, { content: "c" }] });

  const history = await listVersionHistory("doc-1", f.repo);

  // Exactly one row marked current, and it is the max version (3).
  const current = history.filter((r) => r.isCurrent);
  expect(current).toHaveLength(1);
  expect(current[0].version).toBe(3);
  // All others are explicitly not current (newest-first order).
  expect(history.filter((r) => !r.isCurrent).map((r) => r.version)).toEqual([2, 1]);
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

// Story S-002 (publisher resolution): each history entry exposes the publisher's
// RESOLVED display name via `publishedBy.{id,name}`, with a fallback label when the
// author is unknown/unresolved — never an opaque author id alone, never a blank name.

test("AS-011: history entry shows the publisher's resolved display name (id → name)", async () => {
  // v3 published by Mara's id; her user row resolves to "Mara Lindqvist".
  const f = fakeRepo({
    docId: "doc-1",
    versions: [
      { content: "a", publishedBy: "user-1" },
      { content: "b", publishedBy: "user-1" },
      { content: "c", publishedBy: "mara-id" }, // v3 = Mara
    ],
    users: { "mara-id": "Mara Lindqvist", "user-1": "Someone Else" },
  });

  const history = await listVersionHistory("doc-1", f.repo);
  const v3 = history.find((r) => r.version === 3)!;

  // The resolved display name, not the opaque id.
  expect(v3.publishedBy.name).toBe("Mara Lindqvist");
  expect(v3.publishedBy.id).toBe("mara-id");
  expect(v3.publishedBy.name).not.toBe(v3.publishedBy.id); // never the raw id as the name
});

test("AS-012: a version with an unknown author shows a fallback label, never blank or raw id", async () => {
  const f = fakeRepo({
    docId: "doc-1",
    versions: [
      { content: "a" }, // no recorded author → id null
      { content: "b", publishedBy: "ghost-id" }, // author id present but no user row resolves
    ],
    users: { /* ghost-id deliberately absent → unresolved */ },
  });

  const history = await listVersionHistory("doc-1", f.repo);
  // Newest-first: v2 (unresolved ghost author) comes before v1 (no recorded author).
  const [unresolved, noAuthor] = history;

  // No recorded author: fallback label, id stays null (truthful), name not blank.
  expect(noAuthor.publishedBy.id).toBeNull();
  expect(noAuthor.publishedBy.name).toBe("Unknown");

  // Author id present but doesn't resolve: fallback label, NOT the raw id.
  expect(unresolved.publishedBy.id).toBe("ghost-id");
  expect(unresolved.publishedBy.name).toBe("Unknown");
  expect(unresolved.publishedBy.name).not.toBe("ghost-id");

  // Never blank.
  for (const row of history) {
    expect(row.publishedBy.name.length).toBeGreaterThan(0);
  }
});

test("C-006 (versioning-diff): publisher resolved name carried on every entry + fallback when unknown", async () => {
  // Mixed: resolved, no-author, and unresolved-author rows in one history.
  const f = fakeRepo({
    docId: "doc-1",
    versions: [
      { content: "a", publishedBy: "mara-id" }, // resolves
      { content: "b" }, // no author
      { content: "c", publishedBy: "ghost-id" }, // unresolved
    ],
    users: { "mara-id": "Mara Lindqvist" },
  });

  const history = await listVersionHistory("doc-1", f.repo);

  // Every entry carries a non-blank resolved publisher name; the raw id is never the name alone.
  for (const row of history) {
    expect(typeof row.publishedBy.name).toBe("string");
    expect(row.publishedBy.name.length).toBeGreaterThan(0);
    if (row.publishedBy.id) {
      // when there IS an id, the name is either the resolved name or the fallback — never the id.
      expect(row.publishedBy.name).not.toBe(row.publishedBy.id);
    }
  }
  // Newest-first: v3 (unresolved) · v2 (no author) · v1 (resolved).
  expect(history.map((r) => r.publishedBy.name)).toEqual([
    "Unknown", // v3 unresolved author
    "Unknown", // v2 no author
    "Mara Lindqvist", // v1 resolved
  ]);
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

// workspace-project S-005 / C-006: every version that can BECOME current must carry
// extracted_text so the search index (current-version content source) keeps matching
// past v1. The publish path already does this for v1; these assert append + restore
// thread extractText(content, kind) onto the NEW version row the same way.

test("C-006: appendVersion writes extracted_text = extractText(content, kind) on the new row", async () => {
  const f = fakeRepo({ docId: "doc-1", versions: [{ content: "# v1 alpha" }] });

  await appendVersion("doc-1", "# v2 bravo body", sha("# v2 bravo body"), f.repo, null, "markdown");

  const appended = f.rows.find((r) => r.version === 2)!;
  // The appended (now current) version carries the SAME extracted text publish would
  // compute — so content search covers the new current content, not just v1.
  expect(appended.extractedText).toBe(extractText("# v2 bravo body", "markdown"));
  expect(appended.extractedText).toContain("bravo");
  // v1 row is untouched (no extracted_text retro-written, no mutation).
  expect(f.rows.find((r) => r.version === 1)!.content).toBe("# v1 alpha");
});

test("C-006: restoreVersion carries the RESTORED content's extracted text on the new row", async () => {
  // doc at v2; restore v1 → v3 must carry v1's content extracted text (v1 is now current).
  const f = fakeRepo({
    docId: "doc-1",
    versions: [{ content: "# original charlie" }, { content: "# edited delta" }],
  });

  await restoreVersion("doc-1", 1, f.repo, null, "markdown");

  const restored = f.rows.find((r) => r.version === 3)!;
  expect(restored.content).toBe("# original charlie"); // append-copy of v1
  expect(restored.extractedText).toBe(extractText("# original charlie", "markdown"));
  expect(restored.extractedText).toContain("charlie");
});

test("C-006: image kind append stores the alt/filename text (no crash on a non-text body)", async () => {
  // image kind → extractText returns the alt/filename text the publish path stores as
  // content; an image append still gets that, never a crash.
  const f = fakeRepo({ docId: "img-doc", versions: [{ content: "diagram.png" }] });

  await appendVersion("img-doc", "updated-diagram.png", sha("updated-diagram.png"), f.repo, null, "image");

  const appended = f.rows.find((r) => r.version === 2)!;
  expect(appended.extractedText).toBe(extractText("updated-diagram.png", "image"));
  expect(appended.extractedText).toBe("updated-diagram.png");
});

test("C-006: no kind context (seed/legacy append) leaves extracted_text null — mirrors publish null handling", async () => {
  const f = fakeRepo({ docId: "doc-1", versions: [{ content: "x" }] });

  // kind omitted → no extraction attempted; the column stays null (no crash on empty kind).
  await appendVersion("doc-1", "", sha(""), f.repo, null);

  const appended = f.rows.find((r) => r.version === 2)!;
  expect(appended.extractedText).toBeNull();
});
