// In-process route tests for the annotation-core /api mounts (no DB).
//
// Exercise the HTTP GLUE only — envelope + auth gate + Zod validation + the
// existence-hiding (C-006/AS-021) and capability (403) gates + the annotation
// services — via app.handle(Request)→Response. Fake repos + a fake resolveSession
// + a fake resolveDocRole + a fake loadShareConfig are injected so route→service
// runs without Postgres; the real-DB path is covered by
// test/integration/annotation-routes.itest.ts.
//
// AS map (annotation-core):
//   AS-001/003  POST annotations → 201 { annotationId } (text anchor)
//   AS-005/006  POST annotations → 201 (image-region point/box)
//   AS-021      read-authz: no-access doc → 404 (indistinguishable)
//   AS-020      forged role ignored: server resolves viewer → 403
//   AS-008      POST comments (signed-in reply) → 201, flat parentId
//   AS-016/017/019 guest comment (no session): name required, sanitized, email
//   AS-009/010  PATCH resolution toggle; viewer → 403
//   AS-014      POST suggestions → 201; viewer → 403
//   AS-015/022  PATCH suggestion accept/reject; stale → 409

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { SessionResolver } from "../../src/http/auth-gate";
import type { Role } from "../../src/sharing/roles";
import type { Viewer } from "../../src/sharing/access";
import type { AccessResult } from "../../src/sharing/resolve-access";
import type { DocLookup, DocLookupRepo } from "../../src/routes/versions";
import type { AnnotationLookupRepo, LoadShareConfig } from "../../src/routes/annotations";
import type { AnnotationRepo, AnnotationRow, NewAnnotation, ViewerComment } from "../../src/annotation/annotation";
import type { CommentRepo, CommentRow, NewComment } from "../../src/annotation/reply";
import type { GuestCommentRepo, NewGuestComment } from "../../src/annotation/guest";
import type { ResolutionRepo, AnnotationStatus } from "../../src/annotation/resolve";
import type { SuggestionRepo, SuggestionRow, SuggestionStatus } from "../../src/annotation/suggestion";

const member: SessionResolver = async () => ({ userId: "u_member" });
const noSession: SessionResolver = async () => null;
const asOwner = async (): Promise<Role | null> => "owner";
const asViewer = async (): Promise<Role | null> => "viewer";
const asCommenter = async (): Promise<Role | null> => "commenter";

const VISIBLE_DOC: DocLookup = {
  id: "doc_1",
  title: "Doc One",
  kind: "markdown",
  generalAccess: "anyone_with_link",
};

const TEXT_ANCHOR = { blockId: "block-p-1", textSnippet: "hello", offset: 0, length: 5 };

function fakeAnnotationRepo(
  seed: AnnotationRow[] = [],
  commentSeed: (ViewerComment & { annotationId: string })[] = [],
) {
  const rows = [...seed];
  let n = 0;
  const calls = { inserts: [] as NewAnnotation[] };
  const repo: AnnotationRepo = {
    async insertAnnotation(input) {
      calls.inserts.push(input);
      const id = `ann_${++n}`;
      rows.push({ id, docId: input.docId, type: input.type, anchor: input.anchor, isOrphaned: false, status: "unresolved" });
      return { id };
    },
    async listByDoc(docId) {
      return rows.filter((r) => r.docId === docId);
    },
    async listCommentsByDoc(docId) {
      const annIds = new Set(rows.filter((r) => r.docId === docId).map((r) => r.id));
      return commentSeed.filter((c) => annIds.has(c.annotationId));
    },
  };
  return { repo, calls, rows };
}

function fakeCommentRepo(seed: CommentRow[] = []) {
  const rows = [...seed];
  let n = 0;
  const calls = { inserts: [] as NewComment[] };
  const repo: CommentRepo = {
    async listByAnnotation(annotationId) {
      return rows.filter((r) => r.annotationId === annotationId);
    },
    async insertComment(input) {
      calls.inserts.push(input);
      const id = `c_${++n}`;
      rows.push({ id, annotationId: input.annotationId, parentId: input.parentId, authorId: input.authorId, guestName: input.guestName, body: input.body });
      return { id };
    },
  };
  return { repo, calls, rows };
}

function fakeGuestCommentRepo(shared?: ReturnType<typeof fakeCommentRepo>) {
  const calls = { inserts: [] as NewGuestComment[] };
  let n = 0;
  const repo: GuestCommentRepo = {
    async listByAnnotation(annotationId) {
      return shared ? shared.repo.listByAnnotation(annotationId) : [];
    },
    async insertComment(input: NewGuestComment) {
      calls.inserts.push(input);
      return { id: `g_${++n}` };
    },
  };
  return { repo, calls };
}

function fakeResolutionRepo() {
  const calls = {
    sets: [] as { id: string; status: AnnotationStatus }[],
    resets: [] as string[],
  };
  const repo: ResolutionRepo = {
    async setAnnotationStatus(annotationId, status) {
      calls.sets.push({ id: annotationId, status });
    },
    async resetSuggestionStatusToPending(annotationId) {
      calls.resets.push(annotationId);
    },
  };
  return { repo, calls };
}

