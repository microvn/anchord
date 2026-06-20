import { test, expect } from "bun:test";
import {
  runReanchorForNewVersion,
  DETACHED_ALERT_THRESHOLD,
  type ReanchorAnnotationReader,
  type ReanchorApplyRepo,
  type ReanchorJobLedger,
  type ReanchorSummary,
} from "./reanchor-job";
import type { Anchor } from "./annotation";
import type { ReanchorLedgerEntry } from "./reanchor";

// annotation-core S-005 / C-012 — the re-anchor JOB (the integration glue around the pure
// matcher reanchorForVersion). The matcher behaviour (AS-011/012/013/018, C-002) is covered
// in reanchor.test.ts. THESE tests cover C-012's integration half: apply carried/detached to
// the annotations table, persist the (annotation_id, version_id) ledger, idempotent re-run,
// and the per-publish summary + >25%-detached alert. Pure ports, no DB.

const doc = (paras: string[]) => paras.map((p) => `<p>${p}</p>`).join("");
const SEVEN = [
  "intro one",
  "intro two",
  "intro three",
  "intro four",
  "intro five",
  "intro six",
  "Payment expires after 24h",
];

/** A fake annotation reader. `type` defaults to "range"; pass "suggestion" to exercise the filter.
 *  `deletedAt` defaults to null; pass a Date to exercise the S-005/C-007 soft-delete exclusion. */
function reader(rows: { id: string; anchor: Anchor; type?: string; deletedAt?: Date | null }[]): ReanchorAnnotationReader {
  return { async listByDoc() { return rows.map((r) => ({ id: r.id, anchor: r.anchor, type: r.type ?? "range", deletedAt: r.deletedAt ?? null })); } };
}

/** A fake apply repo that records what was carried / detached. */
function applyRepo() {
  const carried: { id: string; anchor: Anchor }[] = [];
  const detached: string[] = [];
  const repo: ReanchorApplyRepo = {
    async applyCarried(id, anchor) { carried.push({ id, anchor }); },
    async markDetached(id) { detached.push(id); },
  };
  return { repo, carried, detached };
}

/** A fake ledger backed by a Map — mirrors the real DrizzleReanchorLedgerRepo contract. */
function ledger() {
  const store = new Map<string, ReanchorLedgerEntry>();
  const key = (a: string, v: string) => `${a}::${v}`;
  const persisted: ReanchorLedgerEntry[] = [];
  const repo: ReanchorJobLedger = {
    getEntry(a, v) { return store.get(key(a, v)); },
    async loadEntries() { /* cache already shared via `store` */ },
    async persistEntry(entry) {
      const k = key(entry.annotationId, entry.versionId);
      const existed = store.has(k);
      store.set(k, entry);
      if (!existed) persisted.push(entry);
      return !existed; // ON CONFLICT DO NOTHING semantics
    },
  };
  return { repo, store, persisted };
}

test("C-012: carried annotations get applyCarried(new anchor) + detached get markDetached", async () => {
  const carriedAnchor: Anchor = { blockId: "block-p-7", textSnippet: "expires after 24h", offset: 8, length: 17 };
  const lostAnchor: Anchor = { blockId: "block-p-99", textSnippet: "gone", offset: 0, length: 4 };
  const r = reader([{ id: "a1", anchor: carriedAnchor }, { id: "a2", anchor: lostAnchor }]);
  const apply = applyRepo();
  const led = ledger();

  const summary = await runReanchorForNewVersion(
    { annotations: r, apply: apply.repo, ledger: led.repo },
    { docId: "doc_1", versionId: "doc_1:2", content: doc(SEVEN), kind: "html" },
  );

  // a1 carried with a recomputed anchor; a2 detached (never lost).
  expect(apply.carried.map((c) => c.id)).toEqual(["a1"]);
  expect(apply.carried[0]?.anchor.blockId).toBe("block-p-7");
  expect(apply.detached).toEqual(["a2"]);
  // Ledger persisted one row per (annotation, version).
  expect(led.persisted).toHaveLength(2);
  expect(summary.total).toBe(2);
  expect(summary.carried).toBe(1);
  expect(summary.detached).toBe(1);
});

