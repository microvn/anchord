// Integration tier (guarded by RUN_INTEGRATION): workspace-project S-008 over REAL Postgres.
// Proves the parts the route/unit tests deferred to a DB:
//   AS-023 — workspaceDocs returns the union across the workspace's ACTIVE projects, each row
//            joined to its project name, ordered most-recently-updated first.
//   AS-024 — the active-project span (id + name) falls out of the SAME union read (no per-project
//            query); NO per-project doc count is computed (unused — corrected 2026-06-21).
//   AS-026 — access filtering (C-003, via filterBrowsableDocs, the SAME filter the per-project
//            browse uses) drops out-of-access docs before paging/the total: a restricted doc the
//            caller is NOT invited to never appears in the union page or the total.
// An ARCHIVED project's docs are excluded from the union (the inner join is active-only).
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/workspace-docs.itest.ts

import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { docs, projects, user as userTable } from "../../src/db/schema";
import { createDocRepo } from "../../src/publish/repo";
import { createProjectsRouteRepo, type WorkspaceDocRow } from "../../src/workspace/repo";
import { filterBrowsableDocs } from "../../src/workspace/projects";
import { seedWorkspace, withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;

describe.skipIf(!RUN)("workspace-project S-008: workspace-wide docs union (real Postgres)", () => {
  let h: MigratedDb;
  let WS = "";
  let pActive1 = "";
  let pActive2 = "";
  let pArchived = "";
  const A = `u-s008a-${process.pid}`;
  const X = `u-s008x-${process.pid}`;

  // Helper: create a doc in a project with a given access level + updatedAt (for ordering).
  async function mkDoc(opts: {
    n: number;
    projectId: string;
    ownerId: string;
    access: "restricted" | "anyone_in_workspace" | "anyone_with_link";
    updatedAt: Date;
  }) {
    const { id } = await createDocRepo(h.db).createDocWithV1({
      slug: `s008-${opts.n}-${process.pid}`,
      title: `Doc ${opts.n}`,
      kind: "markdown",
      content: `# body ${opts.n}`,
      contentHash: `hash-s008-${opts.n}-${process.pid}`,
      ownerId: opts.ownerId,
      projectId: opts.projectId,
    });
    await h.db
      .update(docs)
      .set({ generalAccess: opts.access, updatedAt: opts.updatedAt })
      .where(eq(docs.id, id));
    return id;
  }

  beforeAll(async () => {
    h = await withMigratedDb();
    await h.db.insert(userTable).values([
      { id: A, name: "Alice", email: `s008a-${process.pid}@itest.local`, emailVerified: true },
      { id: X, name: "Xavier", email: `s008x-${process.pid}@itest.local`, emailVerified: true },
    ]);
    const seeded = await seedWorkspace(h.db, { userId: A, withProject: false });
    WS = seeded.workspaceId;
    // X is a member of the workspace too (so anyone_in_workspace resolves true for X).
    await h.db
      .insert((await import("../../src/db/schema")).workspaceMembers)
      .values({ workspaceId: WS, userId: X, role: "member" });

    const [a1] = await h.db
      .insert(projects)
      .values({ workspaceId: WS, name: "Alpha", ownerId: A, isDefault: false })
      .returning({ id: projects.id });
    const [a2] = await h.db
      .insert(projects)
      .values({ workspaceId: WS, name: "Beta", ownerId: A, isDefault: false })
      .returning({ id: projects.id });
    const [arch] = await h.db
      .insert(projects)
      .values({ workspaceId: WS, name: "Archived", ownerId: A, isDefault: false, archivedAt: new Date() })
      .returning({ id: projects.id });
    pActive1 = a1!.id;
    pActive2 = a2!.id;
    pArchived = arch!.id;

    // Alpha: 2 anyone_in_workspace + 1 restricted (X uninvited). Beta: 1 anyone_in_workspace.
    // Archived: 1 anyone_in_workspace (must NOT appear in the union — inactive project).
    await mkDoc({ n: 1, projectId: pActive1, ownerId: A, access: "anyone_in_workspace", updatedAt: new Date("2026-06-03T00:00:00Z") });
    await mkDoc({ n: 2, projectId: pActive1, ownerId: A, access: "anyone_in_workspace", updatedAt: new Date("2026-06-05T00:00:00Z") });
    await mkDoc({ n: 3, projectId: pActive1, ownerId: A, access: "restricted", updatedAt: new Date("2026-06-04T00:00:00Z") });
    await mkDoc({ n: 4, projectId: pActive2, ownerId: A, access: "anyone_in_workspace", updatedAt: new Date("2026-06-06T00:00:00Z") });
    await mkDoc({ n: 5, projectId: pArchived, ownerId: A, access: "anyone_in_workspace", updatedAt: new Date("2026-06-07T00:00:00Z") });
  });

  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  });

  test("AS-023: workspaceDocs returns the active-project union joined to project name, updated-desc", async () => {
    const union = await createProjectsRouteRepo(h.db).workspaceDocs(WS);
    // 4 docs across the two ACTIVE projects; the archived project's doc is excluded.
    expect(union).toHaveLength(4);
    const titles = union.map((d) => d.title);
    expect(titles).not.toContain("Doc 5"); // archived project doc absent
    // Each row carries its project name.
    const byTitle = (t: string) => union.find((d) => d.title === t)!;
    expect(byTitle("Doc 1").projectName).toBe("Alpha");
    expect(byTitle("Doc 4").projectName).toBe("Beta");
    // Ordered most-recently-updated first: Doc4(06-06), Doc2(06-05), Doc3(06-04), Doc1(06-03).
    expect(union.map((d) => d.title)).toEqual(["Doc 4", "Doc 2", "Doc 3", "Doc 1"]);
  });

  test("AS-026/C-003: access filter drops the restricted doc X isn't invited to; total + counts reflect only accessible", async () => {
    const ctx = createProjectsRouteRepo(h.db);
    const union = await ctx.workspaceDocs(WS);
    // Apply the SAME access filter the per-project + workspace-wide routes use.
    const visible = (await filterBrowsableDocs(X, union, {
      isInvited: (docId, userId) => ctx.isInvited(docId, userId),
      isWorkspaceMember: () => Promise.resolve(true),
    })) as WorkspaceDocRow[];
    // X sees the 3 anyone_in_workspace docs (Doc1, Doc2, Doc4); the restricted Doc3 is dropped.
    expect(visible.map((d) => d.title).sort()).toEqual(["Doc 1", "Doc 2", "Doc 4"]);
    expect(visible.some((d) => d.title === "Doc 3")).toBe(false);
    // Per-project accessible counts: Alpha 2, Beta 1 (never Alpha's raw 3).
    const counts = new Map<string, number>();
    for (const v of visible) counts.set(v.projectName, (counts.get(v.projectName) ?? 0) + 1);
    expect(counts.get("Alpha")).toBe(2);
    expect(counts.get("Beta")).toBe(1);
    // Workspace total reflects only the 3 accessible.
    expect(visible.length).toBe(3);
  });

  test("AS-024: the active-project span (id + name) falls out of the one union read — Alpha + Beta, no per-project count", async () => {
    const ctx = createProjectsRouteRepo(h.db);
    const union = await ctx.workspaceDocs(WS);
    const visible = (await filterBrowsableDocs(A, union, {
      isInvited: (docId, userId) => ctx.isInvited(docId, userId),
      isWorkspaceMember: () => Promise.resolve(true),
    })) as WorkspaceDocRow[];
    expect(visible.length).toBe(4); // A owns all, including the restricted Doc3
    // The union carries each doc's project id + name — the active-project list (id + name) the
    // route surfaces is derivable from the same read; the two active projects are Alpha + Beta.
    const span = new Map(visible.map((v) => [v.projectId, v.projectName]));
    expect(new Set(span.values())).toEqual(new Set(["Alpha", "Beta"]));
    expect([pActive1, pActive2].every((id) => span.has(id))).toBe(true);
    // The union rows carry NO per-project doc count field (it was unused, dropped 2026-06-21).
    for (const v of visible) expect((v as any).docCount).toBeUndefined();
  });
});
