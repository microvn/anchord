// Integration tier (guarded by RUN_INTEGRATION): the full route→service→DB path
// for the versioning-diff /api/docs/:slug/... routes against a REAL Postgres.
// Proves version append/history/restore over the HTTP envelope persist and read
// back correctly with real version numbering (the multi-writer counter the unit
// suite could only stub behind a fake repo).
//
// The better-auth cookie flow is heavy to drive in-test, so resolveSession +
// resolveDocRole are injected with fakes (a member acting as editor) — the point
// of THIS test is the live DB read/write, not auth (auth is covered elsewhere).
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/versions-routes.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { docVersions } from "../../src/db/schema";
import { createApp } from "../../src/app";
import { createDocRepo } from "../../src/publish/repo";
import type { SessionResolver } from "../../src/http/auth-gate";
import { withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;
const member: SessionResolver = async () => ({ userId: "u_itest" });

describe.skipIf(!RUN)("versioning-diff routes (real Postgres)", () => {
  let h: MigratedDb;
  let app: ReturnType<typeof createApp>;
  let slug: string;

  beforeAll(async () => {
    h = await withMigratedDb();
    // Seed a published doc (version 1) via the real publish repo, then expose the
    // versioning-diff routes over the SAME db. The doc is anyone_with_link so the
    // fake editor member can both view and write.
    slug = `vroutes-${process.pid}`;
    await createDocRepo(h.db).createDocWithV1({
      slug,
      title: "Versioned Doc",
      kind: "markdown",
      content: "# v1\n",
      contentHash: "hash-v1",
    });
    // Make it link-visible so canViewDoc allows the member.
    const { docs } = await import("../../src/db/schema");
    await h.db.update(docs).set({ generalAccess: "anyone_with_link" }).where(eq(docs.slug, slug));

    app = createApp({
      dbCheck: async () => {},
      versions: {
        db: h.db,
        resolveSession: member,
        resolveDocRole: async () => "editor",
        accessDeps: { isInvited: () => true, isWorkspaceMember: () => true },
      },
    });
  });

  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  });

  function req(path: string, init: RequestInit = {}) {
    return new Request(`http://localhost${path}`, {
      headers: { "content-type": "application/json" },
      ...init,
    });
  }

  test("POST version → v2 persisted; GET history → 2 items; restore v1 → v3; all on real DB", async () => {
    // POST a new version → v2
    const postRes = await app.handle(
      req(`/api/docs/${slug}/versions`, {
        method: "POST",
        body: JSON.stringify({ content: "# v2 updated\n" }),
      }),
    );
    expect(postRes.status).toBe(201);
    const postJson = (await postRes.json()) as any;
    expect(postJson.data.version).toBe(2);
    expect(postJson.data.previousVersion).toBe(1);

    // GET history → 2 items, paginated, v2 current
    const histRes = await app.handle(req(`/api/docs/${slug}/versions`));
    expect(histRes.status).toBe(200);
    const histJson = (await histRes.json()) as any;
    expect(histJson.data.items).toHaveLength(2);
    expect(histJson.data.pagination.total).toBe(2);
    expect(histJson.data.items.find((i: any) => i.isCurrent).version).toBe(2);

    // Restore v1 → appends v3 (append-copy of v1's content)
    const restoreRes = await app.handle(
      req(`/api/docs/${slug}/versions/1/restore`, { method: "POST" }),
    );
    expect(restoreRes.status).toBe(201);
    const restoreJson = (await restoreRes.json()) as any;
    expect(restoreJson.data.version).toBe(3);
    expect(restoreJson.data.previousVersion).toBe(2);

    // Assert on the real DB: three version rows, v3 carries v1's content verbatim.
    const rows = await h.db.select().from(docVersions).orderBy(docVersions.version);
    expect(rows.filter((r) => [1, 2, 3].includes(r.version)).length).toBe(3);
    const v3 = rows.find((r) => r.version === 3);
    expect(v3?.content).toBe("# v1\n"); // append-copy restored v1's content
  });

  test("GET diff?from=1&to=2 → 200 text diff with changes", async () => {
    const res = await app.handle(req(`/api/docs/${slug}/diff?from=1&to=2`));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.mode).toBe("text");
    expect(json.data.changeCount).toBeGreaterThan(0);
    expect(json.data.renderPair).toHaveLength(2);
  });

  test("PATCH title → 200 and creates NO new version (AS-002)", async () => {
    const before = await h.db.select().from(docVersions);
    const res = await app.handle(
      req(`/api/docs/${slug}`, { method: "PATCH", body: JSON.stringify({ title: "Renamed" }) }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.title).toBe("Renamed");
    const after = await h.db.select().from(docVersions);
    expect(after.length).toBe(before.length); // no version row added
  });

  test("missing doc → 404 (existence-hiding)", async () => {
    const res = await app.handle(req(`/api/docs/does-not-exist/versions`));
    expect(res.status).toBe(404);
  });
});