test("C-012: re-run for the same versionId is idempotent — no duplicate ledger rows", async () => {
  const r = reader([
    { id: "a1", anchor: { blockId: "block-p-7", textSnippet: "expires after 24h", offset: 8, length: 17 } },
    { id: "a2", anchor: { blockId: "block-p-99", textSnippet: "gone", offset: 0, length: 4 } },
  ]);
  const apply = applyRepo();
  const led = ledger();
  const input = { docId: "doc_1", versionId: "doc_1:2", content: doc(SEVEN), kind: "html" as const };

  const first = await runReanchorForNewVersion({ annotations: r, apply: apply.repo, ledger: led.repo }, input);
  const second = await runReanchorForNewVersion({ annotations: r, apply: apply.repo, ledger: led.repo }, input);

  // Same summary; ledger persisted exactly twice total (once per annotation), not four times.
  expect(second).toEqual(first);
  expect(led.persisted).toHaveLength(2);
});

test("C-012: detached rate over the threshold raises the alert; under does not", async () => {
  // 3 of 4 annotations orphan → 75% > 25% → alert.
  const carriedAnchor: Anchor = { blockId: "block-p-7", textSnippet: "expires after 24h", offset: 8, length: 17 };
  const lost = (n: number): Anchor => ({ blockId: `block-p-${90 + n}`, textSnippet: "gone", offset: 0, length: 4 });
  const high = reader([
    { id: "a1", anchor: carriedAnchor },
    { id: "a2", anchor: lost(1) },
    { id: "a3", anchor: lost(2) },
    { id: "a4", anchor: lost(3) },
  ]);
  const hi = await runReanchorForNewVersion(
    { annotations: high, apply: applyRepo().repo, ledger: ledger().repo },
    { docId: "doc_1", versionId: "doc_1:2", content: doc(SEVEN), kind: "html" },
  );
  expect(hi.detachedRate).toBeGreaterThan(DETACHED_ALERT_THRESHOLD);
  expect(hi.alert).toBe(true);

  // 1 of 4 orphans → 25%, NOT strictly over 25% → no alert.
  const low = reader([
    { id: "b1", anchor: carriedAnchor },
    { id: "b2", anchor: carriedAnchor },
    { id: "b3", anchor: carriedAnchor },
    { id: "b4", anchor: lost(1) },
  ]);
  const lo = await runReanchorForNewVersion(
    { annotations: low, apply: applyRepo().repo, ledger: ledger().repo },
    { docId: "doc_1", versionId: "doc_1:2", content: doc(SEVEN), kind: "html" },
  );
  expect(lo.detachedRate).toBeCloseTo(0.25, 5);
  expect(lo.alert).toBe(false);
});

test("C-012: the per-publish summary is reported via onSummary", async () => {
  const seen: ReanchorSummary[] = [];
  await runReanchorForNewVersion(
    {
      annotations: reader([{ id: "a1", anchor: { blockId: "block-p-7", textSnippet: "expires after 24h", offset: 8, length: 17 } }]),
      apply: applyRepo().repo,
      ledger: ledger().repo,
      onSummary: (s) => seen.push(s),
    },
    { docId: "doc_1", versionId: "doc_1:2", content: doc(SEVEN), kind: "html" },
  );
  expect(seen).toHaveLength(1);
  expect(seen[0]?.versionId).toBe("doc_1:2");
  expect(seen[0]?.carried).toBe(1);
});

