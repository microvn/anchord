// In-process route tests for workspace-activity S-005: version-lifecycle activity emit
// (publish / restore / detached) on the versioning-diff /api/w/:workspaceId/docs/:slug/... mounts.
//
// Exercises the EMIT GLUE only (no DB): a fake ActivityRepo captures the rows the route writes
// post-commit, a fake reanchorOnNewVersion drives the detached sink, fake version/lookup repos +
// session/role/access resolvers run route→service without Postgres.
//
// AS map (workspace-activity):
//   AS-019  publish → ONE `publish` event, meta.from=prev / meta.to=new / adds / dels (split at emit, F-4)
//   AS-020  restore → exactly ONE `restore` event (meta.restored / meta.as) and NO `publish` event (F-3)
//   AS-021  detach  → ONE System `detached` event (actorUserId null, actorName "System", meta.count) (F-5)
//   C-005   each action logs exactly one event of its originating type

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { SessionResolver } from "../../src/http/auth-gate";
import type { Role } from "../../src/sharing/roles";
import type { NewActivity, ActivityRepo, ActivityRow } from "../../src/activity/repo";
import type { VersionRepo, NewVersionRow } from "../../src/services/version";
import type { DocLookup, DocLookupRepo } from "../../src/routes/versions";

const member: SessionResolver = async () => ({ userId: "u_devin" });
const asEditor = async (): Promise<Role | null> => "editor";

const VISIBLE_DOC: DocLookup = {
  id: "doc_1",
  title: "Render + publish pipeline RFC",
  kind: "markdown",
  generalAccess: "anyone_with_link",
};

/** In-memory VersionRepo seeded with versions; records appends. (Mirrors versions-routes.test.ts.) */
function fakeVersionRepo(seed: { version: number; content: string; contentHash: string }[] = []) {
  const rows = seed.map((s) => ({ ...s, createdAt: new Date(), publishedBy: null as string | null }));
  const calls = { inserts: [] as NewVersionRow[], titles: [] as string[] };
  const repo: VersionRepo = {
    async currentMaxVersion(_docId) {
      return rows.length ? Math.max(...rows.map((r) => r.version)) : null;
    },
    async insertVersion(row) {
      calls.inserts.push(row);
      rows.push({
        version: row.version,
        content: row.content,
        contentHash: row.contentHash,
        createdAt: new Date(),
        publishedBy: row.publishedBy ?? null,
      });
      return { version: row.version };
    },
    async setTitle(_docId, title) {
      calls.titles.push(title);
    },
    async listVersions(_docId) {
      return rows
        .slice()
        .sort((a, b) => a.version - b.version)
        .map((r) => ({ version: r.version, createdAt: r.createdAt, publishedBy: r.publishedBy, publishedByName: null }));
    },
    async getVersion(_docId, version) {
      const hit = rows.find((r) => r.version === version);
      return hit ? { content: hit.content, contentHash: hit.contentHash } : null;
    },
  };
  return { repo, calls, rows };
}

function fakeLookupRepo(doc: DocLookup | null, versionRepo: ReturnType<typeof fakeVersionRepo>): DocLookupRepo {
  return {
    async findDocBySlug(_slug) {
      return doc;
    },
    async getVersionContent(_docId, version) {
      const hit = await versionRepo.repo.getVersion("", version);
      return hit ? { id: `ver_${version}`, ...hit } : null;
    },
  };
}

/** Captures every activity row the route emits. Read-side methods are unused stubs. */
function fakeActivityRepo() {
  const rows: NewActivity[] = [];
  let seq = 0;
  const repo: ActivityRepo = {
    async insertActivity(input) {
      rows.push(input);
      return { id: `act_${++seq}` };
    },
    async countActivity() {
      return rows.length;
    },
    async listActivity() {
      return [] as ActivityRow[];
    },
    async listAllActivity() {
      return [] as ActivityRow[];
    },
    async getActivityById() {
      return null;
    },
    async listRelatedByDoc() {
      return [] as ActivityRow[];
    },
  };
  return { repo, rows };
}

function buildApp(opts: {
  versionRepo: ReturnType<typeof fakeVersionRepo>;
  activityRepo: ReturnType<typeof fakeActivityRepo>;
  /** Fires the detached sink with this count (simulates a re-anchor that couldn't place N). */
  detachedCount?: number;
  /** Omit the activity block entirely (assert publish/restore still succeed with no rows). */
  noActivity?: boolean;
}) {
  const lookup = fakeLookupRepo(VISIBLE_DOC, opts.versionRepo);
  return createApp({
    dbCheck: async () => {},
    versions: {
      versionRepo: opts.versionRepo.repo,
      lookupRepo: lookup,
      resolveSession: member,
      resolveWorkspaceRole: async () => "member",
      resolveDocRole: asEditor,
      resolveAccess: async () => ({ role: "editor", canView: true }),
      // Simulate the real re-anchor: when a detached count is configured, invoke the route's
      // onDetached sink synchronously (the count only exists inside this summary callback, F-5).
      reanchorOnNewVersion: async ({ onDetached }) => {
        if (opts.detachedCount && opts.detachedCount > 0) await onDetached?.(opts.detachedCount);
      },
      activity: opts.noActivity
        ? undefined
        : {
            repo: opts.activityRepo.repo,
            workspaceOfDoc: async () => "ws_1",
            resolveActorName: async (userId) => (userId === "u_devin" ? "Devin" : userId === "u_mara" ? "Mara" : null),
          },
    },
  });
}

