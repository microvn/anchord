// In-process route tests for the personal "Your actions" feed (your-activity-actions S-001).
//
// HTTP GLUE over the cross-workspace own-actions read: GET /api/me/activity returns the SESSION
// caller's own actions (C-001 — never a client-supplied actorUserId; null-actor rows never match),
// across their CURRENT-member workspaces (C-006), recent-first + paginated (C-003). C-002: a row
// whose target doc the caller can no longer access STILL lists, but its target-derived display is
// genericized (never dropped — the difference from the workspace feed). No real Postgres — the read
// repo is faked in-memory; resolveAccess is a fake set so the genericize is exercised.
//
// AS map:
//   AS-001  my publish appears, with from→to + adds/dels from meta, newest-first
//   AS-002  actions span every current workspace, each carrying its workspaceName label
//   AS-004  pages older actions — page 1 = 20 newest, page 2 = the remaining 5
//   AS-006  a lost-access row still lists, but every target-derived display genericizes
//   AS-012  always the session caller's own rows only — a foreign ?actorUserId is ignored

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import { LOST_ACCESS_PLACEHOLDER } from "../../src/routes/me-activity";
import type { SessionResolver } from "../../src/http/auth-gate";
import type { ActorActivityRepo, ActorActivityRow } from "../../src/activity/list-for-actor";
import type { ResolveDocAccess } from "../../src/activity/visibility";

const asUser = (userId: string): SessionResolver => async () => ({ userId });

function req(path: string) {
  return new Request(`http://localhost${path}`, { headers: { "content-type": "application/json" } });
}

type Seed = ActorActivityRow;

function seedRow(over: Partial<Seed> & { id: string; actorUserId: string; workspaceId: string }): Seed {
  return {
    type: "comment",
    actorName: "Mara",
    workspaceName: "Acme Platform",
    docId: null,
    docSlug: null,
    projectId: null,
    versionId: null,
    commentId: null,
    annotationId: null,
    summary: "commented on",
    target: null,
    meta: null,
    createdAt: new Date(2026, 5, 24, 10, 0, 0),
    ...over,
  } as Seed;
}