test("C-012: suggestion-type annotations are excluded from re-anchor (separate C-011 lifecycle)", async () => {
  const apply = applyRepo();
  const summary = await runReanchorForNewVersion(
    {
      annotations: reader([
        { id: "a1", type: "range", anchor: { blockId: "block-p-7", textSnippet: "expires after 24h", offset: 8, length: 17 } },
        { id: "s1", type: "suggestion", anchor: { blockId: "block-p-7", textSnippet: "expires after 24h", offset: 8, length: 17 } },
      ]),
      apply: apply.repo,
      ledger: ledger().repo,
    },
    { docId: "doc_1", versionId: "doc_1:2", content: doc(SEVEN), kind: "html" },
  );
  // Only the range annotation is considered; the suggestion is untouched.
  expect(summary.total).toBe(1);
  expect(apply.carried.map((c) => c.id)).toEqual(["a1"]);
  expect(apply.detached).toEqual([]);
});

test("AS-014: a SOFT-DELETED annotation is excluded from re-anchor AND from the detached-rate denominator", async () => {
  // annotation-actions S-005 / C-007: a deleted annotation is terminal — it must NOT be
  // re-anchored onto the new version (never carried, never detached) and must NOT count in the
  // detached-rate metric (total). Here a1 carries; a2 would DETACH but is soft-deleted, so it is
  // skipped entirely → total=1, detached=0, rate=0 (NOT 1/2=50% which would wrongly alert).
  const carriedAnchor: Anchor = { blockId: "block-p-7", textSnippet: "expires after 24h", offset: 8, length: 17 };
  const lostAnchor: Anchor = { blockId: "block-p-99", textSnippet: "gone", offset: 0, length: 4 };
  const apply = applyRepo();
  const led = ledger();
  const summary = await runReanchorForNewVersion(
    {
      annotations: reader([
        { id: "a1", anchor: carriedAnchor },
        { id: "a2-deleted", anchor: lostAnchor, deletedAt: new Date("2026-06-16T00:00:00.000Z") },
      ]),
      apply: apply.repo,
      ledger: led.repo,
    },
    { docId: "doc_1", versionId: "doc_1:2", content: doc(SEVEN), kind: "html" },
  );
  // Only the live annotation is considered; the deleted one is never carried/detached/ledgered.
  expect(summary.total).toBe(1);
  expect(summary.carried).toBe(1);
  expect(summary.detached).toBe(0);
  expect(summary.detachedRate).toBe(0); // computed over ACTIVE rows only — the deleted one is gone.
  expect(summary.alert).toBe(false);
  expect(apply.carried.map((c) => c.id)).toEqual(["a1"]);
  expect(apply.detached).toEqual([]);
  expect(led.persisted.map((e) => e.annotationId)).toEqual(["a1"]); // no ledger row for the deleted one.
});

// Regression: re-anchor fed raw markdown — reanchor-job.ts orphaned every annotation on markdown docs
test("regression: a markdown doc's new version carries an unchanged-text annotation (render before re-anchor)", async () => {
  // A MARKDOWN doc's stored content is markdown SOURCE. block-ids (block-h1-1, …) only exist
  // after markdown→HTML render + injectBlockIds. If the job re-anchors against the RAW markdown,
  // extractAllBlocks finds no blocks → every annotation orphans, even byte-identical text. The
  // fix renders markdown→HTML inside the job before the matcher. Here the new version's content
  // is IDENTICAL markdown, so the heading annotation must be CARRIED (applyCarried), not detached.
  const content = "# Hello Heading\n\nbody paragraph.";
  // Anchor as computed against the RENDERED html: <h1 id="block-h1-1">Hello Heading</h1>.
  const anchor: Anchor = { blockId: "block-h1-1", textSnippet: "Hello Heading", offset: 0, length: 13 };
  const apply = applyRepo();
  const led = ledger();
  const summary = await runReanchorForNewVersion(
    { annotations: reader([{ id: "a1", anchor }]), apply: apply.repo, ledger: led.repo },
    { docId: "doc_md", versionId: "doc_md:2", content, kind: "markdown" },
  );
  // Unchanged text → carried onto block-h1-1, NOT orphaned.
  expect(apply.detached).toEqual([]);
  expect(apply.carried.map((c) => c.id)).toEqual(["a1"]);
  expect(apply.carried[0]?.anchor.blockId).toBe("block-h1-1");
  expect(summary.carried).toBe(1);
  expect(summary.detached).toBe(0);
});

