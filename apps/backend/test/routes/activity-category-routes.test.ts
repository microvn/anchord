// In-process route tests for the category-filtered activity feed (workspace-activity S-003 / C-003).
//
// S-003 adds a `category` query param (All/Comments/Versions/Sharing/People) + per-category counts
// to the SAME feed route. The counts and the filtered page are BOTH derived from the one visible
// set the shared visibility gate produces — so a count can never reveal an event the viewer can't
// see (AS-012). No real Postgres; the same in-memory repo + fake resolveAccess as the S-002 tests.
//
// AS map:
//   AS-011  Versions filter returns only publish/restore events
//   AS-012  category counts exclude events on docs the member can't access (counts over visible set)
//   C-003   counts route through the SAME shared gate as the feed (reuse, not a parallel filter)

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

let t = 0;
const at = () => new Date(2026, 5, 23, 9, 0, t++);
const ev = (id: string, type: NewActivity["type"], docId: string | null): Seed => ({
  id,
  workspaceId: "ws-1",
  type,
  actorUserId: "u-x",
  actorName: "X",
  docId,
  createdAt: at(),
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

describe("activity feed category filter — S-003", () => {
  // A mixed feed on accessible docs: comments, publishes, restores, and shares.
  const MIXED: Seed[] = [
    ev("c1", "comment", "d-rfc"),
    ev("c2", "reply", "d-rfc"),
    ev("p1", "publish", "d-rfc"),
    ev("r1", "restore", "d-rfc"),
    ev("s1", "share", "d-rfc"),
  ];

  test("AS-011: the Versions filter returns ONLY publish/restore events", async () => {
    const app = buildApp({ who: "u-mara", role: "admin", accessible: new Set(["d-rfc"]), seed: MIXED });
    const json = await get(app, "/api/w/ws-1/activity?category=versions");
    const types = (json.data.items as ActivityRow[]).map((r) => r.type).sort();
    expect(types).toEqual(["publish", "restore"]);
    expect(json.data.pagination.total).toBe(2); // total reflects the filtered set, not the raw feed
  });

  test("AS-011: no category (default 'all') returns everything", async () => {
    const app = buildApp({ who: "u-mara", role: "admin", accessible: new Set(["d-rfc"]), seed: MIXED });
    const json = await get(app, "/api/w/ws-1/activity");
    expect(json.data.items).toHaveLength(5);
    expect(json.data.category).toBe("all");
  });

  test("AS-011: an unknown category falls back to 'all' (filter is a narrowing, never an error)", async () => {
    const app = buildApp({ who: "u-mara", role: "admin", accessible: new Set(["d-rfc"]), seed: MIXED });
    const json = await get(app, "/api/w/ws-1/activity?category=bogus");
    expect(json.data.items).toHaveLength(5);
    expect(json.data.category).toBe("all");
  });

  test("the feed always returns per-category counts alongside the page", async () => {
    const app = buildApp({ who: "u-mara", role: "admin", accessible: new Set(["d-rfc"]), seed: MIXED });
    const json = await get(app, "/api/w/ws-1/activity?category=versions");
    // Counts are over the FULL visible set, independent of the active filter (so every segment label
    // shows its own count even while Versions is selected).
    expect(json.data.counts).toEqual({ all: 5, comments: 2, versions: 2, sharing: 1, people: 0 });
  });
});

describe("activity category counts respect visibility — AS-012 / C-003", () => {
  // d-secret is a restricted doc with 3 comment events Tom can't see; d-rfc has 1 comment he can.
  const SEED: Seed[] = [
    ev("sec1", "comment", "d-secret"),
    ev("sec2", "comment", "d-secret"),
    ev("sec3", "comment", "d-secret"),
    ev("rfc1", "comment", "d-rfc"),
    ev("join", "member", null),
  ];

  test("AS-012: a member's counts EXCLUDE events on docs they can't access (counts over the visible set, shared gate)", async () => {
    // Tom (member) can open d-rfc but NOT d-secret. The counts must reflect only his visible set:
    // 1 visible comment (rfc1) + 1 workspace-level member event (join) = all:2, comments:1, people:1.
    const app = buildApp({ who: "u-tom", role: "member", accessible: new Set(["d-rfc"]), seed: SEED });
    const json = await get(app, "/api/w/ws-1/activity");
    expect(json.data.counts).toEqual({ all: 2, comments: 1, versions: 0, sharing: 0, people: 1 });
    // The 3 restricted-doc comment events never leak into the comments count.
    expect(json.data.counts.comments).toBe(1);
  });

  test("AS-012: an admin sees the same counts include the restricted-doc events (counts route through the shared gate)", async () => {
    // The admin sees all 5 → comments:4 (3 secret + 1 rfc), people:1. Same gate, different role.
    const app = buildApp({ who: "u-mara", role: "admin", accessible: new Set(), seed: SEED });
    const json = await get(app, "/api/w/ws-1/activity");
    expect(json.data.counts).toEqual({ all: 5, comments: 4, versions: 0, sharing: 0, people: 1 });
  });
});
