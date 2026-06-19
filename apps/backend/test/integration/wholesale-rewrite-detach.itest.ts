// Integration tier (guarded by RUN_INTEGRATION): annotation-reanchor S-004 / C-007 — a WHOLESALE
// REWRITE detaches gracefully. When the author republishes a fully regenerated doc (the common LLM
// loop) and the sentences several annotations were anchored to are reworded PAST the 0.8 fuzzy
// threshold, every such annotation must:
//   • be marked detached (is_orphaned) — the current-version projection the UI reads;
//   • appear in the detached list with a count — NONE silently lost (C-007);
//   • NOT be anchored onto unrelated text — even when its words coincidentally reappear elsewhere
//     (no mis-anchor — the precision-over-recall guarantee, C-003);
//   • remain re-attachable or dismissable (annotation-core:S-008 / C-013).
//
// This story is mostly the SUM of behaviour already built (S-001's hint→whole-doc ladder detaches
// below 0.8; S-003 records the orphaned resolution; S-008's dismiss/re-attach). The value here is a
// FAITHFUL end-to-end proof of graceful detach driven through the REAL re-anchor JOB + a REAL
// Postgres — falsifiable: it would catch a silent drop (annotation vanishes from the list) OR a
// mis-anchor (annotation carried onto the coincidental occurrence) if either were introduced.
//
// It deliberately does NOT assert that a rewrite RE-ANCHORS — GAP-001 is the spec's explicit honest
// limitation that wholesale rewrite DETACHES. The assertion is graceful detach, not magic re-anchor.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { createDocRepo } from "../../src/publish/repo";
import { appendVersion } from "../../src/services/version";
import { createVersionRepo } from "../../src/services/version-repo";
import { annotations, docVersions } from "../../src/db/schema";
import { buildAnchor, createAnnotation } from "../../src/annotation/annotation";
import { runReanchorForNewVersion } from "../../src/annotation/reanchor-job";
import {
  dismissAnnotation,
  reattachAnnotation,
} from "../../src/annotation/dismiss-reattach";
import {
  createAnnotationRepo,
  createReanchorApplyRepo,
  createAnchorResolutionRepo,
  createDismissReattachRepo,
} from "../../src/annotation/repo";
import { reanchorAnnotation } from "../../src/annotation/reanchor";
import { withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;

let docSeq = 0;
async function newDoc(h: MigratedDb, content: string): Promise<string> {
  const slug = `wr-itest-${process.pid}-${++docSeq}`;
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

/** Run the real re-anchor job for a (doc, version) — applies is_orphaned + persists resolution. */
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

/**
 * Read the doc's ACTIVE annotation list the way annotation-core:S-008 does (excludes
 * soft-deleted + dismissed). The DETACHED list is the subset with is_orphaned === true:
 * a detached annotation stays in the active read (carrying is_orphaned) until it is dismissed
 * or re-attached — that is the surface the reviewer dismisses/re-attaches from.
 */
async function activeList(h: MigratedDb, docId: string) {
  return createAnnotationRepo(h.db).listByDoc(docId);
}

describe.skipIf(!RUN)("wholesale rewrite detaches gracefully (S-004 / C-007)", () => {
  let h: MigratedDb;

  beforeAll(async () => {
    h = await withMigratedDb();
  }, 60_000);
  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  });

  test("AS-010: a wholesale-regenerated version detaches its reworded annotations into the detached list — none lost, none mis-anchored, all re-attach/dismissable", async () => {
    // v1: four distinct prose blocks, one annotation on each. The anchored sentences are the kind
    // an LLM regen would reword wholesale.
    const v1 =
      '<p id="p1">The refund is processed within twenty-four hours of the request.</p>' +
      '<p id="p2">Customers may dispute a charge through the standard appeals workflow.</p>' +
      '<p id="p3">All capture events are written to the immutable ledger table.</p>' +
      '<p id="p4">The webhook retries five times with exponential backoff before failing.</p>';
    const docId = await newDoc(h, v1);

    // Anchor each annotation to (most of) its block sentence — the durable key is this text.
    const a1 = await annotate(h, docId, {
      blockId: "p1",
      text: "The refund is processed within twenty-four hours of the request.",
      offset: 0,
      length: 64,
    });
    const a2 = await annotate(h, docId, {
      blockId: "p2",
      text: "Customers may dispute a charge through the standard appeals workflow.",
      offset: 0,
      length: 69,
    });
    const a3 = await annotate(h, docId, {
      blockId: "p3",
      text: "All capture events are written to the immutable ledger table.",
      offset: 0,
      length: 61,
    });
    const a4 = await annotate(h, docId, {
      blockId: "p4",
      text: "The webhook retries five times with exponential backoff before failing.",
      offset: 0,
      length: 71,
    });
    const allIds = [a1, a2, a3, a4];

    // v2: a WHOLESALE regeneration. Every anchored sentence is reworded so heavily that no candidate
    // clears the 0.8 fuzzy threshold. The block ids are also renumbered (regen emits fresh markup),
    // so the hint path misses and the whole-doc fallback runs — and still finds nothing above bar.
    //
    // NO-MIS-ANCHOR trap: p3's annotation anchored the sentence containing "ledger table"; v2's last
    // block coincidentally still contains the words "ledger" and "table" embedded in a totally
    // different sentence. The matcher must NOT carry a3 onto that coincidental mention (precision —
    // C-003): the full reworded sentence is far below the snippet's similarity bar.
    const v2 =
      '<p id="q1">Reimbursements complete in roughly a single business day after approval.</p>' +
      '<p id="q2">A shopper can contest billing by opening a case with our support desk.</p>' +
      '<p id="q3">Settlement records persist permanently and cannot be edited once stored.</p>' +
      '<p id="q4">Failed deliveries are re-sent on a growing delay until they give up entirely.</p>' +
      '<p id="q5">See the ledger overview and the rate table in the appendix for details.</p>';
    await appendVersion(docId, v2, "hash-v2", createVersionRepo(h.db));
    const v2Id = await versionId(h, docId, 2);

    const summary = await runJob(h, docId, v2Id, v2);

    // The whole rewrite detached: 4 considered, 0 carried, 4 detached — and the >25% alert fires.
    expect(summary.total).toBe(4);
    expect(summary.carried).toBe(0);
    expect(summary.detached).toBe(4);
    expect(summary.alert).toBe(true);

    // NONE silently lost (C-007): all four annotations are still present (not hard-deleted), kept in
    // the active read, and EVERY one is flagged detached (is_orphaned) — the current-version
    // projection the UI's detached list reads.
    const list = await activeList(h, docId);
    const byId = new Map(list.map((r) => [r.id, r]));
    for (const id of allIds) {
      const row = byId.get(id);
      expect(row).toBeDefined();
      expect(row!.isOrphaned).toBe(true);
    }

    // The detached list = the orphaned subset, with a count of all four. None carried.
    const detached = list.filter((r) => r.isOrphaned);
    expect(detached.length).toBe(4);
    expect(new Set(detached.map((r) => r.id))).toEqual(new Set(allIds));

    // NO MIS-ANCHOR (C-003): a3's anchor must NOT have been rewritten onto the coincidental q5
    // "ledger ... table" mention — a detached annotation keeps its ORIGINAL anchor untouched. Re-run
    // the pure matcher to assert the verdict directly: it orphans, never carries onto q5.
    const a3Anchor = byId.get(a3)!.anchor;
    expect(a3Anchor.blockId).toBe("p3"); // original, not the new q5 block
    expect(a3Anchor.textSnippet).toContain("immutable ledger table"); // original snippet preserved
    const a3Verdict = reanchorAnnotation(a3Anchor, v2);
    expect(a3Verdict.status).toBe("orphaned");

    // C-007 — the reviewer can DISMISS one detached annotation: it leaves the active list but is
    // KEPT (not hard-deleted) — still a real row.
    const dismissRes = await dismissAnnotation(
      { annotationId: a1, sessionRole: "commenter" },
      createDismissReattachRepo(h.db),
    );
    expect(dismissRes).toEqual({ ok: true });
    const afterDismiss = await activeList(h, docId);
    expect(afterDismiss.find((r) => r.id === a1)).toBeUndefined(); // gone from the active list…
    const a1Row = await h.db
      .select({ id: annotations.id, dismissedAt: annotations.dismissedAt })
      .from(annotations)
      .where(eq(annotations.id, a1));
    expect(a1Row.length).toBe(1); // …but the row is KEPT (C-007 — never silently dropped)
    expect(a1Row[0].dismissedAt).not.toBeNull();

    // C-007 — the reviewer can RE-ATTACH another detached annotation onto a range in the CURRENT
    // version: clears is_orphaned and returns it as an anchored annotation.
    const freshAnchor = buildAnchor({
      blockId: "q2",
      text: "A shopper can contest billing",
      offset: 0,
      length: 29,
    })!;
    const reattachRes = await reattachAnnotation(
      { annotationId: a2, anchor: freshAnchor, sessionRole: "commenter" },
      (anchor) => reanchorAnnotation(anchor, v2).status === "carried",
      createDismissReattachRepo(h.db),
    );
    expect(reattachRes).toEqual({ ok: true });
    const afterReattach = await activeList(h, docId);
    const a2Row = afterReattach.find((r) => r.id === a2);
    expect(a2Row).toBeDefined();
    expect(a2Row!.isOrphaned).toBe(false); // re-attached → no longer detached
    expect(a2Row!.anchor.blockId).toBe("q2"); // anchored at the fresh, current-version range

    // a3 + a4 remain detached and available (neither dismissed nor re-attached) — still in the list.
    const stillDetached = afterReattach.filter((r) => r.isOrphaned).map((r) => r.id);
    expect(new Set(stillDetached)).toEqual(new Set([a3, a4]));
  }, 60_000);
});