// ===========================================================================
// mcp-patch-document:S-004 / C-004/C-005 — the JOB threads the patch's changed-block set into the
// pure matcher. The deterministic-carry behaviour itself is unit-tested in reanchor.test.ts; these
// prove the job wires `changedBlockIds` end-to-end (present → carry off-block; absent → full matcher).
// ===========================================================================

test("AS-019: job threads changedBlockIds → annotation on an untouched block carries (no matcher)", async () => {
  // The new content's block-p-5 text is REPLACED so a real matcher would orphan the annotation;
  // because block-p-5 is NOT in the patch's changed set, it must carry byte-identical (matcher skipped).
  const p5Anchor: Anchor = { blockId: "block-p-5", textSnippet: "intro five", offset: 0, length: 10 };
  const apply = applyRepo();
  const led = ledger();
  const newContent = doc(["a", "b", "c", "d", "XXXXXXXXXX", "f", "Payment expires after 24h"]);
  const summary = await runReanchorForNewVersion(
    { annotations: reader([{ id: "a-p5", anchor: p5Anchor }]), apply: apply.repo, ledger: led.repo },
    { docId: "doc_1", versionId: "doc_1:2", content: newContent, kind: "html", changedBlockIds: ["block-h2-1"] },
  );
  // Carried with the original anchor (matcher skipped), not detached.
  expect(apply.detached).toEqual([]);
  expect(apply.carried.map((c) => c.id)).toEqual(["a-p5"]);
  expect(apply.carried[0]!.anchor).toEqual(p5Anchor);
  expect(summary).toMatchObject({ total: 1, carried: 1, detached: 0 });
  expect(led.persisted.map((e) => e.status)).toEqual(["carried"]); // C-012: carried entry still ledgered.
});

test("AS-021: job with NO changedBlockIds runs the FULL matcher (whole-doc update — no regression)", async () => {
  // Identical setup to AS-019 but WITHOUT changedBlockIds → the whole-doc path. block-p-5's text
  // was replaced, so the full matcher orphans it (a deterministic carry would have kept it).
  const p5Anchor: Anchor = { blockId: "block-p-5", textSnippet: "intro five", offset: 0, length: 10 };
  const apply = applyRepo();
  const led = ledger();
  const newContent = doc(["a", "b", "c", "d", "XXXXXXXXXX", "f", "Payment expires after 24h"]);
  const summary = await runReanchorForNewVersion(
    { annotations: reader([{ id: "a-p5", anchor: p5Anchor }]), apply: apply.repo, ledger: led.repo },
    { docId: "doc_1", versionId: "doc_1:2", content: newContent, kind: "html" /* no changedBlockIds */ },
  );
  // Full matcher ran → orphaned (the deterministic-carry path was NOT taken).
  expect(apply.carried).toEqual([]);
  expect(apply.detached).toEqual(["a-p5"]);
  expect(summary).toMatchObject({ total: 1, carried: 0, detached: 1 });
});

test("C-012: edge — a doc with zero annotations does no work and never alerts", async () => {
  const apply = applyRepo();
  const led = ledger();
  const summary = await runReanchorForNewVersion(
    { annotations: reader([]), apply: apply.repo, ledger: led.repo },
    { docId: "doc_1", versionId: "doc_1:2", content: doc(SEVEN), kind: "html" },
  );
  expect(summary).toMatchObject({ total: 0, carried: 0, detached: 0, detachedRate: 0, alert: false });
  expect(apply.carried).toEqual([]);
  expect(apply.detached).toEqual([]);
  expect(led.persisted).toEqual([]);
});
