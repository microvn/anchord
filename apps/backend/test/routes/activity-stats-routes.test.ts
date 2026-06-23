// In-process route tests for the activity stats rail (workspace-activity S-007 / C-003 + C-006).
//
// GET /api/w/:workspaceId/activity/stats returns the trailing-7-day rail: { counts, contributors,
// busiestDoc }. The aggregates are computed over the SAME visible set the feed shows — the route
// reuses the ONE shared visibility gate (createActivityVisibility) BEFORE aggregating (C-003/F-7),
// so a member's counts AND busiest-doc name can never include a doc they can't open (AS-028). The
// window is the last 7 days (C-006/AS-026). Same in-memory repo + fake resolveAccess as the S-002/3
// route tests — no real Postgres.
//
// AS map:
//   AS-026  the rail counts/contributors cover only the last 7 days (older events excluded)
//   AS-028  a member's rail excludes docs they can't access — counts AND busiest-doc name (shared gate)

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { SessionResolver, WorkspaceRoleResolver } from "../../src/http/auth-gate";
import type { ActivityRepo, ActivityRow, NewActivity } from "../../src/activity/repo";
import type { ResolveDocAccess } from "../../src/activity/visibility";

const asUser = (userId: string): SessionResolver => async () => ({ userId });

function req(path: string) {
  return new Request(`http://localhost${path}`, { headers: { "content-type": "application/json" } });
}

type Seed = NewActivity & { id: string; createdAt: Date };

function memActivityRepo(seed: Seed[]): ActivityRepo {
  const rows = [...seed];
  const inWs = (f: { workspaceId?: string }) => rows.filter((r) => f.workspaceId == null || r.workspaceId === f.workspaceId);
  const sorted = (f: { workspaceId?: string }) =>
    inWs(f).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
  return {
    async insertActivity() {
      return { id: "x" };
    },
    async countActivity(f) {
      return sorted(f).length;
    },
    async listActivity(f, { offset, limit }) {
      return sorted(f).slice(offset, offset + limit) as unknown as ActivityRow[];
    },
    async listAllActivity(f) {
      return sorted(f) as unknown as ActivityRow[];
    },
    async getActivityById(f, id) {
      return (sorted(f).find((r) => r.id === id) as unknown as ActivityRow) ?? null;
    },
    async listRelatedByDoc(f, docId, opts) {
      return sorted(f)
        .filter((r) => r.docId === docId && r.id !== opts?.excludeId)
        .slice(0, opts?.limit ?? 5) as unknown as ActivityRow[];
    },
  };
}

// Day offsets relative to "now-ish": the test seeds events at known ages and relies on the server
// computing the window from the real current time. We anchor ages to Date.now() so the window is
// stable regardless of when the suite runs.
const ago = (days: number, hours = 0) => new Date(Date.now() - days * 86400_000 - hours * 3600_000);

let seq = 0;
const ev = (over: Partial<Seed> & { createdAt: Date }): Seed => ({
  id: `e-${seq++}`,
  workspaceId: "ws-1",
  type: "comment",
  actorUserId: "u-x",
  actorName: "X",
  docId: null,
  ...over,
});

function fakeResolveAccess(accessible: Set<string>): ResolveDocAccess {
  return async (docId) => (accessible.has(docId) ? { role: "viewer", canView: true } : { role: null, canView: false });
}

function buildApp(opts: { who: string; role: "admin" | "member"; accessible: Set<string>; seed: Seed[] }) {
  const resolveWorkspaceRole: WorkspaceRoleResolver = async () => opts.role;
  return createApp({
    dbCheck: async () => {},
    activity: {
      repo: memActivityRepo(opts.seed),
      resolveSession: asUser(opts.who),
      resolveWorkspaceRole,
      resolveAccess: fakeResolveAccess(opts.accessible),
    },
  });
}

async function get(app: ReturnType<typeof buildApp>, path: string) {
  return (await (await app.handle(req(path))).json()) as any;
}

