// In-process route tests for the activity event DETAIL surface (workspace-activity S-004).
//
// S-004 adds the "More on this doc" related-events read + an enriched single-event detail (the doc
// slug for the "Open doc" deep-link). Both reuse the SHARED visibility gate (C-003) so related rows
// are access-filtered the same way the feed is, and a deleted doc's row still gates (C-001 / F-1).
//
// AS map:
//   AS-014  detail returns the event's stored metadata (actor / doc / project / version / when)
//   AS-018  a deleted-target event still renders from its stored fields; "Open doc" degrades (no slug)
//   C-001   the activity row survives an underlying delete; docId is RETAINED so the gate still hides it
//   C-003   "more on this doc" related events are filtered through the SAME visibility gate

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

// In-memory repo mirroring the Drizzle contract incl. S-004's listRelatedByDoc.
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
      const limit = opts?.limit ?? 5;
      return sorted(f)
        .filter((r) => r.docId === docId && r.id !== opts?.excludeId)
        .slice(0, limit) as unknown as ActivityRow[];
    },
  };
}

// d-rfc = anyone_in_workspace (member can open); d-secret = restricted (member can't).
const PUBLISH_META = { from: "v3", to: "v4", adds: 5, dels: 2 };
const SEED: Seed[] = [
  { id: "e-pub", workspaceId: "ws-1", type: "publish", actorUserId: "u-devin", actorName: "Devin", docId: "d-rfc", projectId: "p-web", versionId: "ver-4", summary: "published", target: "Render pipeline RFC", meta: PUBLISH_META, createdAt: new Date(2026, 5, 23, 9, 0, 5) },
  { id: "e-c1", workspaceId: "ws-1", type: "comment", actorUserId: "u-mara", actorName: "Mara", docId: "d-rfc", summary: "commented on", target: "Render pipeline RFC", createdAt: new Date(2026, 5, 23, 9, 0, 4) },
  { id: "e-c2", workspaceId: "ws-1", type: "reply", actorUserId: "u-tom", actorName: "Tom", docId: "d-rfc", summary: "replied on", target: "Render pipeline RFC", createdAt: new Date(2026, 5, 23, 9, 0, 3) },
  { id: "e-other", workspaceId: "ws-1", type: "comment", actorUserId: "u-x", actorName: "X", docId: "d-other", summary: "commented on", target: "Another doc", createdAt: new Date(2026, 5, 23, 9, 0, 2) },
  // A comment on the now-deleted doc d-secret (restricted). The comment/doc rows are gone, but the
  // activity row is intact with its original docId RETAINED (C-001 / F-1).
  { id: "e-del", workspaceId: "ws-1", type: "comment", actorUserId: "u-y", actorName: "Y", docId: "d-secret", commentId: null, summary: "commented on", target: "Secret roadmap", createdAt: new Date(2026, 5, 23, 9, 0, 1) },
];

function fakeResolveAccess(accessible: Set<string>): ResolveDocAccess {
  return async (docId) => (accessible.has(docId) ? { role: "viewer", canView: true } : { role: null, canView: false });
}

// resolveDocLink: maps a live docId → its slug (for the "Open doc" deep-link). A DELETED doc returns
// null (AS-018: "Open doc" degrades). d-secret is deleted here.
const docLinks: Record<string, { slug: string; projectName?: string } | null> = {
  "d-rfc": { slug: "render-pipeline-rfc", projectName: "web-core" },
  "d-other": { slug: "another-doc" },
  "d-secret": null,
};

function buildApp(opts: { who: string; role: "admin" | "member"; accessible: Set<string> }) {
  const resolveWorkspaceRole: WorkspaceRoleResolver = async () => opts.role;
  return createApp({
    dbCheck: async () => {},
    activity: {
      repo: memActivityRepo(SEED),
      resolveSession: asUser(opts.who),
      resolveWorkspaceRole,
      resolveAccess: fakeResolveAccess(opts.accessible),
      resolveDocLink: async (docId: string) => docLinks[docId] ?? null,
    },
  });
}

