// In-process route tests for the access-gated activity feed (workspace-activity S-002 / C-003 + C-008).
//
// HTTP GLUE over the SHARED visibility gate: the feed-list filters the workspace log through the gate
// BEFORE paging, and the single-event detail returns NOT-FOUND when the gate hides the row
// (existence-hiding, never 403). The gate's per-doc decision is the injected resolveAccess — the
// SAME resolver the doc viewer uses (the route never re-derives access). No real Postgres.
//
// AS map:
//   AS-007  admin sees an event on a doc they don't directly share (admin → all)
//   AS-008  member does NOT see an event on a restricted doc with no grant (feed-list)
//   AS-029  member SEES an event on an anyone_in_workspace doc they can open (feed-list)
//   AS-009  member sees a workspace-level event (docId null) regardless of doc access
//   AS-010  member opening a hidden event's detail gets NOT-FOUND (not forbidden)
//   AS-030  doc tightened after emit → its event drops from the feed AND its detail 404s (read-time)
//   C-003   feed-list + detail-url route through ONE gate → consistent visibility
//   C-008   read side filters by path workspaceId + gates each doc-scoped row via resolveAccess

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

// In-memory activity repo (workspace-scoped read), mirroring the Drizzle repo's recent-first contract
// + the S-002 listAllActivity / getActivityById methods the access gate uses.
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
  };
}

// "Secret roadmap" = d-secret (restricted, members can't open); "Render pipeline RFC" = d-rfc
// (anyone_in_workspace, members can open); a member-joined event has docId null.
const SEED: Seed[] = [
  { id: "e-secret", workspaceId: "ws-1", type: "comment", actorUserId: "u-x", actorName: "X", docId: "d-secret", summary: "commented on", target: "Secret roadmap", createdAt: new Date(2026, 5, 23, 9, 0, 1) },
  { id: "e-rfc", workspaceId: "ws-1", type: "comment", actorUserId: "u-x", actorName: "X", docId: "d-rfc", summary: "commented on", target: "Render pipeline RFC", createdAt: new Date(2026, 5, 23, 9, 0, 2) },
  { id: "e-join", workspaceId: "ws-1", type: "member", actorUserId: "u-priya", actorName: "Priya", docId: null, summary: "joined the workspace", target: null, createdAt: new Date(2026, 5, 23, 9, 0, 3) },
];

// resolveAccess fake: `accessible` is the set of docIds the viewer can open right now (read-time).
function fakeResolveAccess(accessible: Set<string>): ResolveDocAccess {
  return async (docId) => (accessible.has(docId) ? { role: "viewer", canView: true } : { role: null, canView: false });
}

function buildApp(opts: {
  who: string;
  role: "admin" | "member";
  accessible: Set<string>;
  repo?: ActivityRepo;
}) {
  const resolveWorkspaceRole: WorkspaceRoleResolver = async () => opts.role;
  return createApp({
    dbCheck: async () => {},
    activity: {
      repo: opts.repo ?? memActivityRepo(SEED),
      resolveSession: asUser(opts.who),
      resolveWorkspaceRole,
      resolveAccess: fakeResolveAccess(opts.accessible),
    },
  });
}

async function feedIds(app: ReturnType<typeof buildApp>): Promise<string[]> {
  const json = (await (await app.handle(req("/api/w/ws-1/activity"))).json()) as any;
  return (json.data.items as ActivityRow[]).map((r) => r.id);
}

describe("activity feed visibility — feed-list (workspace-activity S-002)", () => {
  test("AS-007: an admin sees an event on a doc they don't directly share", async () => {
    // Admin shares NO doc (empty accessible set) — admins still see every workspace event.
    const ids = await feedIds(buildApp({ who: "u-mara", role: "admin", accessible: new Set() }));
    expect(ids).toContain("e-secret"); // the restricted "Secret roadmap" event is present for the admin
    expect(ids).toEqual(["e-join", "e-rfc", "e-secret"]); // recent-first, all three
  });

  test("AS-008: a member does NOT see an event on a restricted doc with no grant", async () => {
    const ids = await feedIds(buildApp({ who: "u-tom", role: "member", accessible: new Set(["d-rfc"]) }));
    expect(ids).not.toContain("e-secret"); // restricted doc, no grant → hidden
  });

  test("AS-029: a member SEES an event on an anyone_in_workspace doc they can open", async () => {
    const ids = await feedIds(buildApp({ who: "u-tom", role: "member", accessible: new Set(["d-rfc"]) }));
    expect(ids).toContain("e-rfc"); // membership grants the anyone_in_workspace doc — the common case
  });

  test("AS-009: a member sees a workspace-level event (docId null) regardless of doc access", async () => {
    // Member can open NO doc — the docId-null member-joined event is still visible.
    const ids = await feedIds(buildApp({ who: "u-tom", role: "member", accessible: new Set() }));
    expect(ids).toEqual(["e-join"]); // only the workspace-level event survives
  });

  test("C-003: the visible feed `total` counts only VISIBLE rows (filtered before paging)", async () => {
    const app = buildApp({ who: "u-tom", role: "member", accessible: new Set(["d-rfc"]) });
    const json = (await (await app.handle(req("/api/w/ws-1/activity"))).json()) as any;
    // Tom sees e-rfc + e-join (not e-secret) → total 2, not the raw 3.
    expect(json.data.pagination.total).toBe(2);
    expect(json.data.items).toHaveLength(2);
  });
});