describe("activity stats rail — trailing 7-day window (S-007 / C-006 / AS-026)", () => {
  test("AS-026: the rail counts and contributors reflect only events from the last 7 days", async () => {
    const seed: Seed[] = [
      ev({ createdAt: ago(0), actorName: "Mara" }),
      ev({ createdAt: ago(3), actorName: "Mara" }),
      ev({ createdAt: ago(6), actorName: "Devin" }),
      // older than 7 days → excluded (days 8, 9, 10)
      ev({ createdAt: ago(8), actorName: "Stale" }),
      ev({ createdAt: ago(9), actorName: "Stale" }),
      ev({ createdAt: ago(10), actorName: "Stale" }),
    ];
    const app = buildApp({ who: "u-mara", role: "admin", accessible: new Set(), seed });
    const json = await get(app, "/api/w/ws-1/activity/stats");
    expect(json.data.counts.all).toBe(3);
    expect(json.data.contributors.map((c: any) => c.name)).not.toContain("Stale");
  });

  test("AS-027: contributors are ranked highest-first by in-window event count", async () => {
    const seed: Seed[] = [
      ...Array.from({ length: 5 }, () => ev({ createdAt: ago(1), actorName: "Mara" })),
      ...Array.from({ length: 3 }, () => ev({ createdAt: ago(2), actorName: "Devin" })),
      ...Array.from({ length: 2 }, () => ev({ createdAt: ago(3), actorName: "Priya" })),
    ];
    const app = buildApp({ who: "u-mara", role: "admin", accessible: new Set(), seed });
    const json = await get(app, "/api/w/ws-1/activity/stats");
    expect(json.data.contributors).toEqual([
      { name: "Mara", count: 5 },
      { name: "Devin", count: 3 },
      { name: "Priya", count: 2 },
    ]);
  });
});

describe("activity stats rail — visibility (S-007 / C-003 / AS-028)", () => {
  // d-secret is restricted (Tom can't access); d-rfc is accessible. The busiest doc by raw count is
  // d-secret (4 events) — but Tom must NOT see it as busiest, and its events must not inflate counts.
  const SEED: Seed[] = [
    ev({ createdAt: ago(0), docId: "d-secret", target: "Secret roadmap", type: "comment", actorName: "Mara" }),
    ev({ createdAt: ago(0), docId: "d-secret", target: "Secret roadmap", type: "comment", actorName: "Mara" }),
    ev({ createdAt: ago(1), docId: "d-secret", target: "Secret roadmap", type: "comment", actorName: "Mara" }),
    ev({ createdAt: ago(1), docId: "d-secret", target: "Secret roadmap", type: "publish", actorName: "Mara" }),
    ev({ createdAt: ago(1), docId: "d-rfc", target: "Render pipeline RFC", type: "comment", actorName: "Devin" }),
    ev({ createdAt: ago(2), docId: "d-rfc", target: "Render pipeline RFC", type: "comment", actorName: "Devin" }),
    ev({ createdAt: ago(2), docId: null, type: "member", actorName: "Tom" }),
  ];

  test("AS-028: a member's busiest-doc never names a doc they can't open; its events are excluded from the counts", async () => {
    const app = buildApp({ who: "u-tom", role: "member", accessible: new Set(["d-rfc"]), seed: SEED });
    const json = await get(app, "/api/w/ws-1/activity/stats");
    // Tom sees: 2 d-rfc comments + 1 workspace-level member event = 3 total; the 4 d-secret events
    // are excluded from the counts.
    expect(json.data.counts.all).toBe(3);
    expect(json.data.counts.comments).toBe(2);
    // The busiest doc is d-rfc (his only visible doc), NEVER d-secret — even though d-secret has more
    // raw events. The name must not leak.
    expect(json.data.busiestDoc?.docId).toBe("d-rfc");
    expect(json.data.busiestDoc?.name).toBe("Render pipeline RFC");
    expect(JSON.stringify(json.data)).not.toContain("Secret roadmap");
  });

  test("AS-028 (admin baseline): an admin's busiest doc IS d-secret — the gate, not the aggregate, differs", async () => {
    const app = buildApp({ who: "u-mara", role: "admin", accessible: new Set(), seed: SEED });
    const json = await get(app, "/api/w/ws-1/activity/stats");
    // Admin sees every event → d-secret (4) is busiest; same aggregator, different visible set.
    expect(json.data.busiestDoc?.docId).toBe("d-secret");
    expect(json.data.busiestDoc?.events).toBe(4);
    expect(json.data.counts.all).toBe(7);
  });
});
