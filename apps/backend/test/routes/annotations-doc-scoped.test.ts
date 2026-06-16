// In-process route tests for the DOC-SCOPED annotation routes (doc-access-routing S-004).
//
// S-004 carves annotation create/list + comment/resolve OFF the workspace path and onto
// DOC-ADDRESSED routes the slug-only viewer (S-003) calls:
//   POST  /api/docs/:slug/annotations               → create (session OR guest)
//   GET   /api/docs/:slug/annotations               → list
//   POST  /api/docs/:slug/annotations/:id/comments  → comment/reply (session OR guest)
//   PATCH /api/docs/:slug/annotations/:id/resolution → resolve/reopen
// All gated by the single resolveAccess (session OPTIONAL, no requireWorkspaceMember),
// existence-hiding to 404 on no-access. Guest writes additionally require guest commenting
// on (C-005), are rate-limited per IP+doc (C-008), carry a server-enforced guest marker and
// reject a name colliding with an active member (C-009).
//
// Exercises the HTTP glue only — fake repos + fake resolveSession + fake resolveAccess +
// fake loadShareConfig (+ the S-004 seams: rateLimit, isActiveMemberName) injected so
// route→service runs without Postgres.

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { SessionResolver } from "../../src/http/auth-gate";
import type { Role } from "../../src/sharing/roles";
import type { Viewer } from "../../src/sharing/access";
import type { AccessResult } from "../../src/sharing/resolve-access";
import type { DocLookup, DocLookupRepo } from "../../src/routes/versions";
import type {
  AnnotationLookupRepo,
  LoadShareConfig,
  CommentRateLimiter,
  IsActiveMemberName,
} from "../../src/routes/annotations";
import type { AnnotationRepo, AnnotationRow, NewAnnotation, ViewerComment } from "../../src/annotation/annotation";
import type { CommentRepo, CommentRow, NewComment } from "../../src/annotation/reply";
import type { GuestCommentRepo, NewGuestComment } from "../../src/annotation/guest";
import type { ResolutionRepo, AnnotationStatus } from "../../src/annotation/resolve";
import type { SuggestionRepo, SuggestionRow, SuggestionStatus } from "../../src/annotation/suggestion";
import type { DeleteRepo, RestoreRepo } from "../../src/annotation/delete";
import type { MailEnqueuer, NewNotification, NotifyRepo } from "../../src/notify/notify";

const member: SessionResolver = async () => ({ userId: "u_member" });
const noSession: SessionResolver = async () => null;
const asCommenter = async (): Promise<Role | null> => "commenter";

const VISIBLE_DOC: DocLookup = {
  id: "doc_1",
  title: "Doc One",
  kind: "markdown",
  generalAccess: "anyone_with_link",
};

const TEXT_ANCHOR = { blockId: "block-p-1", textSnippet: "hello", offset: 0, length: 5 };

