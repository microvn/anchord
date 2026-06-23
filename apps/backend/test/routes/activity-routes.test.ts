// In-process route tests for the workspace activity feed (workspace-activity S-001).
//
// HTTP GLUE only — envelope + session gate + workspace gate + pagination over an in-memory
// ActivityRepo, plus the best-effort emit on the comment route (AS-006). No real Postgres.
//
// AS map:
//   AS-001  the newest feed row reads that the actor commented (a comment emit lands as row 1)
//   AS-003  25 events, page 1 = 20 most-recent, page 2 = remaining 5 (default 20 / cap 50, C-007)
//   AS-004  a fresh workspace (zero rows) → empty page (the FE renders "No activity yet")
//   AS-006  a failed activity write never blocks the comment (best-effort post-commit)
//   C-007   recent-first, default 20, cap 50

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { SessionResolver } from "../../src/http/auth-gate";
import type { ActivityRepo, ActivityRow, NewActivity } from "../../src/activity/repo";
import type { Role } from "../../src/sharing/roles";
import type { DocLookup, DocLookupRepo } from "../../src/routes/versions";
import type { AnnotationLookupRepo } from "../../src/routes/annotations";
import type { CommentRepo, CommentRow, NewComment } from "../../src/annotation/reply";

const asUser = (userId: string): SessionResolver => async () => ({ userId });
const noSession: SessionResolver = async () => null;

// In-memory activity repo mirroring the Drizzle repo's filter + recent-first contract.
function memActivityRepo(seed: (NewActivity & { id: string; createdAt: Date })[] = []): ActivityRepo & {
  rows: (NewActivity & { id: string; createdAt: Date })[];
} {
  const rows = [...seed];
  let n = seed.length;
  const matches = (r: NewActivity, f: { workspaceId?: string; actorUserId?: string }) =>
    (f.workspaceId == null || r.workspaceId === f.workspaceId) &&
    (f.actorUserId == null || r.actorUserId === f.actorUserId);
  const sorted = (f: { workspaceId?: string; actorUserId?: string }) =>
    rows
      .filter((r) => matches(r, f))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
  return {
    rows,
    async insertActivity(input) {
      const id = `act-${++n}`;
      rows.push({ ...input, id, createdAt: new Date() });
      return { id };
    },
    async countActivity(filter) {
      return sorted(filter).length;
    },
    async listActivity(filter, { offset, limit }) {
      return sorted(filter).slice(offset, offset + limit) as unknown as ActivityRow[];
    },
    async listAllActivity(filter) {
      return sorted(filter) as unknown as ActivityRow[];
    },
    async getActivityById(filter, id) {
      return (sorted(filter).find((r) => r.id === id) as unknown as ActivityRow) ?? null;
    },
    async listRelatedByDoc(filter, docId, opts) {
      return sorted(filter)
        .filter((r) => r.docId === docId && r.id !== opts?.excludeId)
        .slice(0, opts?.limit ?? 5) as unknown as ActivityRow[];
    },
  };
}

function req(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

// ── feed read ───────────────────────────────────────────────────────────────

function buildFeedApp(resolveSession: SessionResolver, repo: ActivityRepo) {
  return createApp({
    dbCheck: async () => {},
    activity: { repo, resolveSession, resolveWorkspaceRole: async () => "member" },
  });
}

/** N rows in a workspace with strictly increasing timestamps (newest = highest index). */
function activityRows(workspaceId: string, n: number): (NewActivity & { id: string; createdAt: Date })[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `e${String(i).padStart(3, "0")}`,
    workspaceId,
    type: "comment" as const,
    actorUserId: "u-devin",
    actorName: "Devin",
    docId: "d-1",
    summary: "commented on",
    target: "Render + publish pipeline RFC",
    createdAt: new Date(2026, 5, 23, 9, 0, i), // ascending; e024 is newest
  }));
}