function req(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** bun's microtask turn — let fire-and-forget emits (detached) settle before asserting. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("workspace-activity S-005: version publish event (AS-019)", () => {
  test("AS-019: publishing v4 over v3 logs ONE publish event with from v3 → to v4 and +11/−0", async () => {
    // v3 current; publish v4 whose content adds 11 lines and removes 0 vs v3 (F-4 split at emit).
    const v3 = Array.from({ length: 5 }, (_, i) => `line ${i}`).join("\n");
    const v4 = [v3, ...Array.from({ length: 11 }, (_, i) => `added ${i}`)].join("\n");
    const vr = fakeVersionRepo([
      { version: 1, content: "a", contentHash: "h1" },
      { version: 2, content: "b", contentHash: "h2" },
      { version: 3, content: v3, contentHash: "h3" },
    ]);
    const act = fakeActivityRepo();
    const app = buildApp({ versionRepo: vr, activityRepo: act });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/versions", { method: "POST", body: JSON.stringify({ content: v4 }) }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.data.version).toBe(4);

    // Exactly one event, type=publish (C-005), actor = the publisher, anchored to the doc.
    expect(act.rows).toHaveLength(1);
    const row = act.rows[0];
    expect(row.type).toBe("publish");
    expect(row.actorUserId).toBe("u_devin");
    expect(row.docId).toBe("doc_1");
    expect(row.workspaceId).toBe("ws_1");
    // meta.from=v3 → meta.to=v4, with adds/dels split from the diff (F-4): +11 added, 0 removed.
    expect(row.meta).toEqual({ from: 3, to: 4, adds: 11, dels: 0 });
  });

  test("AS-019/C-005: the very first version logs a publish with from=null (no baseline) and no double-emit", async () => {
    const vr = fakeVersionRepo([]); // brand-new doc
    const act = fakeActivityRepo();
    const app = buildApp({ versionRepo: vr, activityRepo: act });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/versions", { method: "POST", body: JSON.stringify({ content: "first\nbody" }) }),
    );
    expect(res.status).toBe(201);
    expect(act.rows).toHaveLength(1);
    expect(act.rows[0].type).toBe("publish");
    expect((act.rows[0].meta as any).from).toBeNull();
    expect((act.rows[0].meta as any).to).toBe(1);
  });

  test("C-002: publish still succeeds (201) when no activity block is wired — no row, no throw", async () => {
    const vr = fakeVersionRepo([{ version: 1, content: "v1", contentHash: "h1" }]);
    const act = fakeActivityRepo();
    const app = buildApp({ versionRepo: vr, activityRepo: act, noActivity: true });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/versions", { method: "POST", body: JSON.stringify({ content: "v2" }) }),
    );
    expect(res.status).toBe(201);
    expect(act.rows).toHaveLength(0);
  });
});

describe("workspace-activity S-005: version restore event (AS-020)", () => {
  test("AS-020/C-005/F-3: restoring v1 logs exactly ONE restore event and NO publish event", async () => {
    // current = v2; restore v1 → appends v3. Feed must gain exactly 1 row, type=restore.
    const vr = fakeVersionRepo([
      { version: 1, content: "original", contentHash: "h1" },
      { version: 2, content: "current", contentHash: "h2" },
    ]);
    const act = fakeActivityRepo();
    const app = buildApp({ versionRepo: vr, activityRepo: act });
    const res = await app.handle(req("/api/w/ws_1/docs/doc-one/versions/1/restore", { method: "POST" }));
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.data.version).toBe(3);

    // Exactly ONE row, and it is `restore` — NOT `publish` (F-3: publish emit suppressed on restore).
    expect(act.rows).toHaveLength(1);
    expect(act.rows.filter((r) => r.type === "publish")).toHaveLength(0);
    const row = act.rows[0];
    expect(row.type).toBe("restore");
    expect(row.actorUserId).toBe("u_devin");
    expect(row.docId).toBe("doc_1");
    // meta.restored = the version restored (v1); meta.as = the new version it became (v3).
    expect(row.meta).toEqual({ restored: 1, as: 3 });
  });
});

describe("workspace-activity S-005: detachment event (AS-021)", () => {
  test("AS-021/F-5: a publish that detaches 2 annotations logs ONE System detached event with count 2", async () => {
    const vr = fakeVersionRepo([{ version: 1, content: "v1\nbody", contentHash: "h1" }]);
    const act = fakeActivityRepo();
    // Re-anchor reports 2 detached → the route's onDetached sink emits the System `detached` row.
    const app = buildApp({ versionRepo: vr, activityRepo: act, detachedCount: 2 });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/versions", { method: "POST", body: JSON.stringify({ content: "v2 body" }) }),
    );
    expect(res.status).toBe(201);
    await flush(); // let the fire-and-forget detached emit settle

    // The publish event still appears (C-002), PLUS one System detached event with count 2.
    const detached = act.rows.filter((r) => r.type === "detached");
    expect(detached).toHaveLength(1);
    expect(detached[0].actorUserId).toBeNull(); // System actor — no account
    expect(detached[0].actorName).toBe("System");
    expect(detached[0].docId).toBe("doc_1");
    expect(detached[0].meta).toEqual({ count: 2 });
    // The publish event is still present alongside it (one of each).
    expect(act.rows.filter((r) => r.type === "publish")).toHaveLength(1);
  });

  test("AS-021: a publish that detaches NOTHING logs no detached event (count 0 → no row)", async () => {
    const vr = fakeVersionRepo([{ version: 1, content: "v1", contentHash: "h1" }]);
    const act = fakeActivityRepo();
    const app = buildApp({ versionRepo: vr, activityRepo: act, detachedCount: 0 });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/versions", { method: "POST", body: JSON.stringify({ content: "v2" }) }),
    );
    expect(res.status).toBe(201);
    await flush();
    expect(act.rows.filter((r) => r.type === "detached")).toHaveLength(0);
  });
});