function fakeAnnotationRepo(seed: AnnotationRow[] = [], commentSeed: (ViewerComment & { annotationId: string })[] = []) {
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

function fakeGuestCommentRepo() {
  const calls = { inserts: [] as NewGuestComment[] };
  let n = 0;
  const repo: GuestCommentRepo = {
    async listByAnnotation() {
      return [];
    },
    async insertComment(input: NewGuestComment) {
      calls.inserts.push(input);
      return { id: `g_${++n}` };
    },
  };
  return { repo, calls };
}

function fakeDeleteRepo() {
  const calls = { deleted: [] as string[] };
  const repo: DeleteRepo = {
    async setDeletedAt(annotationId) {
      calls.deleted.push(annotationId);
    },
  };
  return { repo, calls };
}

// annotation-actions S-005 / C-007: a fake restore repo recording every clearDeletedAt so a
// no-op (refused) restore is observable.
function fakeRestoreRepo() {
  const calls = { restored: [] as string[] };
  const repo: RestoreRepo = {
    async clearDeletedAt(annotationId) {
      calls.restored.push(annotationId);
    },
  };
  return { repo, calls };
}

function fakeResolutionRepo() {
  const calls = { sets: [] as { id: string; status: AnnotationStatus }[] };
  const repo: ResolutionRepo = {
    async setAnnotationStatus(annotationId, status) {
      calls.sets.push({ id: annotationId, status });
    },
    async resetSuggestionStatusToPending() {},
  };
  return { repo, calls };
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

function fakeAnnotationLookupRepo(
  doc?: { docId: string; generalAccess: DocLookup["generalAccess"]; authorId?: string | null } | null,
): AnnotationLookupRepo {
  const parent =
    doc === undefined ? { docId: "doc_1", generalAccess: "anyone_with_link" as const, authorId: null } : doc;
  return {
    async findAnnotationDoc() {
      // S-004/C-006: include authorId (null unless the caller seeded one) for the delete-own gate.
      return parent === null ? null : { ...parent, authorId: parent.authorId ?? null };
    },
    async findSuggestionDoc() {
      return parent;
    },
    async getCurrentVersionContent() {
      return null;
    },
  };
}

function fakeNotifyRepo(): NotifyRepo & { inserted: NewNotification[] } {
  const inserted: NewNotification[] = [];
  return {
    inserted,
    async listParticipantIds() {
      return ["B"];
    },
    async getDocOwnerId() {
      return "C";
    },
    async getUserEmail(userId) {
      return `${userId}@example.com`;
    },
    async insertNotification(input) {
      inserted.push(input);
      return { id: `n_${inserted.length}` };
    },
  };
}

function fakeMail(): MailEnqueuer & { sent: { to: string }[] } {
  const sent: { to: string }[] = [];
  return {
    sent,
    enqueue(msg) {
      sent.push({ to: msg.to });
      return `mail_${sent.length}`;
    },
  };
}

const guestOn: LoadShareConfig = async () => ({ guestCommentingEnabled: true });
const guestOff: LoadShareConfig = async () => ({ guestCommentingEnabled: false });
const allowAll: CommentRateLimiter = async () => ({ allowed: true });
const noMemberCollision: IsActiveMemberName = async () => false;

function buildApp(opts: {
  resolveSession?: SessionResolver;
  resolveDocRole?: (docId: string, userId: string) => Promise<Role | null>;
  doc?: DocLookup | null;
  resolveAccess?: (docId: string, viewer: Viewer) => Promise<AccessResult>;
  annotationRepo?: ReturnType<typeof fakeAnnotationRepo>;
  commentRepo?: ReturnType<typeof fakeCommentRepo>;
  guestCommentRepo?: ReturnType<typeof fakeGuestCommentRepo>;
  resolutionRepo?: ReturnType<typeof fakeResolutionRepo>;
  // annotation-actions S-002: override the suggestion lookup so a PROPOSAL (suggestion present)
  // can be seeded for the resolution route. Default (omitted) → getSuggestion returns null (remark).
  suggestionRepo?: SuggestionRepo;
  deleteRepo?: ReturnType<typeof fakeDeleteRepo>;
  restoreRepo?: ReturnType<typeof fakeRestoreRepo>;
  annotationLookupRepo?: AnnotationLookupRepo;
  loadShareConfig?: LoadShareConfig;
  rateLimitComment?: CommentRateLimiter;
  isActiveMemberName?: IsActiveMemberName;
  notify?: { repo: NotifyRepo; mail: MailEnqueuer };
}) {
  const resolveDocRole = opts.resolveDocRole ?? asCommenter;
  const defaultAccess = async (docId: string, viewer: Viewer): Promise<AccessResult> => {
    const role = viewer.kind === "user" ? await resolveDocRole(docId, viewer.userId) : "commenter";
    return { role, canView: true };
  };
  return createApp({
    dbCheck: async () => {},
    annotations: {
      annotationRepo: (opts.annotationRepo ?? fakeAnnotationRepo()).repo,
      commentRepo: (opts.commentRepo ?? fakeCommentRepo()).repo,
      guestCommentRepo: (opts.guestCommentRepo ?? fakeGuestCommentRepo()).repo,
      resolutionRepo: (opts.resolutionRepo ?? fakeResolutionRepo()).repo,
      deleteRepo: (opts.deleteRepo ?? fakeDeleteRepo()).repo,
      restoreRepo: (opts.restoreRepo ?? fakeRestoreRepo()).repo,
      suggestionRepo: opts.suggestionRepo ?? {
        async insertSuggestion() { return { id: "s" }; },
        async getSuggestion() { return null; },
        async setSuggestionStatus() {},
      },
      lookupRepo: fakeLookupRepo(opts.doc === undefined ? VISIBLE_DOC : opts.doc),
      annotationLookupRepo: opts.annotationLookupRepo ?? fakeAnnotationLookupRepo(),
      resolveSession: opts.resolveSession ?? member,
      resolveWorkspaceRole: async () => "member",
      resolveDocRole,
      resolveAccess: opts.resolveAccess ?? defaultAccess,
      loadShareConfig: opts.loadShareConfig ?? guestOff,
      rateLimitComment: opts.rateLimitComment ?? allowAll,
      isActiveMemberName: opts.isActiveMemberName ?? noMemberCollision,
      ...(opts.notify ? { notify: opts.notify } : {}),
    },
  });
}

const denyAll = async (): Promise<AccessResult> => ({ role: null, canView: false });

function req(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
    ...init,
  });
}

