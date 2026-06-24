// Integration tier (guarded by RUN_INTEGRATION): your-activity-actions S-001 SEAM (AS-001) driven
// end-to-end against a REAL Postgres + the REAL producer emit (workspace-activity's emitActivity) —
// NEVER a mock (Linked-Field Seam Rule). This is the cross-spec contract between `workspace-activity`
// (the publish emit that must set actorUserId + a renderable version label in `meta`) and this spec
// (GET /api/me/activity reading that row back as the caller's own publish).
//
// Flow:
//   1. Seed a user + a workspace they're a CURRENT member of (seedWorkspace), and a doc/project there.
//   2. Fire the REAL emitActivity for a `publish` — actorUserId = the user, meta = { from, to, adds,
//      dels } (the renderable version label + diff counts). workspaceOfDoc resolves the doc's own
//      workspace, exactly as the prod publish path does.
//   3. Read it back through the REAL createActorActivityRepo.listForActor — assert the publish row
//      surfaces with its meta version label + add/remove counts (AS-001), workspaceName enriched.
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/me-activity-seam.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { docs, projects, user } from "../../src/db/schema";
import { emitActivity } from "../../src/activity/emit";
import { createActivityRepo } from "../../src/activity/repo";
import { createActorActivityRepo } from "../../src/activity/list-for-actor";
import { withMigratedDb, seedWorkspace, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;

describe.skipIf(!RUN)("your-activity-actions S-001 — Your-actions seam (real Postgres, real emit)", () => {
  let h: MigratedDb;
  const MARA = `u_yaa_mara_${process.pid}`;

  beforeAll(async () => {
    h = await withMigratedDb();
    await h.db.insert(user).values({ id: MARA, name: "Mara", email: `yaa-mara-${process.pid}@example.com`, emailVerified: true });
  }, 60_000);

  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  }, 30_000);

  test("AS-001: after a real publish emit, GET listForActor returns my publish with meta version label + counts", async () => {
    // A workspace Mara is a CURRENT member of, plus a doc/project living in it.
    const { workspaceId, projectId } = await seedWorkspace(h.db, { userId: MARA, role: "admin", name: "Acme Platform", withProject: true });
    const [doc] = await h.db
      .insert(docs)
      .values({ slug: `yaa-doc-${process.pid}`, title: "Web-core behavior contract", kind: "html", projectId: projectId!, ownerId: MARA })
      .returning({ id: docs.id });

    // The REAL producer emit (the same seam the publish path drives), anchored to the doc's own
    // workspace via workspaceOfDoc. meta carries the renderable version label + diff counts (H3).
    const repo = createActivityRepo(h.db);
    const emitted = await emitActivity(
      {
        type: "publish",
        actorUserId: MARA,
        docId: doc!.id,
        projectId: projectId!,
        summary: "published",
        target: "v4",
        meta: { from: 3, to: 4, adds: 5, dels: 2 },
      },
      {
        repo,
        workspaceOfDoc: async () => workspaceId,
        resolveActorName: async () => "Mara",
      },
    );
    expect(emitted?.id).toBeTruthy(); // the real emit wrote a row

    // Read it back as Mara's own action through the REAL cross-workspace read.
    const rows = await createActorActivityRepo(h.db).listForActor(MARA, { offset: 0, limit: 20 });
    const pub = rows.find((r) => r.id === emitted!.id);
    expect(pub).toBeDefined();
    expect(pub!.type).toBe("publish");
    expect(pub!.actorUserId).toBe(MARA);
    expect(pub!.workspaceId).toBe(workspaceId);
    expect(pub!.workspaceName).toBe("Acme Platform"); // read-time enrichment (AS-002 mechanism)
    expect(pub!.meta).toEqual({ from: 3, to: 4, adds: 5, dels: 2 }); // version label + counts survive
  }, 60_000);

  test("C-005: the feed reads the SAME `activity` table the emit writes — no new data source", async () => {
    // A comment emit + a read-back through listForActor must round-trip on the ONE activity table
    // (no parallel store): the row the producer wrote is the row this consumer serves.
    const { workspaceId, projectId } = await seedWorkspace(h.db, { userId: MARA, role: "admin", name: "Acme Two", withProject: true });
    const [doc] = await h.db
      .insert(docs)
      .values({ slug: `yaa-c5-${process.pid}`, title: "C5 doc", kind: "html", projectId: projectId!, ownerId: MARA })
      .returning({ id: docs.id });
    const emitted = await emitActivity(
      { type: "comment", actorUserId: MARA, docId: doc!.id, summary: "commented on", target: "§a" },
      { repo: createActivityRepo(h.db), workspaceOfDoc: async () => workspaceId, resolveActorName: async () => "Mara" },
    );
    const rows = await createActorActivityRepo(h.db).listForActor(MARA, { offset: 0, limit: 50 });
    expect(rows.some((r) => r.id === emitted!.id)).toBe(true); // same table, round-trips
  }, 60_000);

  test("C-006: a workspace the caller is NOT a member of never surfaces in their feed", async () => {
    // A doc/publish in a workspace Mara does NOT belong to (a different owner).
    const OTHER = `u_yaa_other_${process.pid}`;
    await h.db.insert(user).values({ id: OTHER, name: "Other", email: `yaa-other-${process.pid}@example.com`, emailVerified: true });
    const { workspaceId, projectId } = await seedWorkspace(h.db, { userId: OTHER, role: "admin", name: "Field IO", withProject: true });
    const [doc] = await h.db
      .insert(docs)
      .values({ slug: `yaa-doc2-${process.pid}`, title: "Foreign doc", kind: "html", projectId: projectId!, ownerId: OTHER })
      .returning({ id: docs.id });
    // Mara somehow acted there once but is not a member — the current-member join must drop it.
    const repo = createActivityRepo(h.db);
    const emitted = await emitActivity(
      { type: "comment", actorUserId: MARA, docId: doc!.id, summary: "commented on", target: "§x" },
      { repo, workspaceOfDoc: async () => workspaceId, resolveActorName: async () => "Mara" },
    );
    expect(emitted?.id).toBeTruthy();
    const rows = await createActorActivityRepo(h.db).listForActor(MARA, { offset: 0, limit: 50 });
    expect(rows.find((r) => r.id === emitted!.id)).toBeUndefined(); // not a member → dropped (C-006)
  }, 60_000);
});