function fakeSuggestionRepo(seed: SuggestionRow[] = []) {
  const rows = [...seed];
  let n = 0;
  const calls = {
    inserts: [] as SuggestionRow[],
    statuses: [] as { id: string; status: SuggestionStatus }[],
  };
  const repo: SuggestionRepo = {
    async insertSuggestion(row) {
      calls.inserts.push(row);
      const id = row.id ?? `sug_${++n}`;
      rows.push({ ...row, id });
      return { id };
    },
    async getSuggestion(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async setSuggestionStatus(id, status) {
      calls.statuses.push({ id, status });
      const r = rows.find((x) => x.id === id);
      if (r) r.status = status;
    },
  };
  return { repo, calls, rows };
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

function fakeAnnotationLookupRepo(opts: {
  doc?: { docId: string; generalAccess: DocLookup["generalAccess"] } | null;
  currentHtml?: string;
}): AnnotationLookupRepo {
  const parent = opts.doc === undefined ? { docId: "doc_1", generalAccess: "anyone_with_link" as const } : opts.doc;
  return {
    async findAnnotationDoc() {
      return parent;
    },
    async findSuggestionDoc() {
      return parent;
    },
    async getCurrentVersionContent() {
      return opts.currentHtml ?? null;
    },
  };
}

const guestOn: LoadShareConfig = async () => ({ guestCommentingEnabled: true });
const guestOff: LoadShareConfig = async () => ({ guestCommentingEnabled: false });

function buildApp(opts: {
  resolveSession?: SessionResolver;
  resolveDocRole?: (docId: string, userId: string) => Promise<Role | null>;
  doc?: DocLookup | null;
  /**
   * doc-access-routing S-001: the single read gate. Default ADMITS (canView true) at
   * whatever role resolveDocRole reports — so the existing happy-path tests still pass.
   * No-access tests pass an explicit gate returning { role: null, canView: false }.
   */
  resolveAccess?: (docId: string, viewer: Viewer) => Promise<AccessResult>;
  annotationRepo?: ReturnType<typeof fakeAnnotationRepo>;
  commentRepo?: ReturnType<typeof fakeCommentRepo>;
  guestCommentRepo?: ReturnType<typeof fakeGuestCommentRepo>;
  resolutionRepo?: ReturnType<typeof fakeResolutionRepo>;
  suggestionRepo?: ReturnType<typeof fakeSuggestionRepo>;
  annotationLookupRepo?: AnnotationLookupRepo;
  loadShareConfig?: LoadShareConfig;
}) {
  const resolveDocRole = opts.resolveDocRole ?? asOwner;
  // Default gate: admit, mirroring the resolved role (anon → null role but still admitted
  // for the default anyone_with_link doc the tests use). No-access cases override this.
  const defaultAccess = async (docId: string, viewer: Viewer): Promise<AccessResult> => {
    const role = viewer.kind === "user" ? await resolveDocRole(docId, viewer.userId) : null;
    return { role, canView: true };
  };
  return createApp({
    dbCheck: async () => {},
    annotations: {
      annotationRepo: (opts.annotationRepo ?? fakeAnnotationRepo()).repo,
      commentRepo: (opts.commentRepo ?? fakeCommentRepo()).repo,
      guestCommentRepo: (opts.guestCommentRepo ?? fakeGuestCommentRepo()).repo,
      resolutionRepo: (opts.resolutionRepo ?? fakeResolutionRepo()).repo,
      suggestionRepo: (opts.suggestionRepo ?? fakeSuggestionRepo()).repo,
      lookupRepo: fakeLookupRepo(opts.doc === undefined ? VISIBLE_DOC : opts.doc),
      annotationLookupRepo: opts.annotationLookupRepo ?? fakeAnnotationLookupRepo({}),
      resolveSession: opts.resolveSession ?? member,
      resolveWorkspaceRole: async () => "member",
      resolveDocRole,
      resolveAccess: opts.resolveAccess ?? defaultAccess,
      loadShareConfig: opts.loadShareConfig ?? guestOff,
    },
  });
}

/** A no-access gate: every doc-centric read denies (existence-hiding 404). */
const denyAll = async (): Promise<AccessResult> => ({ role: null, canView: false });

function req(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("POST /api/docs/:slug/annotations (S-001/S-002)", () => {
  test("AS-001/AS-003: commenter creates a text annotation → 201 { annotationId }, block_id stored verbatim", async () => {
    const ar = fakeAnnotationRepo();
    const app = buildApp({ resolveDocRole: asCommenter, annotationRepo: ar });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/annotations", { method: "POST", body: JSON.stringify({ anchor: TEXT_ANCHOR }) }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.data.annotationId).toBeString();
    expect(ar.calls.inserts[0]?.anchor.blockId).toBe("block-p-1");
    expect(ar.calls.inserts[0]?.type).toBe("range");
  });

  test("AS-005: image-region point anchor → 201, type=block, region carried", async () => {
    const ar = fakeAnnotationRepo();
    const app = buildApp({ resolveDocRole: asCommenter, annotationRepo: ar });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/annotations", {
        method: "POST",
        body: JSON.stringify({ anchor: { blockId: "img-1", region: { kind: "point", x: 0.5, y: 0.5 } } }),
      }),
    );
    expect(res.status).toBe(201);
    expect(ar.calls.inserts[0]?.type).toBe("block");
    expect(ar.calls.inserts[0]?.anchor.region).toEqual({ kind: "point", x: 0.5, y: 0.5 });
  });

  test("AS-006: image-region box anchor → 201", async () => {
    const ar = fakeAnnotationRepo();
    const app = buildApp({ resolveDocRole: asCommenter, annotationRepo: ar });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/annotations", {
        method: "POST",
        body: JSON.stringify({ anchor: { blockId: "img-1", region: { kind: "box", x: 0.1, y: 0.1, w: 0.2, h: 0.2 } } }),
      }),
    );
    expect(res.status).toBe(201);
    expect(ar.calls.inserts[0]?.anchor.region).toEqual({ kind: "box", x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
  });

  test("no session → 401 (handler never runs)", async () => {
    const ar = fakeAnnotationRepo();
    const app = buildApp({ resolveSession: noSession, annotationRepo: ar });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/annotations", { method: "POST", body: JSON.stringify({ anchor: TEXT_ANCHOR }) }),
    );
    expect(res.status).toBe(401);
    expect(ar.calls.inserts).toHaveLength(0);
  });

  test("AS-020: forged owner role ignored — server resolves viewer → 403", async () => {
    const ar = fakeAnnotationRepo();
    const app = buildApp({ resolveDocRole: asViewer, annotationRepo: ar });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/annotations", {
        method: "POST",
        body: JSON.stringify({ anchor: TEXT_ANCHOR, role: "owner", authorized: true }),
      }),
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("FORBIDDEN");
    expect(ar.calls.inserts).toHaveLength(0);
  });

  test("AS-021: no-access doc → 404 (indistinguishable), before role check", async () => {
    const ar = fakeAnnotationRepo();
    const app = buildApp({
      doc: { ...VISIBLE_DOC, generalAccess: "restricted" },
      resolveAccess: denyAll,
      resolveDocRole: asOwner,
      annotationRepo: ar,
    });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/annotations", { method: "POST", body: JSON.stringify({ anchor: TEXT_ANCHOR }) }),
    );
    expect(res.status).toBe(404);
    expect(ar.calls.inserts).toHaveLength(0);
  });

  test("missing doc → 404", async () => {
    const app = buildApp({ doc: null });
    const res = await app.handle(
      req("/api/w/ws_1/docs/nope/annotations", { method: "POST", body: JSON.stringify({ anchor: TEXT_ANCHOR }) }),
    );
    expect(res.status).toBe(404);
  });

  test("bad body (missing anchor) → 400 VALIDATION_ERROR", async () => {
    const app = buildApp({ resolveDocRole: asCommenter });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/annotations", { method: "POST", body: JSON.stringify({ type: "range" }) }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  test("AS-027/C-015: commenter creates a labeled annotation → 201, label persisted verbatim", async () => {
    const ar = fakeAnnotationRepo();
    const app = buildApp({ resolveDocRole: asCommenter, annotationRepo: ar });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/annotations", {
        method: "POST",
        body: JSON.stringify({ anchor: TEXT_ANCHOR, label: "out-of-scope" }),
      }),
    );
    expect(res.status).toBe(201);
    expect(ar.calls.inserts[0]?.label).toBe("out-of-scope");
  });

  test("AS-028/C-015: a create with an unknown / forged label → 400 VALIDATION_ERROR, nothing persisted", async () => {
    const ar = fakeAnnotationRepo();
    const app = buildApp({ resolveDocRole: asCommenter, annotationRepo: ar });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/annotations", {
        method: "POST",
        body: JSON.stringify({ anchor: TEXT_ANCHOR, label: "<svg onload=alert(1)>" }),
      }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(ar.calls.inserts).toHaveLength(0);
  });

  test("AS-029/C-015: a create carrying BOTH a label and a suggestion payload → 400 (mutually exclusive), nothing persisted", async () => {
    const ar = fakeAnnotationRepo();
    const app = buildApp({ resolveDocRole: asCommenter, annotationRepo: ar });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/annotations", {
        method: "POST",
        body: JSON.stringify({ anchor: TEXT_ANCHOR, label: "looks-good", suggestion: { kind: "delete", from: "x", againstVersion: 1 } }),
      }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(ar.calls.inserts).toHaveLength(0);
  });
});