// In-memory actor repo: filters to actorUserId (C-001 — a null-actor row never equals a real id),
// recent-first, paged. Mirrors the Drizzle createActorActivityRepo contract.
function memActorRepo(seed: Seed[]): ActorActivityRepo {
  const sorted = (actorUserId: string) =>
    seed
      .filter((r) => r.actorUserId === actorUserId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
  return {
    async countForActor(actorUserId) {
      return sorted(actorUserId).length;
    },
    async listForActor(actorUserId, { offset, limit }) {
      return sorted(actorUserId).slice(offset, offset + limit);
    },
  };
}

function buildApp(opts: { who: string; repo: ActorActivityRepo; resolveAccess?: ResolveDocAccess }) {
  return createApp({
    dbCheck: async () => {},
    meActivity: { repo: opts.repo, resolveSession: asUser(opts.who), resolveAccess: opts.resolveAccess },
  });
}

async function feed(app: ReturnType<typeof buildApp>, path = "/api/me/activity") {
  const json = (await (await app.handle(req(path))).json()) as any;
  return json.data;
}

describe("personal Your-actions feed (your-activity-actions S-001)", () => {
  test("AS-001: my publish appears in Your actions — newest, with from→to + adds/dels from meta", async () => {
    const seed = [
      seedRow({
        id: "e-pub",
        actorUserId: "u-mara",
        workspaceId: "ws-acme",
        workspaceName: "Acme Platform",
        type: "publish",
        docId: "d-web",
        summary: "published",
        target: "v4",
        meta: { from: 3, to: 4, adds: 5, dels: 2 },
        createdAt: new Date(2026, 5, 24, 12, 0, 0),
      }),
      seedRow({ id: "e-old", actorUserId: "u-mara", workspaceId: "ws-acme", createdAt: new Date(2026, 5, 24, 8, 0, 0) }),
    ];
    const data = await feed(buildApp({ who: "u-mara", repo: memActorRepo(seed) }));
    expect(data.items[0].id).toBe("e-pub"); // newest-first
    expect(data.items[0].type).toBe("publish");
    expect(data.items[0].meta).toEqual({ from: 3, to: 4, adds: 5, dels: 2 });
  });

  test("AS-002: actions span every current workspace, each labeled with its workspaceName", async () => {
    const seed = [
      seedRow({
        id: "e-acme",
        actorUserId: "u-mara",
        workspaceId: "ws-acme",
        workspaceName: "Acme Platform",
        type: "publish",
        createdAt: new Date(2026, 5, 24, 12, 0, 0),
      }),
      seedRow({
        id: "e-field",
        actorUserId: "u-mara",
        workspaceId: "ws-field",
        workspaceName: "Field IO",
        type: "comment",
        createdAt: new Date(2026, 5, 24, 11, 0, 0),
      }),
    ];
    const data = await feed(buildApp({ who: "u-mara", repo: memActorRepo(seed) }));
    const byId = Object.fromEntries(data.items.map((r: any) => [r.id, r]));
    expect(byId["e-acme"].workspaceName).toBe("Acme Platform");
    expect(byId["e-field"].workspaceName).toBe("Field IO");
    expect(data.items).toHaveLength(2); // both workspaces in ONE feed
  });

  test("AS-004: pages older actions — page 1 = 20 newest, page 2 = the remaining 5", async () => {
    const seed = Array.from({ length: 25 }, (_, i) =>
      seedRow({
        id: `e-${String(i).padStart(2, "0")}`,
        actorUserId: "u-mara",
        workspaceId: "ws-acme",
        // i=0 oldest … i=24 newest
        createdAt: new Date(2026, 5, 1 + i, 9, 0, 0),
      }),
    );
    const app = buildApp({ who: "u-mara", repo: memActorRepo(seed) });
    const p1 = await feed(app, "/api/me/activity?page=1&limit=20");
    expect(p1.items).toHaveLength(20);
    expect(p1.pagination.total).toBe(25);
    expect(p1.pagination.hasNext).toBe(true);
    expect(p1.items[0].id).toBe("e-24"); // newest first
    const p2 = await feed(app, "/api/me/activity?page=2&limit=20");
    expect(p2.items).toHaveLength(5);
    expect(p2.pagination.hasNext).toBe(false);
  });

  test("AS-006: a lost-access action still lists, but every target-derived display genericizes (C-002)", async () => {
    const seed = [
      seedRow({
        id: "e-lost",
        actorUserId: "u-mara",
        workspaceId: "ws-acme",
        type: "comment",
        docId: "d-secret",
        projectId: "p-secret",
        target: "§Pricing",
        summary: "commented on",
        meta: { quote: "the secret pricing table", body: "looks off" },
        createdAt: new Date(2026, 5, 24, 12, 0, 0),
      }),
    ];
    // resolveAccess DENIES d-secret → the row's doc-derived display must genericize, row stays.
    const denyAll: ResolveDocAccess = async () => ({ role: null, canView: false });
    const data = await feed(buildApp({ who: "u-mara", repo: memActorRepo(seed), resolveAccess: denyAll }));
    expect(data.items).toHaveLength(1); // NOT dropped — it's my own history
    const row = data.items[0];
    expect(row.id).toBe("e-lost");
    expect(row.docTitle).toBe(LOST_ACCESS_PLACEHOLDER); // genericized, never the real title
    expect(row.target).toBeNull(); // section text removed
    expect(row.projectName).toBeNull();
    // The quote/body (current content) is stripped from meta — no leak.
    expect((row.meta ?? {}).quote).toBeUndefined();
    expect((row.meta ?? {}).body).toBeUndefined();
  });

  test("AS-006: a row whose doc IS still accessible keeps its real display (genericize only on deny)", async () => {
    const seed = [
      seedRow({
        id: "e-ok",
        actorUserId: "u-mara",
        workspaceId: "ws-acme",
        type: "comment",
        docId: "d-open",
        target: "§Intro",
        createdAt: new Date(2026, 5, 24, 12, 0, 0),
      }),
    ];
    const allow: ResolveDocAccess = async () => ({ role: "viewer", canView: true });
    const data = await feed(buildApp({ who: "u-mara", repo: memActorRepo(seed), resolveAccess: allow }));
    expect(data.items[0].target).toBe("§Intro"); // accessible → no genericize
    expect(data.items[0].docTitle).not.toBe(LOST_ACCESS_PLACEHOLDER);
  });

  test("AS-005: an accessible doc-backed row returns its docSlug for 'Open in doc'; a lost-access row returns null (C-002)", async () => {
    const seed = [
      seedRow({
        id: "e-ok",
        actorUserId: "u-mara",
        workspaceId: "ws-acme",
        type: "comment",
        docId: "d-open",
        docSlug: "web-core-behavior-contract", // BE joined the live slug for an accessible doc-backed row
        annotationId: "anno-7",
        createdAt: new Date(2026, 5, 24, 12, 0, 0),
      }),
      seedRow({
        id: "e-lost",
        actorUserId: "u-mara",
        workspaceId: "ws-acme",
        type: "comment",
        docId: "d-secret",
        docSlug: "secret-doc", // joined slug exists, but access is lost → must be nulled (C-002)
        createdAt: new Date(2026, 5, 24, 11, 0, 0),
      }),
    ];
    // Allow d-open, deny d-secret — the genericize path nulls docSlug only on deny.
    const access: ResolveDocAccess = async (docId) =>
      docId === "d-open" ? { role: "viewer", canView: true } : { role: null, canView: false };
    const data = await feed(buildApp({ who: "u-mara", repo: memActorRepo(seed), resolveAccess: access }));
    const byId = Object.fromEntries(data.items.map((r: any) => [r.id, r]));
    expect(byId["e-ok"].docSlug).toBe("web-core-behavior-contract"); // accessible → "Open in doc" links
    expect(byId["e-lost"].docSlug).toBeNull(); // lost access → no deep-link (C-002)
  });

  test("AS-012: always the session caller's own rows only — a foreign ?actorUserId is ignored (no IDOR)", async () => {
    const seed = [
      seedRow({ id: "e-mara", actorUserId: "u-mara", workspaceId: "ws-acme" }),
      seedRow({ id: "e-devin", actorUserId: "u-devin", workspaceId: "ws-acme" }),
      // a null-actor (System/guest) row — must NEVER match the caller (C-001).
      seedRow({ id: "e-system", actorUserId: "u-mara", workspaceId: "ws-acme" }),
    ];
    // Signed in as Mara; the request carries a crafted ?actorUserId=u-devin.
    const data = await feed(
      buildApp({ who: "u-mara", repo: memActorRepo(seed) }),
      "/api/me/activity?actorUserId=u-devin",
    );
    const ids = data.items.map((r: any) => r.actorUserId);
    expect(ids.every((a: string) => a === "u-mara")).toBe(true); // ONLY Mara's rows
    expect(data.items.find((r: any) => r.id === "e-devin")).toBeUndefined();
  });
});
