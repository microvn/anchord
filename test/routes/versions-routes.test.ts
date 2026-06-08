// In-process route tests for the versioning-diff /api/docs/:slug/... mounts (no DB).
//
// Exercise the HTTP GLUE only — envelope + auth gate + Zod validation + the
// existence-hiding (C-006) and editor (403) gates + the version/diff services —
// via app.handle(Request)→Response. Fake repos + a fake resolveSession + a fake
// resolveDocRole are injected so route→service runs without Postgres; the real-DB
// path is covered by test/integration/versions-routes.itest.ts.
//
// AS map (versioning-diff):
//   AS-001  POST versions → 201 { version, previousVersion } (append, no overwrite)
//   AS-002  PATCH title    → 200 { slug, title } and NO new version created
//   AS-003  GET versions   → 200 { items, pagination }
//   AS-004  POST restore   → 201 { version, previousVersion } (append-copy)
//   AS-006+ GET diff       → 200 { mode, ... }
//   (gates) no session → 401; not-editor → 403; missing/hidden doc → 404; bad query → 400

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { SessionResolver } from "../../src/http/auth-gate";
import type { Role } from "../../src/sharing/roles";
import type { VersionRepo, NewVersionRow } from "../../src/services/version";
import type { DocLookup, DocLookupRepo } from "../../src/routes/versions";

const member: SessionResolver = async () => ({ userId: "u_member" });
const noSession: SessionResolver = async () => null;
const asEditor = async (): Promise<Role | null> => "editor";
const asViewer = async (): Promise<Role | null> => "viewer";

const VISIBLE_DOC: DocLookup = {
  id: "doc_1",
  title: "Doc One",
  kind: "markdown",
  generalAccess: "anyone_with_link",
};

/** In-memory VersionRepo seeded with versions; records appends + title sets. */
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
        .map((r) => ({ version: r.version, createdAt: r.createdAt, publishedBy: r.publishedBy }));
    },
    async getVersion(_docId, version) {
      const hit = rows.find((r) => r.version === version);
      return hit ? { content: hit.content, contentHash: hit.contentHash } : null;
    },
  };
  return { repo, calls, rows };
}

function fakeLookupRepo(doc: DocLookup | null, versionRepo?: ReturnType<typeof fakeVersionRepo>): DocLookupRepo {
  return {
    async findDocBySlug(_slug) {
      return doc;
    },
    async getVersionContent(_docId, version) {
      if (!versionRepo) return null;
      return versionRepo.repo.getVersion("", version);
    },
  };
}

function buildApp(opts: {
  resolveSession?: SessionResolver;
  resolveDocRole?: (docId: string, userId: string) => Promise<Role | null>;
  doc?: DocLookup | null;
  versionRepo?: ReturnType<typeof fakeVersionRepo>;
  lookupRepo?: DocLookupRepo;
}) {
  const vr = opts.versionRepo ?? fakeVersionRepo();
  const lookup =
    opts.lookupRepo ?? fakeLookupRepo(opts.doc === undefined ? VISIBLE_DOC : opts.doc, vr);
  return createApp({
    dbCheck: async () => {},
    versions: {
      versionRepo: vr.repo,
      lookupRepo: lookup,
      resolveSession: opts.resolveSession ?? member,
      resolveDocRole: opts.resolveDocRole ?? asEditor,
      accessDeps: { isInvited: () => true, isWorkspaceMember: () => true },
    },
  });
}