describe("activity event detail visibility — detail-url (workspace-activity S-002)", () => {
  test("AS-010: a member opening a hidden event's detail gets NOT-FOUND (not forbidden)", async () => {
    const app = buildApp({ who: "u-tom", role: "member", accessible: new Set(["d-rfc"]) });
    const res = await app.handle(req("/api/w/ws-1/activity/e-secret")); // the hidden restricted-doc event
    expect(res.status).toBe(404); // existence-hiding — NOT 403
  });

  test("a member CAN open the detail of an event they can see", async () => {
    const app = buildApp({ who: "u-tom", role: "member", accessible: new Set(["d-rfc"]) });
    const res = await app.handle(req("/api/w/ws-1/activity/e-rfc"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.event.id).toBe("e-rfc");
  });

  test("an admin can open the detail of a restricted-doc event (AS-007 detail side)", async () => {
    const app = buildApp({ who: "u-mara", role: "admin", accessible: new Set() });
    const res = await app.handle(req("/api/w/ws-1/activity/e-secret"));
    expect(res.status).toBe(200);
  });

  test("a non-existent event id is NOT-FOUND (same shape as a hidden one — existence-hiding)", async () => {
    const app = buildApp({ who: "u-mara", role: "admin", accessible: new Set() });
    expect((await app.handle(req("/api/w/ws-1/activity/nope"))).status).toBe(404);
  });
});

describe("activity visibility — read-time + cross-surface + cross-workspace (S-002)", () => {
  test("AS-030: tightening a doc after emit hides its event in BOTH the feed and the detail (read-time, F-2)", async () => {
    const accessible = new Set<string>(["d-rfc", "d-secret"]); // Tom can see e-secret at first
    const repo = memActivityRepo(SEED);
    const app = createApp({
      dbCheck: async () => {},
      activity: {
        repo,
        resolveSession: asUser("u-tom"),
        resolveWorkspaceRole: async () => "member",
        // resolveAccess READS the live set on every call → flipping it models the doc going restricted.
        resolveAccess: async (docId) => (accessible.has(docId) ? { role: "viewer", canView: true } : { role: null, canView: false }),
      },
    });

    // Before: Tom sees e-secret in the feed and can open its detail.
    expect(await feedIds(app)).toContain("e-secret");
    expect((await app.handle(req("/api/w/ws-1/activity/e-secret"))).status).toBe(200);

    // The doc is set restricted and Tom is not invited — current access tightened.
    accessible.delete("d-secret");

    // After (same read surfaces, re-read): the event is gone from the feed AND its detail 404s.
    expect(await feedIds(app)).not.toContain("e-secret");
    expect((await app.handle(req("/api/w/ws-1/activity/e-secret"))).status).toBe(404);
  });

  test("C-003: feed-list and detail-url agree — every fed-back row is openable, every hidden row 404s", async () => {
    const app = buildApp({ who: "u-tom", role: "member", accessible: new Set(["d-rfc"]) });
    const shown = new Set(await feedIds(app));
    for (const row of SEED) {
      const status = (await app.handle(req(`/api/w/ws-1/activity/${row.id}`))).status;
      // The two surfaces route through the ONE gate: in the feed ⇔ detail 200; hidden ⇔ detail 404.
      expect(status).toBe(shown.has(row.id) ? 200 : 404);
    }
  });

  test("C-008: an event whose doc the member can't access never surfaces, scoped by the path workspaceId", async () => {
    // Member can open no doc; the read is path-scoped to ws-1 AND each doc-scoped row is gated by
    // resolveAccess (anchored to the doc's own workspace). Only the workspace-level row surfaces.
    const ids = await feedIds(buildApp({ who: "u-tom", role: "member", accessible: new Set() }));
    expect(ids).toEqual(["e-join"]);
    // And a doc-scoped event's detail in this workspace is 404 for the member (can't access the doc).
    const app = buildApp({ who: "u-tom", role: "member", accessible: new Set() });
    expect((await app.handle(req("/api/w/ws-1/activity/e-secret"))).status).toBe(404);
  });

  test("a workspace's feed never includes another workspace's rows (path workspaceId scope, C-008)", async () => {
    const mixed = memActivityRepo([
      ...SEED,
      { id: "e-other", workspaceId: "ws-2", type: "comment", actorUserId: "u-z", actorName: "Z", docId: "d-other", summary: "commented on", target: "Other ws doc", createdAt: new Date(2026, 5, 23, 10, 0, 0) },
    ]);
    const app = buildApp({ who: "u-mara", role: "admin", accessible: new Set(), repo: mixed });
    expect(await feedIds(app)).not.toContain("e-other"); // ws-2 row absent from ws-1's feed even for an admin
  });
});
