// Integration tier (guarded by RUN_INTEGRATION): annotation-reanchor S-003 / C-005 — the
// IMMUTABLE per-(annotation, version) resolution record on a REAL Postgres. The pure matcher
// (reanchorForVersion) and the in-memory ledger are unit-covered; what only real Postgres can
// prove is the PERSISTENCE + idempotency contract of the `anchor_resolution` table: exactly one
// row per (annotation, version) carrying status + method + confidence + the resolved span, and a
// re-run that reuses those rows unchanged (the UNIQUE(annotation_id, version_id) backstop +
// getEntry short-circuit). Driven through the real re-anchor JOB so it persists the production way.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDocRepo } from "../../src/publish/repo";
import { appendVersion } from "../../src/services/version";
import { createVersionRepo } from "../../src/services/version-repo";
import { anchorResolution, docVersions } from "../../src/db/schema";
import { buildAnchor, createAnnotation } from "../../src/annotation/annotation";
import { runReanchorForNewVersion } from "../../src/annotation/reanchor-job";
import {
  createAnnotationRepo,
  createReanchorApplyRepo,
  createAnchorResolutionRepo,
} from "../../src/annotation/repo";
import { withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;

let docSeq = 0;
async function newDoc(h: MigratedDb, content: string): Promise<string> {
  const slug = `ar-itest-${process.pid}-${++docSeq}`;
  const { id } = await createDocRepo(h.db).createDocWithV1({
    slug,
    title: `Doc ${slug}`,
    kind: "html",
    content,
    contentHash: `hash-${slug}`,
  });
  return id;
}

async function versionId(h: MigratedDb, docId: string, version: number): Promise<string> {
  const rows = await h.db
    .select({ id: docVersions.id, version: docVersions.version })
    .from(docVersions)
    .where(eq(docVersions.docId, docId));
  const match = rows.find((r) => r.version === version);
  if (!match) throw new Error(`no doc_versions row for doc ${docId} v${version}`);
  return match.id;
}

/** Create a range annotation at v1; return its id. */
async function annotate(
  h: MigratedDb,
  docId: string,
  spec: { blockId: string; text: string; offset: number; length: number },
): Promise<string> {
  const anchor = buildAnchor(spec)!;
  const created = await createAnnotation(
    { docId, anchor, viewer: { kind: "user", userId: "u1" }, sessionRole: "commenter" },
    createAnnotationRepo(h.db),
  );
  if (!created.created) throw new Error("annotation create failed");
  return created.id;
}

/** Run the real re-anchor job for a (doc, version) — persists into anchor_resolution. */
async function runJob(h: MigratedDb, docId: string, vId: string, newContentHtml: string) {
  return runReanchorForNewVersion(
    {
      annotations: createAnnotationRepo(h.db),
      apply: createReanchorApplyRepo(h.db),
      ledger: createAnchorResolutionRepo(h.db),
    },
    { docId, versionId: vId, newContentHtml },
  );
}

describe.skipIf(!RUN)("anchor_resolution — immutable per-version resolution (S-003 / C-005)", () => {
  let h: MigratedDb;

  beforeAll(async () => {
    h = await withMigratedDb();
  }, 60_000); // container boot + migrate can exceed the default 5s hook timeout
  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  });

  test("AS-008: one resolution row per (annotation, version) with status, method, confidence, span", async () => {
    // v1: three blocks, one annotation on each.
    const v1 =
      '<p id="b1">the quick brown fox</p>' +
      '<p id="b2">jumps over the lazy dog</p>' +
      '<p id="b3">pack my box with five jugs</p>';
    const docId = await newDoc(h, v1);
    const a1 = await annotate(h, docId, { blockId: "b1", text: "quick brown", offset: 4, length: 11 });
    const a2 = await annotate(h, docId, { blockId: "b2", text: "lazy dog", offset: 15, length: 8 });
    // a3's anchored text is DELETED in v2 → it must orphan (status orphaned, null span).
    const a3 = await annotate(h, docId, { blockId: "b3", text: "five jugs", offset: 17, length: 9 });

    // v2: b1 unchanged (carries exact), b2 unchanged (carries), b3's text gone (orphans).
    const v2 =
      '<p id="b1">the quick brown fox</p>' +
      '<p id="b2">jumps over the lazy dog</p>' +
      '<p id="b3">totally different content now</p>';
    await appendVersion(docId, v2, "hash-v2", createVersionRepo(h.db));
    const v2Id = await versionId(h, docId, 2);

    const summary = await runJob(h, docId, v2Id, v2);
    expect(summary.total).toBe(3);

    // EXACTLY one row per (annotation, version): 3 annotations → 3 rows for v2.
    const rows = await h.db
      .select({
        annotationId: anchorResolution.annotationId,
        versionId: anchorResolution.versionId,
        status: anchorResolution.status,
        method: anchorResolution.method,
        confidence: anchorResolution.confidence,
        blockId: anchorResolution.blockId,
        offset: anchorResolution.offset,
        length: anchorResolution.length,
      })
      .from(anchorResolution)
      .where(eq(anchorResolution.versionId, v2Id));
    expect(rows.length).toBe(3);
    // Every row keys this version, and the (annotation, version) pairs are unique.
    expect(new Set(rows.map((r) => r.annotationId)).size).toBe(3);
    expect(rows.every((r) => r.versionId === v2Id)).toBe(true);

    const byAnn = new Map(rows.map((r) => [r.annotationId, r]));

    // a1 / a2 ANCHORED: status anchored, a winning method, confidence in (0,1], a resolved span.
    for (const id of [a1, a2]) {
      const r = byAnn.get(id)!;
      expect(r.status).toBe("anchored");
      expect(["blockid", "exact", "nearest", "normalized", "fuzzy"]).toContain(r.method!);
      expect(r.confidence).toBeGreaterThan(0);
      expect(r.confidence!).toBeLessThanOrEqual(1);
      expect(r.blockId).not.toBeNull(); // resolved span recorded when anchored
      expect(r.offset).not.toBeNull();
      expect(r.length).not.toBeNull();
    }
    // an unchanged block carries via the exact tier.
    expect(byAnn.get(a1)!.method).toBe("exact");
    expect(byAnn.get(a1)!.confidence).toBe(1);

    // a3 ORPHANED: status orphaned, no method / confidence / span.
    const r3 = byAnn.get(a3)!;
    expect(r3.status).toBe("orphaned");
    expect(r3.method).toBeNull();
    expect(r3.confidence).toBeNull();
    expect(r3.blockId).toBeNull();
    expect(r3.offset).toBeNull();
    expect(r3.length).toBeNull();
  });

  test("AS-009: re-running re-anchor for the same version reuses rows unchanged (idempotent)", async () => {
    const v1 = '<p id="b1">the quick brown fox</p><p id="b2">jumps over the lazy dog</p>';
    const docId = await newDoc(h, v1);
    await annotate(h, docId, { blockId: "b1", text: "quick brown", offset: 4, length: 11 });
    await annotate(h, docId, { blockId: "b2", text: "lazy dog", offset: 15, length: 8 });

    const v2 = '<p id="b1">the quick brown fox runs</p><p id="b2">jumps over the lazy dog</p>';
    await appendVersion(docId, v2, "hash-v2", createVersionRepo(h.db));
    const v2Id = await versionId(h, docId, 2);

    // First run persists the rows.
    await runJob(h, docId, v2Id, v2);
    const first = await h.db
      .select({
        id: anchorResolution.id,
        annotationId: anchorResolution.annotationId,
        status: anchorResolution.status,
        method: anchorResolution.method,
        confidence: anchorResolution.confidence,
        blockId: anchorResolution.blockId,
        offset: anchorResolution.offset,
        length: anchorResolution.length,
        resolvedAt: anchorResolution.resolvedAt,
      })
      .from(anchorResolution)
      .where(eq(anchorResolution.versionId, v2Id));
    expect(first.length).toBe(2);

    // Second run for the SAME version — must not add, rewrite, or re-apply any row.
    await runJob(h, docId, v2Id, v2);
    const second = await h.db
      .select({
        id: anchorResolution.id,
        annotationId: anchorResolution.annotationId,
        status: anchorResolution.status,
        method: anchorResolution.method,
        confidence: anchorResolution.confidence,
        blockId: anchorResolution.blockId,
        offset: anchorResolution.offset,
        length: anchorResolution.length,
        resolvedAt: anchorResolution.resolvedAt,
      })
      .from(anchorResolution)
      .where(eq(anchorResolution.versionId, v2Id));

    // Still exactly two rows — no second set written.
    expect(second.length).toBe(2);
    // Row identity + every value is byte-stable across the re-run (same id, same resolved_at, …).
    const norm = (rs: typeof first) =>
      rs
        .map((r) => ({ ...r, resolvedAt: r.resolvedAt.getTime() }))
        .sort((x, y) => x.id.localeCompare(y.id));
    expect(norm(second)).toEqual(norm(first));
  });

  test("C-005: a duplicate persist for the same (annotation, version) is a no-op, never double-written", async () => {
    const v1 = '<p id="b1">the quick brown fox</p>';
    const docId = await newDoc(h, v1);
    const a1 = await annotate(h, docId, { blockId: "b1", text: "quick brown", offset: 4, length: 11 });

    const v2 = '<p id="b1">the quick brown fox jumps</p>';
    await appendVersion(docId, v2, "hash-v2", createVersionRepo(h.db));
    const v2Id = await versionId(h, docId, 2);

    // Persist the SAME entry twice directly through the repo — the UNIQUE backstop guards C-005.
    const repo = createAnchorResolutionRepo(h.db);
    const entry = {
      annotationId: a1,
      versionId: v2Id,
      status: "carried" as const,
      anchor: { blockId: "b1", textSnippet: "quick brown", offset: 4, length: 11 },
      method: "exact" as const,
      confidence: 1,
    };
    expect(await repo.persistEntry(entry)).toBe(true); // first → real insert
    expect(await repo.persistEntry(entry)).toBe(false); // second → ON CONFLICT DO NOTHING

    const rows = await h.db
      .select({ id: anchorResolution.id })
      .from(anchorResolution)
      .where(eq(anchorResolution.annotationId, a1));
    expect(rows.length).toBe(1); // one immutable row; no double-apply
  });
});