// ── annotation-actions S-001: persist the creator at create (C-005) ──────────
describe("annotation-actions S-001: the creator identity is persisted at create", () => {
  test("AS-001: a member create records the session actor as author_id (workspace mount, session-required)", async () => {
    const ar = fakeAnnotationRepo();
    // Mara is the session actor (u_member by default); her id is the durable creator.
    const app = buildApp({ resolveDocRole: asCommenter, annotationRepo: ar });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/annotations", { method: "POST", body: JSON.stringify({ anchor: TEXT_ANCHOR }) }),
    );
    expect(res.status).toBe(201);
    // C-005: the creator is persisted from the session actor (NOT derived from any comment).
    expect(ar.calls.inserts[0]?.authorId).toBe("u_member");
  });

  test("AS-002: a guest create (no session, doc mount) records a NULL author_id — no durable account creator", async () => {
    const ar = fakeAnnotationRepo();
    // Anon guest on an anyone_with_link doc, guest commenting on → the doc-scoped create
    // handler runs with no session (actor id null = the guest case). The link grants a
    // commenter role so the write is authorized (C-005); the creator is still null (AS-002).
    const app = buildApp({
      resolveSession: noSession,
      annotationRepo: ar,
      loadShareConfig: guestOn,
      resolveAccess: async () => ({ role: "commenter", canView: true }),
    });
    const res = await app.handle(
      req("/api/docs/doc-one/annotations", { method: "POST", body: JSON.stringify({ anchor: TEXT_ANCHOR }) }),
    );
    expect(res.status).toBe(201);
    // AS-002: a guest has no account → author_id is null (absent durable identity).
    expect(ar.calls.inserts[0]?.authorId ?? null).toBeNull();
  });

  test("AS-001: a member-created redline (suggestion) also records author_id = the session actor", async () => {
    const sr = fakeSuggestionRepo();
    const app = buildApp({ resolveDocRole: asCommenter, suggestionRepo: sr });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/suggestions", {
        method: "POST",
        body: JSON.stringify({ anchor: TEXT_ANCHOR, from: "hello", to: "hi", againstVersion: 1 }),
      }),
    );
    expect(res.status).toBe(201);
    // The redline create path threads the durable creator too (AS-001 spans comment OR redline).
    expect(sr.calls.inserts[0]?.authorId).toBe("u_member");
  });

  test("AS-001: the GET read serves authorId on each annotation (own-vs-others gate reads it)", async () => {
    const ar = fakeAnnotationRepo([
      { id: "a1", docId: "doc_1", type: "range", anchor: TEXT_ANCHOR as any, isOrphaned: false, status: "unresolved", authorId: "u_mara" },
    ]);
    const app = buildApp({ resolveDocRole: asViewer, annotationRepo: ar });
    const res = await app.handle(req("/api/w/ws_1/docs/doc-one/annotations"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.items[0].authorId).toBe("u_mara");
  });
});