// ── AS-017: signed-in commenter creates an annotation via the DOC link ───────
describe("AS-017: a signed-in commenter comments via the doc link (doc-scoped)", () => {
  test("AS-017: POST /api/docs/:slug/annotations → 201 { annotationId }, anchored, addressed by the doc", async () => {
    const ar = fakeAnnotationRepo();
    const app = buildApp({ resolveSession: member, resolveDocRole: asCommenter, annotationRepo: ar });
    const res = await app.handle(
      req("/api/docs/doc-one/annotations", { method: "POST", body: JSON.stringify({ anchor: TEXT_ANCHOR }) }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.data.annotationId).toBeString();
    // anchored to the selection (block + offset/length carried verbatim)
    expect(ar.calls.inserts[0]?.anchor.blockId).toBe("block-p-1");
    expect(ar.calls.inserts[0]?.docId).toBe("doc_1");
  });

  test("AS-017: GET /api/docs/:slug/annotations → 200 { items } (doc-scoped list)", async () => {
    const ar = fakeAnnotationRepo([
      { id: "a1", docId: "doc_1", type: "range", anchor: TEXT_ANCHOR as any, isOrphaned: false, status: "unresolved" },
    ]);
    const app = buildApp({ resolveSession: member, resolveDocRole: asCommenter, annotationRepo: ar });
    const res = await app.handle(req("/api/docs/doc-one/annotations"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.items).toHaveLength(1);
  });

  test("AS-017: no-access doc → 404 (existence-hiding), nothing created", async () => {
    const ar = fakeAnnotationRepo();
    const app = buildApp({ resolveSession: member, resolveAccess: denyAll, doc: { ...VISIBLE_DOC, generalAccess: "restricted" }, annotationRepo: ar });
    const res = await app.handle(
      req("/api/docs/doc-one/annotations", { method: "POST", body: JSON.stringify({ anchor: TEXT_ANCHOR }) }),
    );
    expect(res.status).toBe(404);
    expect(ar.calls.inserts).toHaveLength(0);
  });
});

// ── AS-018 / C-005 / C-009: guest comments with a name, marked server-side ───
describe("AS-018 / C-005 / C-009: guest comment with a name on anyone_with_link + guest-on", () => {
  test("AS-018: anon guest comment → 201, attributed to the guest name AND marked guest server-side (authorId null)", async () => {
    const gr = fakeGuestCommentRepo();
    const app = buildApp({ resolveSession: noSession, loadShareConfig: guestOn, guestCommentRepo: gr });
    const res = await app.handle(
      req("/api/docs/doc-one/annotations/ann_1/comments", {
        method: "POST",
        body: JSON.stringify({ body: "guest here", guestName: "Sam" }),
      }),
    );
    expect(res.status).toBe(201);
    // attribution: the guest name is stored
    expect(gr.calls.inserts[0]?.guestName).toBe("Sam");
    // C-009: the guest marker is server-enforced (no account author), not just a client badge
    expect(gr.calls.inserts[0]?.authorId).toBeNull();
  });

  test("C-005: an anon write to a guest-on doc requires NO session and still admits (anyone_with_link)", async () => {
    const gr = fakeGuestCommentRepo();
    const app = buildApp({ resolveSession: noSession, loadShareConfig: guestOn, guestCommentRepo: gr });
    const res = await app.handle(
      req("/api/docs/doc-one/annotations/ann_1/comments", {
        method: "POST",
        body: JSON.stringify({ body: "hi", guestName: "Sam" }),
      }),
    );
    expect(res.status).toBe(201);
  });
});

// ── AS-019 / C-005: guest comment refused when guest commenting is OFF ────────
describe("AS-019 / C-005: guest comment refused when guest commenting is off", () => {
  test("AS-019: anon comment on a guest-OFF doc → refused (401), no comment created", async () => {
    const gr = fakeGuestCommentRepo();
    const app = buildApp({ resolveSession: noSession, loadShareConfig: guestOff, guestCommentRepo: gr });
    const res = await app.handle(
      req("/api/docs/doc-one/annotations/ann_1/comments", {
        method: "POST",
        body: JSON.stringify({ body: "hi", guestName: "Sam" }),
      }),
    );
    expect(res.status).toBe(401);
    expect(gr.calls.inserts).toHaveLength(0);
  });
});

// ── AS-021: reply + resolve, addressed by the annotation id ───────────────────
describe("AS-021: reply to an existing annotation, then resolve it", () => {
  test("AS-021: POST /api/docs/:slug/annotations/:id/comments (reply) → 201, addressed by the annotation id", async () => {
    const cr = fakeCommentRepo([
      { id: "root", annotationId: "ann_1", parentId: null, authorId: "u_x", guestName: null, body: "root" },
    ]);
    const app = buildApp({ resolveSession: member, resolveDocRole: asCommenter, commentRepo: cr });
    const res = await app.handle(
      req("/api/docs/doc-one/annotations/ann_1/comments", {
        method: "POST",
        body: JSON.stringify({ body: "me too", parentId: "root" }),
      }),
    );
    expect(res.status).toBe(201);
    expect(cr.calls.inserts[0]?.annotationId).toBe("ann_1");
    expect(cr.calls.inserts[0]?.parentId).toBe("root");
  });

  test("AS-021: PATCH /api/docs/:slug/annotations/:id/resolution → 200 { status: resolved }, by the annotation id", async () => {
    const rr = fakeResolutionRepo();
    const app = buildApp({ resolveSession: member, resolveDocRole: asCommenter, resolutionRepo: rr });
    const res = await app.handle(
      req("/api/docs/doc-one/annotations/ann_1/resolution", { method: "PATCH", body: JSON.stringify({ resolved: true }) }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.status).toBe("resolved");
    expect(rr.calls.sets[0]).toEqual({ id: "ann_1", status: "resolved" });
  });
});

// ── AS-022 / C-008: rate limit + mail gating ──────────────────────────────────
describe("AS-022 / C-008 / C-013: anonymous comment writes are rate-limited (keyed IP:doc, signed-in bypass) and don't amplify mail", () => {
  test("AS-022: an anon comment past the per-IP/per-doc rate limit → 429, no comment created", async () => {
    const gr = fakeGuestCommentRepo();
    const overLimit: CommentRateLimiter = async () => ({ allowed: false });
    const app = buildApp({ resolveSession: noSession, loadShareConfig: guestOn, guestCommentRepo: gr, rateLimitComment: overLimit });
    const res = await app.handle(
      req("/api/docs/doc-one/annotations/ann_1/comments", {
        method: "POST",
        body: JSON.stringify({ body: "flood", guestName: "Sam" }),
      }),
    );
    expect(res.status).toBe(429);
    expect(gr.calls.inserts).toHaveLength(0);
  });

  test("AS-022: the rate limiter is keyed by IP + doc", async () => {
    const seen: { key: string }[] = [];
    const limiter: CommentRateLimiter = async (key) => {
      seen.push({ key });
      return { allowed: true };
    };
    const app = buildApp({ resolveSession: noSession, loadShareConfig: guestOn, rateLimitComment: limiter });
    await app.handle(
      req("/api/docs/doc-one/annotations/ann_1/comments", {
        method: "POST",
        body: JSON.stringify({ body: "hi", guestName: "Sam" }),
      }),
    );
    // the key derives from the caller IP AND the parent doc id
    expect(seen[0]?.key).toContain("203.0.113.7");
    expect(seen[0]?.key).toContain("doc_1");
  });

  test("AS-022 / C-008: when the limiter refuses, NO reply-notification email is enqueued (no mail flood)", async () => {
    const notifyRepo = fakeNotifyRepo();
    const mail = fakeMail();
    const overLimit: CommentRateLimiter = async () => ({ allowed: false });
    const app = buildApp({
      resolveSession: noSession,
      loadShareConfig: guestOn,
      rateLimitComment: overLimit,
      notify: { repo: notifyRepo, mail },
    });
    const res = await app.handle(
      req("/api/docs/doc-one/annotations/ann_1/comments", {
        method: "POST",
        body: JSON.stringify({ body: "flood", guestName: "Sam" }),
      }),
    );
    expect(res.status).toBe(429);
    // gated behind the SAME limiter — a refused write enqueues zero mail.
    expect(mail.sent).toHaveLength(0);
    expect(notifyRepo.inserted).toHaveLength(0);
  });

  test("AS-022: an ALLOWED anon comment still notifies (limiter gates only the excess)", async () => {
    const notifyRepo = fakeNotifyRepo();
    const mail = fakeMail();
    const app = buildApp({
      resolveSession: noSession,
      loadShareConfig: guestOn,
      rateLimitComment: allowAll,
      notify: { repo: notifyRepo, mail },
    });
    const res = await app.handle(
      req("/api/docs/doc-one/annotations/ann_1/comments", {
        method: "POST",
        body: JSON.stringify({ body: "ok", guestName: "Sam" }),
      }),
    );
    expect(res.status).toBe(201);
    expect(mail.sent.length).toBeGreaterThan(0);
  });

  test("AS-022: a SIGNED-IN comment is NOT subject to the anon rate limiter", async () => {
    const seen: string[] = [];
    const limiter: CommentRateLimiter = async (key) => {
      seen.push(key);
      return { allowed: false };
    };
    const cr = fakeCommentRepo([
      { id: "root", annotationId: "ann_1", parentId: null, authorId: "u_x", guestName: null, body: "root" },
    ]);
    const app = buildApp({ resolveSession: member, resolveDocRole: asCommenter, commentRepo: cr, rateLimitComment: limiter });
    const res = await app.handle(
      req("/api/docs/doc-one/annotations/ann_1/comments", {
        method: "POST",
        body: JSON.stringify({ body: "member reply", parentId: "root" }),
      }),
    );
    // the signed-in path is unaffected by the anon limiter (it's the anon write surface that floods)
    expect(res.status).toBe(201);
    expect(seen).toHaveLength(0);
  });
});

// ── AS-023 / C-009: a guest cannot impersonate a member ───────────────────────
describe("AS-023 / C-009 / C-014: a guest cannot impersonate a member or the doc owner", () => {
  test("AS-023: a guest name colliding with an active member's display name → rejected (no comment created)", async () => {
    const gr = fakeGuestCommentRepo();
    const collides: IsActiveMemberName = async (_docId, name) => name.trim().toLowerCase() === "alice chen";
    const app = buildApp({ resolveSession: noSession, loadShareConfig: guestOn, guestCommentRepo: gr, isActiveMemberName: collides });
    const res = await app.handle(
      req("/api/docs/doc-one/annotations/ann_1/comments", {
        method: "POST",
        body: JSON.stringify({ body: "I am Alice", guestName: "Alice Chen" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(gr.calls.inserts).toHaveLength(0);
  });

  test("AS-023: a non-colliding guest name is accepted AND still marked guest server-side (authorId null)", async () => {
    const gr = fakeGuestCommentRepo();
    const collides: IsActiveMemberName = async (_docId, name) => name.trim().toLowerCase() === "alice chen";
    const app = buildApp({ resolveSession: noSession, loadShareConfig: guestOn, guestCommentRepo: gr, isActiveMemberName: collides });
    const res = await app.handle(
      req("/api/docs/doc-one/annotations/ann_1/comments", {
        method: "POST",
        body: JSON.stringify({ body: "hi", guestName: "Bob" }),
      }),
    );
    expect(res.status).toBe(201);
    expect(gr.calls.inserts[0]?.guestName).toBe("Bob");
    expect(gr.calls.inserts[0]?.authorId).toBeNull();
  });

  test("AS-023: a signed-in member is NOT subject to the member-name collision check (only guests are)", async () => {
    const checked: string[] = [];
    const collides: IsActiveMemberName = async (_docId, name) => {
      checked.push(name);
      return true;
    };
    const cr = fakeCommentRepo([
      { id: "root", annotationId: "ann_1", parentId: null, authorId: "u_x", guestName: null, body: "root" },
    ]);
    const app = buildApp({ resolveSession: member, resolveDocRole: asCommenter, commentRepo: cr, isActiveMemberName: collides });
    const res = await app.handle(
      req("/api/docs/doc-one/annotations/ann_1/comments", {
        method: "POST",
        body: JSON.stringify({ body: "member reply", parentId: "root" }),
      }),
    );
    expect(res.status).toBe(201);
    // the collision check is a GUEST-only guard (a member's identity is the session, not a typed name)
    expect(checked).toHaveLength(0);
  });
});

// ── annotation-actions S-004 / C-006: DELETE an annotation (own / owner-moderate) ─────
//
// DELETE /api/docs/:slug/annotations/:id — session-REQUIRED (anon refused before authz),
// existence-hiding 404 on a no-access/missing parent doc, then own (author_id===actor) /
// owner-moderation gate. A parent lookup that serves the annotation's author_id binds the
// own-check to THAT annotation.

// A lookup repo that serves a parent doc + a seeded author_id for the delete-own gate.
function lookupWithAuthor(
  authorId: string | null,
  generalAccess: DocLookup["generalAccess"] = "anyone_with_link",
  deletedAt: Date | null = null,
): AnnotationLookupRepo {
  return {
    async findAnnotationDoc() {
      // S-005/C-007: deletedAt surfaced (not filtered) so the terminal guard + restore see it.
      return { docId: "doc_1", generalAccess, authorId, deletedAt };
    },
    async findSuggestionDoc() {
      return { docId: "doc_1", generalAccess, deletedAt };
    },
    async getCurrentVersionContent() {
      return null;
    },
  };
}

const asViewer = async (): Promise<Role | null> => "viewer";
const asOwner = async (): Promise<Role | null> => "owner";

describe("AS-008 / AS-009 / C-006: delete an annotation — own, or owner moderation (soft)", () => {
  test("AS-008: the author (author_id === acting user) deletes their own → 200, soft-deleted", async () => {
    // Lan (commenter, author_id=Lan) signed in; she is NOT the owner — delete-own is authorized by authorship.
    const lan: SessionResolver = async () => ({ userId: "u_lan" });
    const dr = fakeDeleteRepo();
    const app = buildApp({
      resolveSession: lan,
      resolveDocRole: asCommenter,
      annotationLookupRepo: lookupWithAuthor("u_lan"),
      deleteRepo: dr,
    });
    const res = await app.handle(req("/api/docs/doc-one/annotations/ann_1", { method: "DELETE" }));
    expect(res.status).toBe(200);
    // soft-deleted: the tombstone write fired for this annotation id.
    expect(dr.calls.deleted).toEqual(["ann_1"]);
  });

  test("AS-009: the owner Sara (≠ author Lan) deletes another's → 200, soft-deleted (moderation)", async () => {
    const sara: SessionResolver = async () => ({ userId: "u_sara" });
    const dr = fakeDeleteRepo();
    const app = buildApp({
      resolveSession: sara,
      resolveDocRole: asOwner,
      annotationLookupRepo: lookupWithAuthor("u_lan"), // authored by Lan, Sara owns the doc
      deleteRepo: dr,
    });
    const res = await app.handle(req("/api/docs/doc-one/annotations/ann_1", { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(dr.calls.deleted).toEqual(["ann_1"]);
  });
});

describe("AS-010 / AS-011 / C-006: a non-owner non-author and a viewer cannot delete", () => {
  test("AS-010: Bob (commenter, neither author nor owner) → 403, nothing deleted", async () => {
    const bob: SessionResolver = async () => ({ userId: "u_bob" });
    const dr = fakeDeleteRepo();
    const app = buildApp({
      resolveSession: bob,
      resolveDocRole: asCommenter,
      annotationLookupRepo: lookupWithAuthor("u_lan"), // authored by Lan, Bob is not the owner
      deleteRepo: dr,
    });
    const res = await app.handle(req("/api/docs/doc-one/annotations/ann_1", { method: "DELETE" }));
    expect(res.status).toBe(403);
    expect(dr.calls.deleted).toHaveLength(0);
  });

  test("AS-011: a viewer → 403, nothing deleted", async () => {
    const viewer: SessionResolver = async () => ({ userId: "u_viewer" });
    const dr = fakeDeleteRepo();
    const app = buildApp({
      resolveSession: viewer,
      resolveDocRole: asViewer,
      annotationLookupRepo: lookupWithAuthor("u_other"),
      deleteRepo: dr,
    });
    const res = await app.handle(req("/api/docs/doc-one/annotations/ann_1", { method: "DELETE" }));
    expect(res.status).toBe(403);
    expect(dr.calls.deleted).toHaveLength(0);
  });
});

describe("AS-012 / C-006: delete is session-required — an unauthenticated/guest request is refused before any authz", () => {
  test("AS-012: a no-session (guest) delete → 401, refused BEFORE any own/owner check (no delete)", async () => {
    const dr = fakeDeleteRepo();
    // Even if the parent doc is fully accessible (anyone_with_link) and a guest 'created' it,
    // delete is session-required: refused 401, BEFORE resolving author_id / role.
    const app = buildApp({
      resolveSession: noSession,
      loadShareConfig: guestOn,
      annotationLookupRepo: lookupWithAuthor(null),
      deleteRepo: dr,
    });
    const res = await app.handle(req("/api/docs/doc-one/annotations/ann_1", { method: "DELETE" }));
    expect(res.status).toBe(401);
    expect(dr.calls.deleted).toHaveLength(0);
  });
});

describe("AS-013 / C-006: deleting on a doc the caller cannot view is indistinguishable from not-found", () => {
  test("AS-013: a signed-in caller with NO access to the parent doc → 404 (existence-hiding), not 403, nothing deleted", async () => {
    const someone: SessionResolver = async () => ({ userId: "u_someone" });
    const dr = fakeDeleteRepo();
    // The annotation exists and is authored by u_someone (so a delete-own WOULD pass on role),
    // but the parent doc is no-access → the SAME 404 as a missing id. The own/owner check runs
    // only AFTER the parent doc is resolved + access-gated, so it never even reaches authz.
    const app = buildApp({
      resolveSession: someone,
      resolveAccess: denyAll,
      doc: { ...VISIBLE_DOC, generalAccess: "restricted" },
      annotationLookupRepo: lookupWithAuthor("u_someone", "restricted"),
      deleteRepo: dr,
    });
    const res = await app.handle(req("/api/docs/doc-one/annotations/ann_1", { method: "DELETE" }));
    expect(res.status).toBe(404);
    expect(dr.calls.deleted).toHaveLength(0);
  });

  test("AS-013: a missing annotation id → the SAME 404 (indistinguishable), nothing deleted", async () => {
    const someone: SessionResolver = async () => ({ userId: "u_someone" });
    const dr = fakeDeleteRepo();
    // findAnnotationDoc returns null (no such id) → existence-hiding 404, the same response a
    // no-access doc gives, so a caller can't tell a missing id from a hidden one.
    const missingLookup: AnnotationLookupRepo = {
      async findAnnotationDoc() {
        return null;
      },
      async findSuggestionDoc() {
        return null;
      },
      async getCurrentVersionContent() {
        return null;
      },
    };
    const app = buildApp({
      resolveSession: someone,
      annotationLookupRepo: missingLookup,
      deleteRepo: dr,
    });
    const res = await app.handle(req("/api/docs/doc-one/annotations/ann_missing", { method: "DELETE" }));
    expect(res.status).toBe(404);
    expect(dr.calls.deleted).toHaveLength(0);
  });
});

// ── annotation-actions S-005 / C-007: soft-delete is terminal at the route boundary ──
describe("AS-015 / C-007: resolve/reopen on a soft-deleted annotation is refused (terminal) via the doc route", () => {
  test("AS-015: PATCH resolution on a SOFT-DELETED annotation → 404 (existence-hiding), status untouched", async () => {
    // A deleted annotation reads as gone — even a commenter who could ordinarily resolve gets a
    // not-found, NOT a 200. The resolution write must never fire for a tombstoned row.
    const rr = fakeResolutionRepo();
    const app = buildApp({
      resolveSession: member,
      resolveDocRole: asCommenter,
      // the annotation exists + is accessible, but is soft-deleted (deletedAt set) → terminal.
      annotationLookupRepo: lookupWithAuthor("u_member", "anyone_with_link", new Date("2026-06-16T00:00:00.000Z")),
      resolutionRepo: rr,
    });
    const res = await app.handle(
      req("/api/docs/doc-one/annotations/ann_1/resolution", { method: "PATCH", body: JSON.stringify({ resolved: true }) }),
    );
    expect(res.status).toBe(404);
    expect(rr.calls.sets).toHaveLength(0); // never written — terminal.
  });
});

// ── annotation-actions S-005 / C-007: restore (clear the tombstone) via the doc route ──
describe("AS-016 / C-007: restore a soft-deleted annotation — author or owner, via the doc route", () => {
  const asOwner = async (): Promise<Role | null> => "owner";
  const asViewer = async (): Promise<Role | null> => "viewer";

  test("AS-016: the author restores their own → 200 { restored: true }, tombstone cleared", async () => {
    const lan: SessionResolver = async () => ({ userId: "u_lan" });
    const rr = fakeRestoreRepo();
    const app = buildApp({
      resolveSession: lan,
      resolveDocRole: asCommenter,
      // soft-deleted (deletedAt set), authored by Lan → restore-own authorized; the lookup still
      // FINDS the deleted row (restore must see tombstoned rows; only active reads filter them).
      annotationLookupRepo: lookupWithAuthor("u_lan", "anyone_with_link", new Date("2026-06-16T00:00:00.000Z")),
      restoreRepo: rr,
    });
    const res = await app.handle(req("/api/docs/doc-one/annotations/ann_1/restore", { method: "POST" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.restored).toBe(true);
    expect(rr.calls.restored).toEqual(["ann_1"]); // back in the active list on the next read.
  });

  test("AS-016: the owner (≠ author) restores another's → 200, tombstone cleared (moderation)", async () => {
    const sara: SessionResolver = async () => ({ userId: "u_sara" });
    const rr = fakeRestoreRepo();
    const app = buildApp({
      resolveSession: sara,
      resolveDocRole: asOwner,
      annotationLookupRepo: lookupWithAuthor("u_lan", "anyone_with_link", new Date("2026-06-16T00:00:00.000Z")),
      restoreRepo: rr,
    });
    const res = await app.handle(req("/api/docs/doc-one/annotations/ann_1/restore", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(rr.calls.restored).toEqual(["ann_1"]);
  });

  test("AS-016: a non-owner non-author (Bob, commenter) cannot restore another's → 403, tombstone kept", async () => {
    const bob: SessionResolver = async () => ({ userId: "u_bob" });
    const rr = fakeRestoreRepo();
    const app = buildApp({
      resolveSession: bob,
      resolveDocRole: asCommenter,
      annotationLookupRepo: lookupWithAuthor("u_lan", "anyone_with_link", new Date("2026-06-16T00:00:00.000Z")),
      restoreRepo: rr,
    });
    const res = await app.handle(req("/api/docs/doc-one/annotations/ann_1/restore", { method: "POST" }));
    expect(res.status).toBe(403);
    expect(rr.calls.restored).toHaveLength(0);
  });

  test("AS-016: a viewer cannot restore → 403, tombstone kept", async () => {
    const viewer: SessionResolver = async () => ({ userId: "u_viewer" });
    const rr = fakeRestoreRepo();
    const app = buildApp({
      resolveSession: viewer,
      resolveDocRole: asViewer,
      annotationLookupRepo: lookupWithAuthor("u_other", "anyone_with_link", new Date("2026-06-16T00:00:00.000Z")),
      restoreRepo: rr,
    });
    const res = await app.handle(req("/api/docs/doc-one/annotations/ann_1/restore", { method: "POST" }));
    expect(res.status).toBe(403);
    expect(rr.calls.restored).toHaveLength(0);
  });

  test("C-007: restore is session-required — a no-session (guest) restore → 401 BEFORE any authz, nothing restored", async () => {
    const rr = fakeRestoreRepo();
    const app = buildApp({
      resolveSession: noSession,
      loadShareConfig: guestOn,
      annotationLookupRepo: lookupWithAuthor(null, "anyone_with_link", new Date("2026-06-16T00:00:00.000Z")),
      restoreRepo: rr,
    });
    const res = await app.handle(req("/api/docs/doc-one/annotations/ann_1/restore", { method: "POST" }));
    expect(res.status).toBe(401);
    expect(rr.calls.restored).toHaveLength(0);
  });

  test("C-007: restore on a doc the caller cannot view → 404 (existence-hiding, access-based not deleted-based), nothing restored", async () => {
    const someone: SessionResolver = async () => ({ userId: "u_someone" });
    const rr = fakeRestoreRepo();
    const app = buildApp({
      resolveSession: someone,
      resolveAccess: denyAll,
      doc: { ...VISIBLE_DOC, generalAccess: "restricted" },
      // authored by the caller (own would pass on authz) but the parent doc is no-access → 404.
      annotationLookupRepo: lookupWithAuthor("u_someone", "restricted", new Date("2026-06-16T00:00:00.000Z")),
      restoreRepo: rr,
    });
    const res = await app.handle(req("/api/docs/doc-one/annotations/ann_1/restore", { method: "POST" }));
    expect(res.status).toBe(404);
    expect(rr.calls.restored).toHaveLength(0);
  });
});

// ── annotation-actions S-002 / C-001 / C-003: a proposal is owner-closed, never ──────────
//    commenter-resolved. The resolution route classifies family by suggestion PRESENCE
//    (getSuggestion non-null = proposal). A proposal's resolve/close/reopen is OWNER-only
//    in ANY state (pending OR decided); a remark stays commenter+. Reply is orthogonal.

/** A suggestion lookup that makes the annotation a PROPOSAL in the given status (presence = proposal). */
function suggestionRepoWithStatus(status: SuggestionStatus): SuggestionRepo {
  const row: SuggestionRow = {
    id: "ann_1",
    docId: "doc_1",
    type: "suggestion",
    anchor: TEXT_ANCHOR as any,
    suggestion: { kind: "delete", from: "hello", againstVersion: 1 },
    status,
  };
  return {
    async insertSuggestion() { return { id: "ann_1" }; },
    async getSuggestion() { return row; },
    async setSuggestionStatus() {},
  };
}

const asOwnerRole = async (): Promise<Role | null> => "owner";

describe("AS-003 / C-003: a non-owner cannot resolve/close a PROPOSAL in any state (pending AND decided); the owner can", () => {
  test("AS-003: a commenter resolving a PENDING proposal → 403 (the F-3 hole closed), status untouched", async () => {
    const rr = fakeResolutionRepo();
    const app = buildApp({
      resolveSession: member,
      resolveDocRole: asCommenter,
      suggestionRepo: suggestionRepoWithStatus("pending"),
      resolutionRepo: rr,
    });
    const res = await app.handle(
      req("/api/docs/doc-one/annotations/ann_1/resolution", { method: "PATCH", body: JSON.stringify({ resolved: true }) }),
    );
    expect(res.status).toBe(403);
    expect(rr.calls.sets).toHaveLength(0); // pending proposal must NOT fall through to commenter resolve.
  });

  test("AS-003: a commenter resolving an ALREADY-DECIDED (accepted) proposal → 403, status untouched", async () => {
    const rr = fakeResolutionRepo();
    const app = buildApp({
      resolveSession: member,
      resolveDocRole: asCommenter,
      suggestionRepo: suggestionRepoWithStatus("accepted"),
      resolutionRepo: rr,
    });
    const res = await app.handle(
      req("/api/docs/doc-one/annotations/ann_1/resolution", { method: "PATCH", body: JSON.stringify({ resolved: true }) }),
    );
    expect(res.status).toBe(403);
    expect(rr.calls.sets).toHaveLength(0);
  });

  test("AS-003: the OWNER CAN close a pending proposal → 200, status resolved", async () => {
    const rr = fakeResolutionRepo();
    const app = buildApp({
      resolveSession: member,
      resolveDocRole: asOwnerRole,
      suggestionRepo: suggestionRepoWithStatus("pending"),
      resolutionRepo: rr,
    });
    const res = await app.handle(
      req("/api/docs/doc-one/annotations/ann_1/resolution", { method: "PATCH", body: JSON.stringify({ resolved: true }) }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.status).toBe("resolved");
    expect(rr.calls.sets[0]).toEqual({ id: "ann_1", status: "resolved" });
  });
});

describe("AS-004 / C-003: a non-owner can still REPLY to a proposal (reply route unaffected by the close-authority split)", () => {
  test("AS-004: a commenter replies to a proposal → 201 (participation unchanged, only closing is owner-gated)", async () => {
    const cr = fakeCommentRepo([
      { id: "root", annotationId: "ann_1", parentId: null, authorId: "u_x", guestName: null, body: "root" },
    ]);
    const app = buildApp({
      resolveSession: member,
      resolveDocRole: asCommenter,
      // the annotation IS a proposal — but the comment route never consults suggestion presence.
      suggestionRepo: suggestionRepoWithStatus("pending"),
      commentRepo: cr,
    });
    const res = await app.handle(
      req("/api/docs/doc-one/annotations/ann_1/comments", {
        method: "POST",
        body: JSON.stringify({ body: "agree, the title is redundant", parentId: "root" }),
      }),
    );
    expect(res.status).toBe(201);
    expect(cr.calls.inserts[0]?.annotationId).toBe("ann_1");
    expect(cr.calls.inserts[0]?.body).toBe("agree, the title is redundant");
  });
});

describe("C-001 / C-002 / C-003: two families carry different close vocabularies — remark commenter-closable, proposal not", () => {
  test("C-001: a remark (no suggestion) vs a proposal (suggestion) close differently for the SAME commenter", async () => {
    // Remark: getSuggestion null → commenter CAN resolve (200).
    const remarkRepo = fakeResolutionRepo();
    const remarkApp = buildApp({
      resolveSession: member,
      resolveDocRole: asCommenter,
      // default suggestionRepo (omitted) → getSuggestion null → REMARK.
      resolutionRepo: remarkRepo,
    });
    const remarkRes = await remarkApp.handle(
      req("/api/docs/doc-one/annotations/ann_1/resolution", { method: "PATCH", body: JSON.stringify({ resolved: true }) }),
    );
    expect(remarkRes.status).toBe(200);
    expect(remarkRepo.calls.sets[0]).toEqual({ id: "ann_1", status: "resolved" });

    // Proposal: getSuggestion non-null → the SAME commenter is REFUSED (403).
    const proposalRepo = fakeResolutionRepo();
    const proposalApp = buildApp({
      resolveSession: member,
      resolveDocRole: asCommenter,
      suggestionRepo: suggestionRepoWithStatus("pending"),
      resolutionRepo: proposalRepo,
    });
    const proposalRes = await proposalApp.handle(
      req("/api/docs/doc-one/annotations/ann_1/resolution", { method: "PATCH", body: JSON.stringify({ resolved: true }) }),
    );
    expect(proposalRes.status).toBe(403);
    expect(proposalRepo.calls.sets).toHaveLength(0);
  });

  test("C-002: a commenter CAN still resolve a REMARK (annotation-core AS-009/AS-010, no regression)", async () => {
    const rr = fakeResolutionRepo();
    const app = buildApp({
      resolveSession: member,
      resolveDocRole: asCommenter,
      // no suggestionRepo override → remark.
      resolutionRepo: rr,
    });
    const res = await app.handle(
      req("/api/docs/doc-one/annotations/ann_1/resolution", { method: "PATCH", body: JSON.stringify({ resolved: true }) }),
    );
    expect(res.status).toBe(200);
    expect(rr.calls.sets[0]).toEqual({ id: "ann_1", status: "resolved" });
  });

  test("C-003: proposal close owner-only; a non-owner can't resolve in any state; reopen of a decided proposal is owner-only", async () => {
    // non-owner reopen of a decided proposal → 403 (was already owner-only; still holds).
    const reopenRepo = fakeResolutionRepo();
    const reopenApp = buildApp({
      resolveSession: member,
      resolveDocRole: asCommenter,
      suggestionRepo: suggestionRepoWithStatus("rejected"),
      resolutionRepo: reopenRepo,
    });
    const reopenRes = await reopenApp.handle(
      req("/api/docs/doc-one/annotations/ann_1/resolution", { method: "PATCH", body: JSON.stringify({ resolved: false }) }),
    );
    expect(reopenRes.status).toBe(403);
    expect(reopenRepo.calls.sets).toHaveLength(0);

    // the OWNER reopening a decided proposal → 200 (resets to pending under the hood).
    const ownerRepo = fakeResolutionRepo();
    const ownerApp = buildApp({
      resolveSession: member,
      resolveDocRole: asOwnerRole,
      suggestionRepo: suggestionRepoWithStatus("rejected"),
      resolutionRepo: ownerRepo,
    });
    const ownerRes = await ownerApp.handle(
      req("/api/docs/doc-one/annotations/ann_1/resolution", { method: "PATCH", body: JSON.stringify({ resolved: false }) }),
    );
    expect(ownerRes.status).toBe(200);
    expect(ownerRepo.calls.sets[0]).toEqual({ id: "ann_1", status: "unresolved" });
  });
});