describe("GET /api/w/:workspaceId/activity feed (workspace-activity S-001)", () => {
  test("AS-001: the newest feed row reads that Devin commented on the doc", async () => {
    const repo = memActivityRepo([
      {
        id: "older",
        workspaceId: "ws-1",
        type: "comment",
        actorUserId: "u-x",
        actorName: "Someone Else",
        docId: "d-old",
        summary: "commented on",
        target: "Old doc",
        createdAt: new Date(2026, 5, 22, 9, 0, 0),
      },
      {
        id: "newest",
        workspaceId: "ws-1",
        type: "comment",
        actorUserId: "u-devin",
        actorName: "Devin",
        docId: "d-rfc",
        summary: "commented on",
        target: "Render + publish pipeline RFC",
        createdAt: new Date(2026, 5, 23, 12, 0, 0),
      },
    ]);
    const app = buildFeedApp(asUser("u-mara"), repo);
    const res = await app.handle(req("/api/w/ws-1/activity"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    const items = json.data.items as ActivityRow[];
    expect(items[0].id).toBe("newest"); // recent-first
    expect(items[0].actorName).toBe("Devin");
    expect(items[0].type).toBe("comment");
    expect(items[0].summary).toBe("commented on");
    expect(items[0].target).toBe("Render + publish pipeline RFC");
  });

  test("AS-003 / C-007: 25 events → page 1 = 20 most-recent, page 2 = remaining 5 older", async () => {
    const repo = memActivityRepo(activityRows("ws-1", 25));
    const app = buildFeedApp(asUser("u-mara"), repo);
    const p1 = (await (await app.handle(req("/api/w/ws-1/activity"))).json()) as any;
    expect(p1.data.items).toHaveLength(20); // default page size 20 (C-007)
    expect(p1.data.pagination.total).toBe(25);
    expect(p1.data.pagination.limit).toBe(20);
    expect(p1.data.pagination.hasNext).toBe(true);
    expect(p1.data.items[0].id).toBe("e024"); // newest leads
    const p2 = (await (await app.handle(req("/api/w/ws-1/activity?page=2"))).json()) as any;
    expect(p2.data.items).toHaveLength(5); // the remaining 5 older events
    expect(p2.data.pagination.hasNext).toBe(false);
  });

  test("C-007: limit over the cap is clamped to 50, not rejected", async () => {
    const repo = memActivityRepo(activityRows("ws-1", 60));
    const app = buildFeedApp(asUser("u-mara"), repo);
    const json = (await (await app.handle(req("/api/w/ws-1/activity?limit=999"))).json()) as any;
    expect(json.data.pagination.limit).toBe(50); // clamped to maxLimit
    expect(json.data.items).toHaveLength(50);
  });

  test("AS-004: a fresh workspace (zero activity) returns an empty page", async () => {
    const repo = memActivityRepo([]);
    const app = buildFeedApp(asUser("u-mara"), repo);
    const json = (await (await app.handle(req("/api/w/ws-1/activity"))).json()) as any;
    expect(json.data.items).toHaveLength(0);
    expect(json.data.pagination.total).toBe(0);
  });

  test("a non-member / no session is gated (404 non-member, 401 no session)", async () => {
    const repo = memActivityRepo(activityRows("ws-1", 1));
    // non-member: resolveWorkspaceRole → null → existence-hiding 404
    const nonMember = createApp({
      dbCheck: async () => {},
      activity: { repo, resolveSession: asUser("u-x"), resolveWorkspaceRole: async () => null },
    });
    expect((await nonMember.handle(req("/api/w/ws-1/activity"))).status).toBe(404);
    const anon = buildFeedApp(noSession, repo);
    expect((await anon.handle(req("/api/w/ws-1/activity"))).status).toBe(401);
  });
});

// ── best-effort emit on the comment route (AS-006) ────────────────────────────

const VISIBLE_DOC: DocLookup = {
  id: "doc_1",
  title: "Render + publish pipeline RFC",
  kind: "markdown",
  generalAccess: "anyone_with_link",
};

function fakeCommentRepo(seed: CommentRow[]): CommentRepo {
  const rows = [...seed];
  let n = 0;
  return {
    async listByAnnotation(annotationId) {
      return rows.filter((c) => c.annotationId === annotationId);
    },
    async insertComment(input: NewComment) {
      const id = `c_${++n}`;
      rows.push({ id, ...input });
      return { id };
    },
  };
}

function fakeLookupRepo(doc: DocLookup | null): DocLookupRepo {
  return {
    async findDocBySlug() {
      return doc;
    },
    async getVersionContent() {
      return null;
    },
  };
}

function fakeAnnotationLookupRepo(): AnnotationLookupRepo {
  return {
    async findAnnotationDoc() {
      return { docId: VISIBLE_DOC.id, generalAccess: VISIBLE_DOC.generalAccess, authorId: null };
    },
    async findSuggestionDoc() {
      return null;
    },
    async getCurrentVersionContent() {
      return null;
    },
    async getCurrentVersion() {
      return null;
    },
  };
}

// An activity repo whose insert ALWAYS throws — to prove the comment still succeeds (AS-006).
function throwingActivityRepo(): ActivityRepo {
  return {
    async insertActivity() {
      throw new Error("activity write unavailable");
    },
    async countActivity() {
      return 0;
    },
    async listActivity() {
      return [];
    },
    async listAllActivity() {
      return [];
    },
    async getActivityById() {
      return null;
    },
    async listRelatedByDoc() {
      return [];
    },
  };
}

describe("comment route emits activity best-effort (workspace-activity S-001, AS-006)", () => {
  function buildCommentApp(activityRepo: ActivityRepo, recorder?: NewActivity[]) {
    const repo: ActivityRepo = recorder
      ? {
          async insertActivity(input) {
            recorder.push(input);
            return { id: `a-${recorder.length}` };
          },
          async countActivity() {
            return recorder.length;
          },
          async listActivity() {
            return [];
          },
          async listAllActivity() {
            return [];
          },
          async getActivityById() {
            return null;
          },
          async listRelatedByDoc() {
            return [];
          },
        }
      : activityRepo;
    return createApp({
      dbCheck: async () => {},
      annotations: {
        commentRepo: fakeCommentRepo([]),
        annotationRepo: { async insertAnnotation() { return { id: "x" }; }, async insertAnnotationWithComment() { return { id: "x" }; }, async listByDoc() { return []; }, async listCommentsByDoc() { return []; } },
        guestCommentRepo: { async listByAnnotation() { return []; }, async insertComment() { return { id: "g" }; } },
        resolutionRepo: { async setAnnotationStatus() {}, async resetSuggestionStatusToPending() {} },
        deleteRepo: { async setDeletedAt() {} },
        restoreRepo: { async clearDeletedAt() {} },
        dismissReattachRepo: { async dismiss() {}, async reattach() {} },
        suggestionRepo: { async insertSuggestion() { return { id: "s" }; }, async getSuggestion() { return null; }, async setSuggestionStatus() {} },
        lookupRepo: fakeLookupRepo(VISIBLE_DOC),
        annotationLookupRepo: fakeAnnotationLookupRepo(),
        resolveSession: asUser("u-devin"),
        resolveWorkspaceRole: async () => "member",
        resolveDocRole: async (): Promise<Role | null> => "commenter",
        resolveAccess: async () => ({ role: "commenter" as Role, canView: true }),
        activity: {
          repo,
          workspaceOfDoc: async () => "ws-1",
          resolveActorName: async () => "Devin",
        },
      },
    });
  }

  test("AS-006: a failed activity write never blocks the comment — the comment still 201s", async () => {
    const app = buildCommentApp(throwingActivityRepo());
    const res = await app.handle(
      req("/api/w/ws-1/annotations/ann_1/comments", {
        method: "POST",
        body: JSON.stringify({ body: "Looks good" }),
      }),
    );
    // The activity emit threw, but the comment persisted → 201 (best-effort post-commit, C-002).
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).data.commentId).toBeTruthy();
  });

  test("AS-001 (emit side): a successful comment writes a `comment` activity row for the doc's workspace", async () => {
    const recorded: NewActivity[] = [];
    const app = buildCommentApp(throwingActivityRepo(), recorded);
    const res = await app.handle(
      req("/api/w/ws-1/annotations/ann_1/comments", {
        method: "POST",
        body: JSON.stringify({ body: "Looks good" }),
      }),
    );
    expect(res.status).toBe(201);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].type).toBe("comment"); // top-level comment on an existing annotation
    expect(recorded[0].workspaceId).toBe("ws-1"); // C-008: from workspaceOfDoc
    expect(recorded[0].actorName).toBe("Devin");
    expect(recorded[0].docId).toBe(VISIBLE_DOC.id);
  });
});