describe("activity event detail (workspace-activity S-004)", () => {
  test("AS-014: the detail returns the event's stored metadata (actor / doc / project / version / when)", async () => {
    const app = buildApp({ who: "u-mara", role: "admin", accessible: new Set() });
    const res = await app.handle(req("/api/w/ws-1/activity/e-pub"));
    expect(res.status).toBe(200);
    const e = ((await res.json()) as any).data.event;
    expect(e.actorName).toBe("Devin");
    expect(e.target).toBe("Render pipeline RFC"); // document
    expect(e.projectId).toBe("p-web");
    expect(e.versionId).toBe("ver-4");
    expect(e.type).toBe("publish");
    expect(e.meta.from).toBe("v3");
    expect(e.meta.to).toBe("v4");
    expect(e.createdAt).toBeTruthy(); // when
  });

  test("AS-014 (Open-doc link): the detail carries the doc slug so the FE can deep-link to the viewer", async () => {
    const app = buildApp({ who: "u-mara", role: "admin", accessible: new Set() });
    const e = (((await (await app.handle(req("/api/w/ws-1/activity/e-pub"))).json()) as any).data.event);
    expect(e.docSlug).toBe("render-pipeline-rfc");
    expect(e.projectName).toBe("web-core");
  });

  test("AS-018: a deleted-target event still renders from its stored fields and 'Open doc' degrades (no slug)", async () => {
    // Admin opens the detail of the event whose doc (d-secret) was deleted; resolveDocLink → null.
    const app = buildApp({ who: "u-mara", role: "admin", accessible: new Set() });
    const res = await app.handle(req("/api/w/ws-1/activity/e-del"));
    expect(res.status).toBe(200); // C-001: the row survived the delete
    const e = ((await res.json()) as any).data.event;
    expect(e.actorName).toBe("Y"); // renders from stored fields
    expect(e.target).toBe("Secret roadmap");
    expect(e.docId).toBe("d-secret"); // F-1: docId RETAINED, not nulled
    expect(e.docSlug).toBeNull(); // "Open doc" degrades — no live slug to link to
  });

  test("AS-018 (no leak): the deleted doc's event keeps its docId so it stays HIDDEN from a member who lacked access", async () => {
    // The member can open no doc. d-secret's docId is retained → still gated → 404, never reclassified
    // as a workspace-level event the member could see.
    const app = buildApp({ who: "u-tom", role: "member", accessible: new Set(["d-rfc"]) });
    expect((await app.handle(req("/api/w/ws-1/activity/e-del"))).status).toBe(404);
  });
});

describe("activity 'more on this doc' related events (workspace-activity S-004 / C-003)", () => {
  test("AS-014 (related): related events on the SAME doc are returned, newest-first, excluding the event itself", async () => {
    const app = buildApp({ who: "u-mara", role: "admin", accessible: new Set() });
    const res = await app.handle(req("/api/w/ws-1/activity/e-pub/related"));
    expect(res.status).toBe(200);
    const ids = (((await res.json()) as any).data.items as ActivityRow[]).map((r) => r.id);
    expect(ids).toEqual(["e-c1", "e-c2"]); // both other d-rfc rows, recent-first; e-pub itself excluded
    expect(ids).not.toContain("e-other"); // a different doc's row is not "on this doc"
  });

  test("C-003: related events are filtered through the SAME visibility gate", async () => {
    // A member who can open d-rfc but NOT d-secret: opening e-pub's related (on d-rfc) shows the d-rfc
    // rows. We then prove the gate is applied: a related read for an event the member can't see 404s.
    const member = buildApp({ who: "u-tom", role: "member", accessible: new Set(["d-rfc"]) });
    const okIds = (((await (await member.handle(req("/api/w/ws-1/activity/e-pub/related"))).json()) as any).data.items as ActivityRow[]).map((r) => r.id);
    expect(okIds).toEqual(["e-c1", "e-c2"]);
    // The related read for a hidden event (its doc is restricted) is NOT-FOUND — same existence-hiding
    // as the detail, so a member can't enumerate a doc they can't access.
    expect((await member.handle(req("/api/w/ws-1/activity/e-del/related"))).status).toBe(404);
  });

  test("a workspace-level event (docId null) has no 'more on this doc' — returns an empty list", async () => {
    const app = createApp({
      dbCheck: async () => {},
      activity: {
        repo: memActivityRepo([
          { id: "e-join", workspaceId: "ws-1", type: "member", actorUserId: "u-p", actorName: "Priya", docId: null, summary: "joined the workspace", target: null, createdAt: new Date(2026, 5, 23, 9, 0, 9) },
        ]),
        resolveSession: asUser("u-mara"),
        resolveWorkspaceRole: async () => "admin",
        resolveAccess: fakeResolveAccess(new Set()),
      },
    });
    const res = await app.handle(req("/api/w/ws-1/activity/e-join/related"));
    expect(res.status).toBe(200);
    expect((((await res.json()) as any).data.items as ActivityRow[])).toHaveLength(0);
  });
});
