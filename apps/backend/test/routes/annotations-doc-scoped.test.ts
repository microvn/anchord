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

function fakeAnnotationLookupRepo(doc?: { docId: string; generalAccess: DocLookup["generalAccess"] } | null): AnnotationLookupRepo {
  const parent = doc === undefined ? { docId: "doc_1", generalAccess: "anyone_with_link" as const } : doc;
  return {
    async findAnnotationDoc() {
      return parent;
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
      suggestionRepo: {
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