describe("GET /api/docs/:slug/annotations (S-001 read-authz)", () => {
  test("viewer+ lists → 200 { items, pagination }", async () => {
    const ar = fakeAnnotationRepo(
      [
        { id: "a1", docId: "doc_1", type: "range", anchor: TEXT_ANCHOR as any, isOrphaned: false, status: "unresolved" },
        { id: "a2", docId: "doc_1", type: "range", anchor: TEXT_ANCHOR as any, isOrphaned: false, status: "unresolved" },
      ],
      // S-003 linked field: each item must carry its comment thread for the viewer rail.
      [
        { annotationId: "a1", id: "c1", parentId: null, authorName: "Demo", body: "root", createdAt: "2026-01-01T00:00:00.000Z" },
        { annotationId: "a1", id: "c2", parentId: "c1", guestName: "Guest", body: "reply", createdAt: "2026-01-01T00:01:00.000Z" },
      ],
    );
    const app = buildApp({ resolveDocRole: asViewer, annotationRepo: ar });
    const res = await app.handle(req("/api/w/ws_1/docs/doc-one/annotations"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.items).toHaveLength(2);
    expect(json.data.pagination.total).toBe(2);
    // The viewer-read contract: each annotation carries comments[] (the gap that white-screened the rail).
    expect(json.data.items[0].comments).toHaveLength(2);
    expect(json.data.items[0].comments[0]).toMatchObject({ id: "c1", authorName: "Demo", body: "root" });
    expect(json.data.items[1].comments).toEqual([]);
  });

  test("AS-030: the GET read serves a suggestion's payload + suggestionStatus (viewer renders the redline/suggestion lifecycle from the read)", async () => {
    const ar = fakeAnnotationRepo([
      {
        id: "s1",
        docId: "doc_1",
        type: "suggestion",
        anchor: TEXT_ANCHOR as any,
        isOrphaned: false,
        status: "resolved",
        suggestion: { kind: "delete", from: "hello", againstVersion: 2 },
        suggestionStatus: "stale",
      },
    ]);
    const app = buildApp({ resolveDocRole: asViewer, annotationRepo: ar });
    const res = await app.handle(req("/api/w/ws_1/docs/doc-one/annotations"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.items[0].suggestion).toEqual({ kind: "delete", from: "hello", againstVersion: 2 });
    expect(json.data.items[0].suggestionStatus).toBe("stale");
  });

  test("AS-027: the GET read serves the stored label on each annotation", async () => {
    const ar = fakeAnnotationRepo([
      { id: "a1", docId: "doc_1", type: "range", anchor: TEXT_ANCHOR as any, isOrphaned: false, status: "unresolved", label: "out-of-scope" },
    ]);
    const app = buildApp({ resolveDocRole: asViewer, annotationRepo: ar });
    const res = await app.handle(req("/api/w/ws_1/docs/doc-one/annotations"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.items[0].label).toBe("out-of-scope");
  });

  test("pagination: limit=1 page=2 → second item only", async () => {
    const ar = fakeAnnotationRepo([
      { id: "a1", docId: "doc_1", type: "range", anchor: TEXT_ANCHOR as any, isOrphaned: false, status: "unresolved" },
      { id: "a2", docId: "doc_1", type: "range", anchor: TEXT_ANCHOR as any, isOrphaned: false, status: "unresolved" },
    ]);
    const app = buildApp({ resolveDocRole: asViewer, annotationRepo: ar });
    const res = await app.handle(req("/api/w/ws_1/docs/doc-one/annotations?limit=1&page=2"));
    const json = (await res.json()) as any;
    expect(json.data.items).toHaveLength(1);
    expect(json.data.items[0].id).toBe("a2");
  });

  test("AS-021: no-access doc → 404 (not an empty list — indistinguishable)", async () => {
    const app = buildApp({
      doc: { ...VISIBLE_DOC, generalAccess: "restricted" },
      resolveAccess: denyAll,
    });
    const res = await app.handle(req("/api/w/ws_1/docs/doc-one/annotations"));
    expect(res.status).toBe(404);
  });

  test("AS-007: logged-in non-member (not owner/invited/member) is DENIED the annotation list of a restricted doc — same 404 as the doc read, no thread leak", async () => {
    // Frank IS logged in (session resolves). The OLD permissive stub let any logged-in
    // user pass; the single resolveAccess gate denies him (no role), so the list 404s
    // EXACTLY like the doc read — and the annotation repo is never queried (no leak).
    const ar = fakeAnnotationRepo([
      { id: "secret", docId: "doc_1", type: "range", anchor: TEXT_ANCHOR as any, isOrphaned: false, status: "unresolved" },
    ]);
    const frank: SessionResolver = async () => ({ userId: "u_frank" });
    const app = buildApp({
      resolveSession: frank,
      doc: { ...VISIBLE_DOC, generalAccess: "restricted" },
      // The gate Frank fails: owner/invited/workspace/link all miss → denied.
      resolveAccess: denyAll,
      annotationRepo: ar,
    });
    const res = await app.handle(req("/api/w/ws_1/docs/doc-one/annotations"));
    expect(res.status).toBe(404); // not the old "200 with an empty/leaked list"
    const json = (await res.json()) as any;
    expect(json.success).toBe(false);
    // No thread text reachable on a denied read.
    expect(json.data?.items).toBeUndefined();
  });

  test("C-001 / C-012: the annotation LIST is gated by the single resolveAccess (negative-access regression: logged-in non-member → denied), not by requireWorkspaceMember", async () => {
    // Distinct from AS-007's existence-hiding focus: this pins the C-012 invariant that a
    // doc-centric READ which would lose its workspace-membership wall is STILL denied by
    // the resolveAccess gate for a non-member. A widened gate (canView always true) would
    // turn this green wrongly — so the gate is what's under test.
    const nonMember: SessionResolver = async () => ({ userId: "u_outsider" });
    const denied = buildApp({
      resolveSession: nonMember,
      doc: { ...VISIBLE_DOC, generalAccess: "restricted" },
      resolveAccess: denyAll,
    });
    expect((await denied.handle(req("/api/w/ws_1/docs/doc-one/annotations"))).status).toBe(404);
    // And the same gate ADMITTING (canView true) lets a real member read → 200 (proves
    // the 404 above is the gate denying, not a blanket block).
    const admitted = buildApp({
      resolveSession: nonMember,
      doc: { ...VISIBLE_DOC, generalAccess: "restricted" },
      resolveAccess: async () => ({ role: "viewer", canView: true }),
    });
    expect((await admitted.handle(req("/api/w/ws_1/docs/doc-one/annotations"))).status).toBe(200);
  });
});

describe("POST /api/annotations/:id/comments (S-003 reply / S-007 guest)", () => {
  test("AS-008: signed-in reply → 201, parentId flattened to the root", async () => {
    const cr = fakeCommentRepo([
      { id: "root", annotationId: "ann_1", parentId: null, authorId: "u_a", guestName: null, body: "root" },
      { id: "reply1", annotationId: "ann_1", parentId: "root", authorId: "u_b", guestName: null, body: "r1" },
    ]);
    const app = buildApp({ resolveDocRole: asCommenter, commentRepo: cr });
    // reply to a reply → flattened to root
    const res = await app.handle(
      req("/api/w/ws_1/annotations/ann_1/comments", { method: "POST", body: JSON.stringify({ body: "me too", parentId: "reply1" }) }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.data.commentId).toBeString();
    expect(cr.calls.inserts[0]?.parentId).toBe("root");
  });

  test("S-001: signed-in top-level comment (no parentId) on an EMPTY thread → 201 { commentId }, parentId null", async () => {
    // The FE first-comment flow: createAnnotation (no body) then addComment with NO
    // parentId. Before the fix this was routed through addReply → parent_not_found → 404.
    const cr = fakeCommentRepo(); // empty thread
    const app = buildApp({ resolveDocRole: asCommenter, commentRepo: cr });
    const res = await app.handle(
      req("/api/w/ws_1/annotations/ann_1/comments", { method: "POST", body: JSON.stringify({ body: "first comment" }) }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.data.commentId).toBeString();
    expect(cr.calls.inserts).toHaveLength(1);
    expect(cr.calls.inserts[0]?.parentId).toBeNull();
    expect(cr.calls.inserts[0]?.body).toBe("first comment");
  });

  test("AS-007: a signed-in reply records the session actor as author (no guest name)", async () => {
    // user A is signed in and may comment → the comment's author_id is A, guest_name null.
    const userA: SessionResolver = async () => ({ userId: "u_A" });
    const cr = fakeCommentRepo([
      { id: "root", annotationId: "ann_1", parentId: null, authorId: "u_x", guestName: null, body: "root" },
    ]);
    const app = buildApp({ resolveSession: userA, resolveDocRole: asCommenter, commentRepo: cr });
    const res = await app.handle(
      req("/api/w/ws_1/annotations/ann_1/comments", { method: "POST", body: JSON.stringify({ body: "my reply", parentId: "root" }) }),
    );
    expect(res.status).toBe(201);
    expect(cr.calls.inserts[0]?.authorId).toBe("u_A");
    expect(cr.calls.inserts[0]?.guestName).toBeNull();
  });

  test("C-005: a forged author in the body is ignored — author_id is the session actor", async () => {
    // Body carries attacker-supplied identity; validation strips unknown keys and the
    // route reads the author only from the resolved session actor → "u_A" wins.
    const userA: SessionResolver = async () => ({ userId: "u_A" });
    const cr = fakeCommentRepo([
      { id: "root", annotationId: "ann_1", parentId: null, authorId: "u_x", guestName: null, body: "root" },
    ]);
    const app = buildApp({ resolveSession: userA, resolveDocRole: asCommenter, commentRepo: cr });
    const res = await app.handle(
      req("/api/w/ws_1/annotations/ann_1/comments", {
        method: "POST",
        body: JSON.stringify({ body: "hi", parentId: "root", authorId: "attacker", userId: "attacker" }),
      }),
    );
    expect(res.status).toBe(201);
    expect(cr.calls.inserts[0]?.authorId).toBe("u_A");
    expect(cr.calls.inserts[0]?.authorId).not.toBe("attacker");
    expect(cr.calls.inserts[0]?.guestName).toBeNull();
  });

  test("AS-008: a guest reply (no session) records the guest name and no account author", async () => {
    // Anonymous guest "Lan" on a guest-commenting doc → guest_name set, author_id null.
    const gr = fakeGuestCommentRepo();
    const app = buildApp({ resolveSession: noSession, guestCommentRepo: gr, loadShareConfig: guestOn });
    const res = await app.handle(
      req("/api/w/ws_1/annotations/ann_1/comments", { method: "POST", body: JSON.stringify({ body: "guest note", guestName: "Lan" }) }),
    );
    expect(res.status).toBe(201);
    expect(gr.calls.inserts[0]?.guestName).toBe("Lan");
    expect(gr.calls.inserts[0]?.authorId).toBeNull();
  });

  test("reply with empty body → 400", async () => {
    const app = buildApp({ resolveDocRole: asCommenter, commentRepo: fakeCommentRepo([{ id: "root", annotationId: "ann_1", parentId: null, authorId: "u", guestName: null, body: "x" }]) });
    const res = await app.handle(
      req("/api/w/ws_1/annotations/ann_1/comments", { method: "POST", body: JSON.stringify({ body: "   ", parentId: "root" }) }),
    );
    expect(res.status).toBe(400);
  });

  test("reply by viewer → 403", async () => {
    const app = buildApp({ resolveDocRole: asViewer, commentRepo: fakeCommentRepo([{ id: "root", annotationId: "ann_1", parentId: null, authorId: "u", guestName: null, body: "x" }]) });
    const res = await app.handle(
      req("/api/w/ws_1/annotations/ann_1/comments", { method: "POST", body: JSON.stringify({ body: "hi", parentId: "root" }) }),
    );
    expect(res.status).toBe(403);
  });

  test("AS-017: guest comment (no session) with name + email → 201", async () => {
    const gr = fakeGuestCommentRepo();
    const app = buildApp({ resolveSession: noSession, guestCommentRepo: gr, loadShareConfig: guestOn });
    const res = await app.handle(
      req("/api/w/ws_1/annotations/ann_1/comments", {
        method: "POST",
        body: JSON.stringify({ body: "guest here", guestName: "Anon Fox", guestEmail: "fox@example.com" }),
      }),
    );
    expect(res.status).toBe(201);
    expect(gr.calls.inserts[0]?.guestName).toBe("Anon Fox");
    expect(gr.calls.inserts[0]?.guestEmail).toBe("fox@example.com");
    expect(gr.calls.inserts[0]?.authorId).toBeNull();
  });

  test("AS-019: guest body sanitized inert (script stripped)", async () => {
    const gr = fakeGuestCommentRepo();
    const app = buildApp({ resolveSession: noSession, guestCommentRepo: gr, loadShareConfig: guestOn });
    await app.handle(
      req("/api/w/ws_1/annotations/ann_1/comments", {
        method: "POST",
        body: JSON.stringify({ body: "<script>alert(1)</script>safe", guestName: "Fox" }),
      }),
    );
    expect(gr.calls.inserts[0]?.body).not.toContain("<script>");
    expect(gr.calls.inserts[0]?.body).toContain("safe");
  });

  test("guest comment missing name → 400", async () => {
    const app = buildApp({ resolveSession: noSession, loadShareConfig: guestOn });
    const res = await app.handle(
      req("/api/w/ws_1/annotations/ann_1/comments", { method: "POST", body: JSON.stringify({ body: "hi" }) }),
    );
    expect(res.status).toBe(400);
  });

  test("guest comment when guest commenting disabled → 401", async () => {
    const app = buildApp({ resolveSession: noSession, loadShareConfig: guestOff });
    const res = await app.handle(
      req("/api/w/ws_1/annotations/ann_1/comments", { method: "POST", body: JSON.stringify({ body: "hi", guestName: "Fox" }) }),
    );
    expect(res.status).toBe(401);
  });

  test("comment on no-access parent doc → 404 (existence-hiding)", async () => {
    const app = buildApp({
      resolveDocRole: asCommenter,
      annotationLookupRepo: fakeAnnotationLookupRepo({ doc: { docId: "doc_1", generalAccess: "restricted" } }),
      resolveAccess: denyAll,
    });
    const res = await app.handle(
      req("/api/w/ws_1/annotations/ann_1/comments", { method: "POST", body: JSON.stringify({ body: "hi", parentId: "root" }) }),
    );
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/annotations/:id/resolution (S-004)", () => {
  test("AS-009/AS-010: commenter resolves → 200 { status: resolved }", async () => {
    const rr = fakeResolutionRepo();
    const app = buildApp({ resolveDocRole: asCommenter, resolutionRepo: rr });
    const res = await app.handle(
      req("/api/w/ws_1/annotations/ann_1/resolution", { method: "PATCH", body: JSON.stringify({ resolved: true }) }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.status).toBe("resolved");
    expect(rr.calls.sets[0]).toEqual({ id: "ann_1", status: "resolved" });
  });

  test("reopen → 200 { status: unresolved }", async () => {
    const rr = fakeResolutionRepo();
    const app = buildApp({ resolveDocRole: asCommenter, resolutionRepo: rr });
    const res = await app.handle(
      req("/api/w/ws_1/annotations/ann_1/resolution", { method: "PATCH", body: JSON.stringify({ resolved: false }) }),
    );
    const json = (await res.json()) as any;
    expect(json.data.status).toBe("unresolved");
  });

  test("viewer → 403", async () => {
    const app = buildApp({ resolveDocRole: asViewer });
    const res = await app.handle(
      req("/api/w/ws_1/annotations/ann_1/resolution", { method: "PATCH", body: JSON.stringify({ resolved: true }) }),
    );
    expect(res.status).toBe(403);
  });

  test("bad body (resolved not boolean) → 400", async () => {
    const app = buildApp({ resolveDocRole: asCommenter });
    const res = await app.handle(
      req("/api/w/ws_1/annotations/ann_1/resolution", { method: "PATCH", body: JSON.stringify({ resolved: "yes" }) }),
    );
    expect(res.status).toBe(400);
  });

  // S-006 / AS-026 / C-016: reopening a DECIDED suggestion via the resolution route is
  // owner-only and resets the decision (suggestion_status → pending). The resolution handler
  // detects the suggestion lifecycle via suggestionRepo.getSuggestion(:id).
  const DECIDED_SUG: SuggestionRow = {
    id: "sug_dec",
    docId: "doc_1",
    type: "suggestion",
    anchor: { blockId: "block-p-1", textSnippet: "hello", offset: 0, length: 5 },
    suggestion: { kind: "replace", from: "hello", to: "hi", againstVersion: 1 },
    status: "accepted",
  };

  test("AS-026/C-016: the OWNER reopening a DECIDED suggestion → 200 { status: unresolved } and resets it to pending", async () => {
    const rr = fakeResolutionRepo();
    const sr = fakeSuggestionRepo([{ ...DECIDED_SUG }]);
    const app = buildApp({ resolveDocRole: asOwner, resolutionRepo: rr, suggestionRepo: sr });
    const res = await app.handle(
      req("/api/w/ws_1/annotations/sug_dec/resolution", { method: "PATCH", body: JSON.stringify({ resolved: false }) }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.status).toBe("unresolved");
    // the thread unresolves AND the decision is cleared (suggestion_status → pending)
    expect(rr.calls.sets).toContainEqual({ id: "sug_dec", status: "unresolved" });
    expect(rr.calls.resets).toEqual(["sug_dec"]);
  });

  test("AS-026/C-016: a NON-OWNER (commenter) reopening a DECIDED suggestion → 403, nothing reset (unlike an ordinary reopen)", async () => {
    const rr = fakeResolutionRepo();
    const sr = fakeSuggestionRepo([{ ...DECIDED_SUG, id: "sug_dec2" }]);
    const app = buildApp({ resolveDocRole: asCommenter, resolutionRepo: rr, suggestionRepo: sr });
    const res = await app.handle(
      req("/api/w/ws_1/annotations/sug_dec2/resolution", { method: "PATCH", body: JSON.stringify({ resolved: false }) }),
    );
    expect(res.status).toBe(403);
    expect(rr.calls.sets).toHaveLength(0);
    expect(rr.calls.resets).toHaveLength(0);
  });
});

describe("POST /api/docs/:slug/suggestions (S-006)", () => {
  test("AS-014: commenter creates a suggestion → 201 { suggestionId }", async () => {
    const sr = fakeSuggestionRepo();
    const app = buildApp({ resolveDocRole: asCommenter, suggestionRepo: sr });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/suggestions", {
        method: "POST",
        body: JSON.stringify({ anchor: TEXT_ANCHOR, from: "hello", to: "hi", againstVersion: 1 }),
      }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.data.suggestionId).toBeString();
    expect(sr.calls.inserts[0]?.suggestion).toEqual({ kind: "replace", from: "hello", to: "hi", againstVersion: 1 });
  });

  test("viewer → 403", async () => {
    const app = buildApp({ resolveDocRole: asViewer });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/suggestions", {
        method: "POST",
        body: JSON.stringify({ anchor: TEXT_ANCHOR, from: "hello", againstVersion: 1 }),
      }),
    );
    expect(res.status).toBe(403);
  });

  test("bad body (missing from) → 400", async () => {
    const app = buildApp({ resolveDocRole: asCommenter });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/suggestions", { method: "POST", body: JSON.stringify({ anchor: TEXT_ANCHOR, againstVersion: 1 }) }),
    );
    expect(res.status).toBe(400);
  });

  test("AS-029/C-015: a suggestion create carrying a label → 400 (a suggestion cannot carry a label), nothing persisted", async () => {
    const sr = fakeSuggestionRepo();
    const app = buildApp({ resolveDocRole: asCommenter, suggestionRepo: sr });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/suggestions", {
        method: "POST",
        body: JSON.stringify({ anchor: TEXT_ANCHOR, from: "hello", to: "hi", againstVersion: 1, label: "looks-good" }),
      }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(sr.calls.inserts).toHaveLength(0);
  });
});

describe("PATCH /api/suggestions/:id (S-006)", () => {
  const SUG: SuggestionRow = {
    id: "sug_1",
    docId: "doc_1",
    type: "suggestion",
    anchor: { blockId: "block-p-1", textSnippet: "hello world", offset: 0, length: 11 },
    suggestion: { kind: "replace", from: "hello", to: "hi", againstVersion: 1 },
    status: "pending",
  };

  test("AS-015: owner accepts, from still matches → 200 { status: accepted }", async () => {
    const sr = fakeSuggestionRepo([{ ...SUG }]);
    const app = buildApp({
      resolveDocRole: asOwner,
      suggestionRepo: sr,
      annotationLookupRepo: fakeAnnotationLookupRepo({ currentHtml: "<p>hello world</p>" }),
    });
    const res = await app.handle(
      req("/api/w/ws_1/suggestions/sug_1", { method: "PATCH", body: JSON.stringify({ decision: "accept" }) }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.status).toBe("accepted");
  });

  test("AS-015: owner rejects → 200 { status: rejected }", async () => {
    const sr = fakeSuggestionRepo([{ ...SUG, id: "sug_2" }]);
    const app = buildApp({
      resolveDocRole: asOwner,
      suggestionRepo: sr,
      annotationLookupRepo: fakeAnnotationLookupRepo({ currentHtml: "<p>anything</p>" }),
    });
    const res = await app.handle(
      req("/api/w/ws_1/suggestions/sug_2", { method: "PATCH", body: JSON.stringify({ decision: "reject" }) }),
    );
    const json = (await res.json()) as any;
    expect(json.data.status).toBe("rejected");
  });

  test("AS-022: accept of a drifted `from` → 409 CONFLICT (stale)", async () => {
    const sr = fakeSuggestionRepo([{ ...SUG, id: "sug_3" }]);
    const app = buildApp({
      resolveDocRole: asOwner,
      suggestionRepo: sr,
      annotationLookupRepo: fakeAnnotationLookupRepo({ currentHtml: "<p>totally different text</p>" }),
    });
    const res = await app.handle(
      req("/api/w/ws_1/suggestions/sug_3", { method: "PATCH", body: JSON.stringify({ decision: "accept" }) }),
    );
    expect(res.status).toBe(409);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("CONFLICT");
  });

  test("non-owner (commenter) → 403", async () => {
    const sr = fakeSuggestionRepo([{ ...SUG, id: "sug_4" }]);
    const app = buildApp({ resolveDocRole: asCommenter, suggestionRepo: sr });
    const res = await app.handle(
      req("/api/w/ws_1/suggestions/sug_4", { method: "PATCH", body: JSON.stringify({ decision: "accept" }) }),
    );
    expect(res.status).toBe(403);
  });

  test("no session → 401", async () => {
    const app = buildApp({ resolveSession: noSession });
    const res = await app.handle(
      req("/api/w/ws_1/suggestions/sug_1", { method: "PATCH", body: JSON.stringify({ decision: "accept" }) }),
    );
    expect(res.status).toBe(401);
  });
});
