// Integration tier (guarded by RUN_INTEGRATION): the C-011 default-project uniqueness
// guarantee over REAL Postgres — the one place the partial-unique index `projects_default_uq`
// and ensureDefaultProject's conflict-readback can actually be exercised against a live race.
//
//   mcp-roundtrip AS-027 / C-011 — two concurrent first-creates of a default project for one
//   (workspace, owner) must yield EXACTLY ONE default project; both callers converge on it.
//   The DB partial-unique index is the at-most-one enforcement (race-proof); ensureDefaultProject
//   is the at-least-one + conflict-readback so the loser returns the winner's row, not an error.
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/default-project-race.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { projects, user as userTable } from "../../src/db/schema";
import { createProjectRepo } from "../../src/workspace/repo";
import { ensureDefaultProject } from "../../src/workspace/projects";
import { seedWorkspace, withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;

async function makeUser(db: MigratedDb["db"], name: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(userTable).values({ id, name, email: `${id}@itest.local` });
  return id;
}

async function countDefaults(db: MigratedDb["db"], workspaceId: string, ownerId: string) {
  const rows = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.workspaceId, workspaceId),
        eq(projects.ownerId, ownerId),
        eq(projects.isDefault, true),
      ),
    );
  return rows;
}

describe.skipIf(!RUN)("mcp-roundtrip C-011: default-project uniqueness (real Postgres)", () => {
  let h: MigratedDb;

  beforeAll(async () => {
    h = await withMigratedDb();
  });

  afterAll(async () => {
    if (!h) return;
    await h.close();
    await h.stop();
  });

  test("AS-027: 8 concurrent ensureDefaultProject calls create exactly ONE default; all converge on it", async () => {
    const ownerId = await makeUser(h.db, "Race A");
    const { workspaceId } = await seedWorkspace(h.db, { userId: ownerId, withProject: false });
    const repo = createProjectRepo(h.db);

    // Fire many concurrent first-creates against an empty workspace (the AS-027 race).
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        ensureDefaultProject({ workspaceId, ownerId, userName: "Race A" }, { repo }),
      ),
    );

    // DB-enforced: exactly one default row exists for this (workspace, owner).
    const defaults = await countDefaults(h.db, workspaceId, ownerId);
    expect(defaults).toHaveLength(1);

    // Every caller converged on the SAME project (the loser read back the winner, not an error).
    const uniqueIds = new Set(results.map((p) => p.id));
    expect(uniqueIds.size).toBe(1);
    expect(results.every((p) => p.id === defaults[0]!.id)).toBe(true);
    expect(results.every((p) => p.isDefault)).toBe(true);
  });

  test("AS-027: a second ensureDefaultProject after one exists is idempotent (returns the same row)", async () => {
    const ownerId = await makeUser(h.db, "Race B");
    const { workspaceId } = await seedWorkspace(h.db, { userId: ownerId, withProject: false });
    const repo = createProjectRepo(h.db);

    const first = await ensureDefaultProject({ workspaceId, ownerId, userName: "Race B" }, { repo });
    const second = await ensureDefaultProject({ workspaceId, ownerId, userName: "Race B" }, { repo });

    expect(second.id).toBe(first.id);
    expect(await countDefaults(h.db, workspaceId, ownerId)).toHaveLength(1);
  });

  test("C-011: a raw duplicate is_default insert for the same (workspace, owner) is rejected by the DB", async () => {
    const ownerId = await makeUser(h.db, "Race C");
    const { workspaceId } = await seedWorkspace(h.db, { userId: ownerId, withProject: false });

    await h.db
      .insert(projects)
      .values({ workspaceId, name: "Race C's docs", ownerId, isDefault: true });

    // The partial-unique index must reject a second default for the same (workspace, owner).
    let rejected = false;
    try {
      await h.db
        .insert(projects)
        .values({ workspaceId, name: "Race C dup", ownerId, isDefault: true });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);

    expect(await countDefaults(h.db, workspaceId, ownerId)).toHaveLength(1);
  });

  test("C-011: the index does NOT block two NON-default projects for the same owner", async () => {
    const ownerId = await makeUser(h.db, "Race D");
    const { workspaceId } = await seedWorkspace(h.db, { userId: ownerId, withProject: false });
    const repo = createProjectRepo(h.db);

    // Non-default projects are unconstrained by projects_default_uq (the WHERE is_default guard).
    const p1 = await repo.insert({ workspaceId, name: "Billing", ownerId, isDefault: false });
    const p2 = await repo.insert({ workspaceId, name: "Payments", ownerId, isDefault: false });

    expect(p1.id).not.toBe(p2.id);
    expect(await countDefaults(h.db, workspaceId, ownerId)).toHaveLength(0);
  });
});