function req(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("POST /api/docs/:slug/versions (AS-001)", () => {
  test("AS-001: editor appends version N+1 → 201 { version, previousVersion }", async () => {
    const vr = fakeVersionRepo([{ version: 1, content: "v1", contentHash: "h1" }]);
    const app = buildApp({ versionRepo: vr });
    const res = await app.handle(
      req("/api/docs/doc-one/versions", { method: "POST", body: JSON.stringify({ content: "v2" }) }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.data.version).toBe(2);
    expect(json.data.previousVersion).toBe(1);
    // v1 is NOT overwritten — a new row was inserted
    expect(vr.calls.inserts).toHaveLength(1);
    expect(vr.calls.inserts[0]?.version).toBe(2);
    // auth-routes S-003 / AS-006: published_by now records the session actor.
    expect(vr.calls.inserts[0]?.publishedBy).toBe("u_member");
  });

  test("AS-006: signed-in version create records the session actor as publisher", async () => {
    // user A is signed in and may edit → the appended version's published_by is A.
    const userA: SessionResolver = async () => ({ userId: "u_A" });
    const vr = fakeVersionRepo([{ version: 1, content: "v1", contentHash: "h1" }]);
    const app = buildApp({ resolveSession: userA, versionRepo: vr });
    const res = await app.handle(
      req("/api/docs/doc-one/versions", { method: "POST", body: JSON.stringify({ content: "v2" }) }),
    );
    expect(res.status).toBe(201);
    // The recorded publisher is the SESSION user A, not null.
    expect(vr.calls.inserts[0]?.publishedBy).toBe("u_A");
  });

  test("C-005: a forged publisher in the body is ignored — published_by is the session actor", async () => {
    // Body carries an attacker-supplied id; withValidation strips unknown keys and
    // the route reads identity only from the resolved actor → "u_A" wins.
    const userA: SessionResolver = async () => ({ userId: "u_A" });
    const vr = fakeVersionRepo([{ version: 1, content: "v1", contentHash: "h1" }]);
    const app = buildApp({ resolveSession: userA, versionRepo: vr });
    const res = await app.handle(
      req("/api/docs/doc-one/versions", {
        method: "POST",
        body: JSON.stringify({ content: "v2", publishedBy: "attacker", userId: "attacker" }),
      }),
    );
    expect(res.status).toBe(201);
    expect(vr.calls.inserts[0]?.publishedBy).toBe("u_A");
    expect(vr.calls.inserts[0]?.publishedBy).not.toBe("attacker");
  });

  test("no session → 401 UNAUTHENTICATED (handler never runs)", async () => {
    const vr = fakeVersionRepo([{ version: 1, content: "v1", contentHash: "h1" }]);
    const app = buildApp({ resolveSession: noSession, versionRepo: vr });
    const res = await app.handle(
      req("/api/docs/doc-one/versions", { method: "POST", body: JSON.stringify({ content: "v2" }) }),
    );
    expect(res.status).toBe(401);
    expect(vr.calls.inserts).toHaveLength(0);
  });

  test("not editor (viewer role) → 403 FORBIDDEN", async () => {
    const vr = fakeVersionRepo([{ version: 1, content: "v1", contentHash: "h1" }]);
    const app = buildApp({ resolveDocRole: asViewer, versionRepo: vr });
    const res = await app.handle(
      req("/api/docs/doc-one/versions", { method: "POST", body: JSON.stringify({ content: "v2" }) }),
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("FORBIDDEN");
    expect(vr.calls.inserts).toHaveLength(0);
  });

  test("missing doc → 404 NOT_FOUND (existence-hiding, write to invisible doc is 404 not 403)", async () => {
    const app = buildApp({ doc: null });
    const res = await app.handle(
      req("/api/docs/nope/versions", { method: "POST", body: JSON.stringify({ content: "v2" }) }),
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("no-access doc → 404 (not 403), even for would-be editor", async () => {
    // doc is restricted + accessDeps denies → canViewDoc false → 404 before role check
    const vr = fakeVersionRepo([{ version: 1, content: "v1", contentHash: "h1" }]);
    const app = createApp({
      dbCheck: async () => {},
      versions: {
        versionRepo: vr.repo,
        lookupRepo: fakeLookupRepo({ ...VISIBLE_DOC, generalAccess: "restricted" }, vr),
        resolveSession: member,
        resolveDocRole: asEditor,
        accessDeps: { isInvited: () => false, isWorkspaceMember: () => false },
      },
    });
    const res = await app.handle(
      req("/api/docs/doc-one/versions", { method: "POST", body: JSON.stringify({ content: "v2" }) }),
    );
    expect(res.status).toBe(404);
    expect(vr.calls.inserts).toHaveLength(0);
  });

  test("bad body (missing content) → 400 VALIDATION_ERROR", async () => {
    const app = buildApp({});
    const res = await app.handle(
      req("/api/docs/doc-one/versions", { method: "POST", body: JSON.stringify({ nope: 1 }) }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("PATCH /api/docs/:slug (AS-002 title-only, NO version)", () => {
  test("AS-002: editor updates title → 200 { slug, title } and NO version created", async () => {
    const vr = fakeVersionRepo([{ version: 1, content: "v1", contentHash: "h1" }]);
    const app = buildApp({ versionRepo: vr });
    const res = await app.handle(
      req("/api/docs/doc-one", { method: "PATCH", body: JSON.stringify({ title: "New Title" }) }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data).toEqual({ slug: "doc-one", title: "New Title" });
    expect(vr.calls.titles).toEqual(["New Title"]);
    // AS-002: doc_versions untouched — no insert happened
    expect(vr.calls.inserts).toHaveLength(0);
  });

  test("not editor → 403", async () => {
    const app = buildApp({ resolveDocRole: asViewer });
    const res = await app.handle(
      req("/api/docs/doc-one", { method: "PATCH", body: JSON.stringify({ title: "X" }) }),
    );
    expect(res.status).toBe(403);
  });

  test("missing doc → 404", async () => {
    const app = buildApp({ doc: null });
    const res = await app.handle(
      req("/api/docs/nope", { method: "PATCH", body: JSON.stringify({ title: "X" }) }),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /api/docs/:slug/versions (AS-003 history)", () => {
  test("AS-003: viewer lists history → 200 { items, pagination }", async () => {
    const vr = fakeVersionRepo([
      { version: 1, content: "v1", contentHash: "h1" },
      { version: 2, content: "v2", contentHash: "h2" },
    ]);
    const app = buildApp({ resolveDocRole: asViewer, versionRepo: vr });
    const res = await app.handle(req("/api/docs/doc-one/versions"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.items).toHaveLength(2);
    expect(json.data.items[1].isCurrent).toBe(true); // highest version is current
    expect(json.data.pagination.total).toBe(2);
    expect(json.data.pagination.page).toBe(1);
  });

  test("pagination: limit=1 page=2 returns second item only", async () => {
    const vr = fakeVersionRepo([
      { version: 1, content: "v1", contentHash: "h1" },
      { version: 2, content: "v2", contentHash: "h2" },
    ]);
    const app = buildApp({ resolveDocRole: asViewer, versionRepo: vr });
    const res = await app.handle(req("/api/docs/doc-one/versions?limit=1&page=2"));
    const json = (await res.json()) as any;
    expect(json.data.items).toHaveLength(1);
    expect(json.data.items[0].version).toBe(2);
    expect(json.data.pagination.hasPrevious).toBe(true);
  });

  test("missing doc → 404", async () => {
    const app = buildApp({ doc: null });
    const res = await app.handle(req("/api/docs/nope/versions"));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/docs/:slug/versions/:n/restore (AS-004)", () => {
  test("AS-004: editor restores v1 → appends v3 → 201 { version, previousVersion }", async () => {
    const vr = fakeVersionRepo([
      { version: 1, content: "old", contentHash: "h1" },
      { version: 2, content: "new", contentHash: "h2" },
    ]);
    const app = buildApp({ versionRepo: vr });
    const res = await app.handle(req("/api/docs/doc-one/versions/1/restore", { method: "POST" }));
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.data.version).toBe(3);
    expect(json.data.previousVersion).toBe(2);
    // append-copy: the new row carries v1's content verbatim
    expect(vr.calls.inserts[0]?.content).toBe("old");
    expect(vr.calls.inserts[0]?.contentHash).toBe("h1");
  });

  test("restore of a missing version of a VISIBLE doc → 404", async () => {
    const vr = fakeVersionRepo([{ version: 1, content: "old", contentHash: "h1" }]);
    const app = buildApp({ versionRepo: vr });
    const res = await app.handle(req("/api/docs/doc-one/versions/99/restore", { method: "POST" }));
    expect(res.status).toBe(404);
  });

  test("not editor → 403", async () => {
    const vr = fakeVersionRepo([{ version: 1, content: "old", contentHash: "h1" }]);
    const app = buildApp({ resolveDocRole: asViewer, versionRepo: vr });
    const res = await app.handle(req("/api/docs/doc-one/versions/1/restore", { method: "POST" }));
    expect(res.status).toBe(403);
  });

  test("malformed :n (0) → 400 VALIDATION_ERROR", async () => {
    const app = buildApp({});
    const res = await app.handle(req("/api/docs/doc-one/versions/0/restore", { method: "POST" }));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/docs/:slug/diff?from=&to= (AS-006/007/008)", () => {
  test("AS-006: text diff between two versions → 200 mode=text with changeCount", async () => {
    const vr = fakeVersionRepo([
      { version: 1, content: "line a", contentHash: "h1" },
      { version: 2, content: "line b", contentHash: "h2" },
    ]);
    const app = buildApp({ resolveDocRole: asViewer, versionRepo: vr });
    const res = await app.handle(req("/api/docs/doc-one/diff?from=1&to=2"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.mode).toBe("text");
    expect(json.data.changeCount).toBeGreaterThan(0);
    expect(json.data.renderPair).toHaveLength(2);
  });

  test("AS-007: identical versions (same hash) → identical:true, changeCount 0, render pair still emitted", async () => {
    const vr = fakeVersionRepo([
      { version: 1, content: "same", contentHash: "h1" },
      { version: 2, content: "same", contentHash: "h1" },
    ]);
    const app = buildApp({ resolveDocRole: asViewer, versionRepo: vr });
    const res = await app.handle(req("/api/docs/doc-one/diff?from=1&to=2"));
    const json = (await res.json()) as any;
    expect(json.data.identical).toBe(true);
    expect(json.data.changeCount).toBe(0);
    expect(json.data.renderPair).toHaveLength(2);
  });

  test("missing version ref of a visible doc → 404", async () => {
    const vr = fakeVersionRepo([{ version: 1, content: "x", contentHash: "h1" }]);
    const app = buildApp({ resolveDocRole: asViewer, versionRepo: vr });
    const res = await app.handle(req("/api/docs/doc-one/diff?from=1&to=99"));
    expect(res.status).toBe(404);
  });

  test("malformed query (from=abc) → 400 VALIDATION_ERROR", async () => {
    const vr = fakeVersionRepo([{ version: 1, content: "x", contentHash: "h1" }]);
    const app = buildApp({ resolveDocRole: asViewer, versionRepo: vr });
    const res = await app.handle(req("/api/docs/doc-one/diff?from=abc&to=2"));
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  test("missing doc → 404", async () => {
    const app = buildApp({ doc: null });
    const res = await app.handle(req("/api/docs/nope/diff?from=1&to=2"));
    expect(res.status).toBe(404);
  });
});
