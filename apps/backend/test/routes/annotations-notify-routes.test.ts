// In-process route tests for notify-on-thread-activity (notifications-email S-002,
// AS-003/AS-004/AS-023 / C-003/C-004). Supersedes the workspace-project S-006 reply-route suite.
//
// Exercise the HTTP GLUE only — the comment route dispatches a best-effort notification AFTER a
// successful comment insert — via app.handle(Request)→Response. Fake comment + notify repos + a
// fake mail enqueuer are injected so route→service→notify runs without Postgres; the real-DB path
// is covered by test/integration/notify.itest.ts.
//
// LINKED-FIELD SEAM (S-002): the participant set is read from the REAL notify repo
// (listParticipantIds), not a hand-fed recipient array; C-003's access-filter calls the route's
// REAL resolveAccess. REGRESSION NOTE: the legacy AS-011 reply test below is migrated (not
// weakened) to the new taxonomy — same route, same 201 + recipient assertions, but the emitted
// type is now `thread_activity`, not `reply`.
//
// AS map:
//   AS-003  a session reply dispatches in-app + email to the OTHER participants/owner, never the
//           replier; the emitted type is thread_activity.
//   AS-004  a top-level comment (no parentId) on an EXISTING annotation also raises thread_activity
//           (not new_feedback) — the trigger-drift fix.
//   AS-023  a guest comment notifies account-holders, never the guest.
//   C-003   a participant who lost doc access is dropped before any channel fires (real resolver).
//   C-004   participants + owner, both channels, actor excluded.

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { SessionResolver } from "../../src/http/auth-gate";
import type { Role } from "../../src/sharing/roles";
import type { DocLookup, DocLookupRepo } from "../../src/routes/versions";
import type { AnnotationLookupRepo } from "../../src/routes/annotations";
import type { CommentRepo, CommentRow, NewComment } from "../../src/annotation/reply";
import type { MailEnqueuer, NewNotification, NotifyRepo } from "../../src/notify/notify";

const asCommenter = async (): Promise<Role | null> => "commenter";

const VISIBLE_DOC: DocLookup = {
  id: "doc_1",
  title: "Doc One",
  kind: "markdown",
  generalAccess: "anyone_with_link",
};

// Minimal fakes (kept local so this file doesn't depend on the sibling test's harness).

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
      // S-004/C-006: include authorId (null) for the delete-own gate.
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

function fakeNotifyRepo(opts: { participants: string[]; owner: string | null }): NotifyRepo & {
  inserted: NewNotification[];
} {
  const inserted: NewNotification[] = [];
  return {
    inserted,
    async listParticipantIds() {
      return opts.participants;
    },
    async getDocOwnerId() {
      return opts.owner;
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

function fakeMail(throwOnEnqueue = false): MailEnqueuer & { sent: { to: string }[] } {
  const sent: { to: string }[] = [];
  return {
    sent,
    enqueue(msg) {
      if (throwOnEnqueue) throw new Error("mail boom");
      sent.push({ to: msg.to });
      return `mail_${sent.length}`;
    },
  };
}

function buildApp(opts: {
  resolveSession: SessionResolver;
  commentSeed: CommentRow[];
  notifyRepo: NotifyRepo;
  mail: MailEnqueuer;
  // C-003 seam: lets a test revoke a recipient's access via the REAL resolveAccess the route
  // wires the access-filter from. Defaults to allow-all commenter (admits the happy paths).
  resolveAccess?: (docId: string, viewer: any) => Promise<{ role: Role; canView: boolean }>;
}) {
  return createApp({
    dbCheck: async () => {},
    annotations: {
      commentRepo: fakeCommentRepo(opts.commentSeed),
      // Unused-by-these-tests repos: stub the comment list only; the reply path needs
      // commentRepo. The other annotation repos are not exercised here.
      annotationRepo: { async insertAnnotation() { return { id: "x" }; }, async insertAnnotationWithComment() { return { id: "x" }; }, async listByDoc() { return []; }, async listCommentsByDoc() { return []; } },
      guestCommentRepo: { async listByAnnotation() { return []; }, async insertComment() { return { id: "g" }; } },
      resolutionRepo: { async setAnnotationStatus() {}, async resetSuggestionStatusToPending() {} },
      // annotation-actions S-004: a no-op delete repo so the routes build without `db`.
      deleteRepo: { async setDeletedAt() {} },
      // annotation-actions S-005: a no-op restore repo so the routes build without `db`.
      restoreRepo: { async clearDeletedAt() {} },
      // annotation-core S-008: a no-op dismiss/re-attach repo so the routes build without `db`.
      dismissReattachRepo: { async dismiss() {}, async reattach() {} },
      suggestionRepo: {
        async insertSuggestion() { return { id: "s" }; },
        async getSuggestion() { return null; },
        async setSuggestionStatus() {},
      },
      lookupRepo: fakeLookupRepo(VISIBLE_DOC),
      annotationLookupRepo: fakeAnnotationLookupRepo(),
      resolveSession: opts.resolveSession,
      resolveWorkspaceRole: async () => "member",
      resolveDocRole: asCommenter,
      // doc-access-routing S-001: the single read gate admits these notify-path tests. Also the
      // C-003 access-filter seam — overridable so a test can revoke a participant's access.
      resolveAccess: opts.resolveAccess ?? (async () => ({ role: "commenter", canView: true })),
      notify: { repo: opts.notifyRepo, mail: opts.mail },
    },
  });
}

function req(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("POST /api/annotations/:id/comments dispatches thread-activity notify (S-002)", () => {
  // Thread {A,B}, owner C; A replies. The root comment seeds A as an existing participant.
  const replierA: SessionResolver = async () => ({ userId: "A" });
  const seed: CommentRow[] = [
    { id: "root", annotationId: "ann_1", parentId: null, authorId: "B", guestName: null, body: "B's comment" },
  ];

  test("AS-003: a session reply enqueues in-app + email for B and C, not the replier A (type thread_activity)", async () => {
    const notifyRepo = fakeNotifyRepo({ participants: ["A", "B"], owner: "C" });
    const mail = fakeMail();
    const app = buildApp({ resolveSession: replierA, commentSeed: seed, notifyRepo, mail });

    const res = await app.handle(
      req("/api/w/ws_1/annotations/ann_1/comments", {
        method: "POST",
        body: JSON.stringify({ body: "A's reply", parentId: "root" }),
      }),
    );
    expect(res.status).toBe(201);

    // in-app: rows for B and C only — A (the replier) excluded
    expect(notifyRepo.inserted.map((n) => n.userId).sort()).toEqual(["B", "C"]);
    expect(notifyRepo.inserted.map((n) => n.userId)).not.toContain("A");
    // taxonomy migrated: emitted type is thread_activity (NOT the legacy 'reply')
    expect(notifyRepo.inserted.every((n) => n.type === "thread_activity" && n.refId === "ann_1")).toBe(true);
    // email: B and C only
    expect(mail.sent.map((m) => m.to).sort()).toEqual(["B@example.com", "C@example.com"]);
    expect(mail.sent.map((m) => m.to)).not.toContain("A@example.com");
  });

  test("AS-027: the reply route threads the just-inserted comment id into each notification row", async () => {
    // S-006 panel enrichment: the comment-create route passes the new comment id into the notify
    // dispatch, which persists it as comment_id on every recipient's in-app row (so the read can
    // join the actor + a body excerpt). The fake comment repo returns `c_1` for the reply insert.
    const notifyRepo = fakeNotifyRepo({ participants: ["A", "B"], owner: "C" });
    const mail = fakeMail();
    const app = buildApp({ resolveSession: replierA, commentSeed: seed, notifyRepo, mail });

    const res = await app.handle(
      req("/api/w/ws_1/annotations/ann_1/comments", {
        method: "POST",
        body: JSON.stringify({ body: "A's reply", parentId: "root" }),
      }),
    );
    const commentId = ((await res.json()) as any).data.commentId;
    expect(res.status).toBe(201);
    expect(commentId).toBeTruthy();
    // Every stored row carries the triggering comment id (B + C rows) — non-null, equal to the
    // just-inserted comment. This is what backs actorName + snippet on the read (AS-027/AS-028).
    expect(notifyRepo.inserted.length).toBeGreaterThan(0);
    expect(notifyRepo.inserted.every((n) => n.commentId === commentId)).toBe(true);
  });

  test("AS-004: a TOP-LEVEL comment (no parentId) by a non-participant raises thread_activity, NOT new_feedback", async () => {
    // The drift-fix at the route seam: D posts a top-level comment on the EXISTING annotation;
    // participants {B} (read from the REAL notify repo), owner C. The route must dispatch
    // thread_activity (B + C notified), never new_feedback (which would be owner + editors).
    const notifyRepo = fakeNotifyRepo({ participants: ["B"], owner: "C" });
    const mail = fakeMail();
    const commenterD: SessionResolver = async () => ({ userId: "D" });
    const app = buildApp({ resolveSession: commenterD, commentSeed: seed, notifyRepo, mail });

    const res = await app.handle(
      req("/api/w/ws_1/annotations/ann_1/comments", {
        method: "POST",
        body: JSON.stringify({ body: "D's top-level comment" }), // NO parentId → top-level
      }),
    );
    expect(res.status).toBe(201);

    // B + C notified; D (actor) excluded; the event TYPE is thread_activity, never new_feedback.
    expect(notifyRepo.inserted.map((n) => n.userId).sort()).toEqual(["B", "C"]);
    expect(notifyRepo.inserted.map((n) => n.userId)).not.toContain("D");
    expect(notifyRepo.inserted.every((n) => n.type === "thread_activity")).toBe(true);
    expect(notifyRepo.inserted.some((n) => n.type === "new_feedback")).toBe(false);
  });

  test("C-003: a participant who lost doc access is dropped before any channel (real resolveAccess seam)", async () => {
    // Thread {A,B}, owner C; B's access revoked. A replies → only C notified. The route builds the
    // access-filter from the REAL resolveAccess below (B → canView:false), proving the seam.
    const notifyRepo = fakeNotifyRepo({ participants: ["A", "B"], owner: "C" });
    const mail = fakeMail();
    const app = buildApp({
      resolveSession: replierA,
      commentSeed: seed,
      notifyRepo,
      mail,
      // The first call (route read-gate, viewer = actor A) must admit; the per-recipient filter
      // calls revoke B. Keyed on the viewer's userId.
      resolveAccess: async (_docId, viewer) => {
        const uid = viewer?.userId;
        const canView = uid !== "B"; // B revoked; A (actor) + C retain access
        return { role: "commenter", canView };
      },
    });

    const res = await app.handle(
      req("/api/w/ws_1/annotations/ann_1/comments", {
        method: "POST",
        body: JSON.stringify({ body: "A's reply", parentId: "root" }),
      }),
    );
    expect(res.status).toBe(201);

    // B dropped by the access-filter; A is the actor → only C remains.
    expect(notifyRepo.inserted.map((n) => n.userId)).toEqual(["C"]);
    expect(notifyRepo.inserted.map((n) => n.userId)).not.toContain("B");
    expect(mail.sent.map((m) => m.to)).toEqual(["C@example.com"]);
  });

  test("AS-023: a GUEST top-level comment notifies account-holders B + C, never the guest", async () => {
    // Anon session (guest); doc link role commenter (resolveAccess admits + grants comment). The
    // guest has no account → never a recipient; B + C get thread_activity rows + email.
    const notifyRepo = fakeNotifyRepo({ participants: ["B"], owner: "C" });
    const mail = fakeMail();
    const anon: SessionResolver = async () => null;
    const app = buildApp({ resolveSession: anon, commentSeed: seed, notifyRepo, mail });

    const res = await app.handle(
      req("/api/docs/spec-v2/annotations/ann_1/comments", {
        method: "POST",
        body: JSON.stringify({ body: "guest comment", guestName: "Gina" }),
      }),
    );
    expect(res.status).toBe(201);

    // B + C notified; no guest entry; thread_activity type.
    expect(notifyRepo.inserted.map((n) => n.userId).sort()).toEqual(["B", "C"]);
    expect(notifyRepo.inserted.every((n) => n.type === "thread_activity")).toBe(true);
    expect(mail.sent.map((m) => m.to).sort()).toEqual(["B@example.com", "C@example.com"]);
  });

  test("C-004: a throwing mail queue still returns 201 (notify is best-effort, post-commit)", async () => {
    const notifyRepo = fakeNotifyRepo({ participants: ["A", "B"], owner: "C" });
    const mail = fakeMail(true); // enqueue throws
    const app = buildApp({ resolveSession: replierA, commentSeed: seed, notifyRepo, mail });

    const res = await app.handle(
      req("/api/w/ws_1/annotations/ann_1/comments", {
        method: "POST",
        body: JSON.stringify({ body: "A's reply", parentId: "root" }),
      }),
    );
    // The reply persisted; a notify/mail failure must NOT turn it into a 500.
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.data.commentId).toBeString();
  });
});

// notifications-email S-004 (AS-008) — the RESOLUTION ROUTE drives the resolved-notify dispatch.
// PATCH /api/w/:workspaceId/annotations/:id/resolution: a successful resolve/reopen notifies the
// annotation's durable CREATOR (authorId), minus the acting resolver (self-exclusion). IN-APP ONLY
// (resolved is low-signal) → ZERO emails. Drives the REAL route → setResolution → dispatchResolvedNotify
// wiring (not the notify dispatch in isolation), per the S-004 surface-coverage contract.

// A resolution-route app builder: parametrize the annotation's authorId (the creator/recipient).
function buildResolutionApp(opts: {
  resolveSession: SessionResolver;
  authorId: string | null;
  notifyRepo: NotifyRepo;
  mail: MailEnqueuer;
}) {
  return createApp({
    dbCheck: async () => {},
    annotations: {
      commentRepo: fakeCommentRepo([]),
      annotationRepo: { async insertAnnotation() { return { id: "x" }; }, async insertAnnotationWithComment() { return { id: "x" }; }, async listByDoc() { return []; }, async listCommentsByDoc() { return []; } },
      guestCommentRepo: { async listByAnnotation() { return []; }, async insertComment() { return { id: "g" }; } },
      // Toggle the status to whatever was requested (idempotent no-op in the fake).
      resolutionRepo: { async setAnnotationStatus() {}, async resetSuggestionStatusToPending() {} },
      deleteRepo: { async setDeletedAt() {} },
      restoreRepo: { async clearDeletedAt() {} },
      dismissReattachRepo: { async dismiss() {}, async reattach() {} },
      // getSuggestion → null: this is an ORDINARY annotation (a remark), so the commenter+ resolve
      // path runs (not the owner-only proposal gate).
      suggestionRepo: { async insertSuggestion() { return { id: "s" }; }, async getSuggestion() { return null; }, async setSuggestionStatus() {} },
      lookupRepo: fakeLookupRepo(VISIBLE_DOC),
      // The annotation lookup carries the durable creator (authorId) the resolved-notify recipient is.
      annotationLookupRepo: {
        async findAnnotationDoc() {
          return { docId: VISIBLE_DOC.id, generalAccess: VISIBLE_DOC.generalAccess, authorId: opts.authorId, deletedAt: null };
        },
        async findSuggestionDoc() { return null; },
        async getCurrentVersionContent() { return null; },
        async getCurrentVersion() { return null; },
      },
      resolveSession: opts.resolveSession,
      resolveWorkspaceRole: async () => "member",
      // commenter+ may resolve a remark (the actor's role; not author-gated).
      resolveDocRole: asCommenter,
      resolveAccess: async () => ({ role: "commenter", canView: true }),
      notify: { repo: opts.notifyRepo, mail: opts.mail },
    },
  });
}

describe("PATCH …/annotations/:id/resolution dispatches resolved notify (S-004, in-app only)", () => {
  test("AS-008: Carol resolves Bob's annotation → Bob gets ONE in-app row, ZERO emails, type resolved", async () => {
    const carol: SessionResolver = async () => ({ userId: "Carol" });
    const notifyRepo = fakeNotifyRepo({ participants: [], owner: null });
    const mail = fakeMail();
    const app = buildResolutionApp({ resolveSession: carol, authorId: "Bob", notifyRepo, mail });

    const res = await app.handle(
      req("/api/w/ws_1/annotations/ann_1/resolution", {
        method: "PATCH",
        body: JSON.stringify({ resolved: true }),
      }),
    );
    expect(res.status).toBe(200);

    // ONE in-app row for the creator Bob; type resolved; Carol (actor) excluded.
    expect(notifyRepo.inserted.map((n) => n.userId)).toEqual(["Bob"]);
    expect(notifyRepo.inserted.every((n) => n.type === "resolved" && n.refId === "ann_1")).toBe(true);
    // CRUX (C-006): resolved is low-signal → ZERO emails enqueued.
    expect(mail.sent).toHaveLength(0);
  });

  test("AS-008 (reopen): reopening Bob's annotation notifies Bob identically — same type, ZERO emails", async () => {
    const carol: SessionResolver = async () => ({ userId: "Carol" });
    const notifyRepo = fakeNotifyRepo({ participants: [], owner: null });
    const mail = fakeMail();
    const app = buildResolutionApp({ resolveSession: carol, authorId: "Bob", notifyRepo, mail });

    const res = await app.handle(
      req("/api/w/ws_1/annotations/ann_1/resolution", {
        method: "PATCH",
        body: JSON.stringify({ resolved: false }), // reopen
      }),
    );
    expect(res.status).toBe(200);

    expect(notifyRepo.inserted.map((n) => n.userId)).toEqual(["Bob"]);
    expect(notifyRepo.inserted.every((n) => n.type === "resolved")).toBe(true);
    expect(mail.sent).toHaveLength(0);
  });

  test("AS-008 (self-resolve, C-002): Bob resolves his OWN annotation → NO notify row", async () => {
    const bob: SessionResolver = async () => ({ userId: "Bob" });
    const notifyRepo = fakeNotifyRepo({ participants: [], owner: null });
    const mail = fakeMail();
    const app = buildResolutionApp({ resolveSession: bob, authorId: "Bob", notifyRepo, mail });

    const res = await app.handle(
      req("/api/w/ws_1/annotations/ann_1/resolution", {
        method: "PATCH",
        body: JSON.stringify({ resolved: true }),
      }),
    );
    expect(res.status).toBe(200);

    // creator == actor → self-exclusion: no in-app row, no email.
    expect(notifyRepo.inserted).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  test("C-007: a throwing notify repo still returns 200 (resolve persisted; notify best-effort)", async () => {
    const carol: SessionResolver = async () => ({ userId: "Carol" });
    const mail = fakeMail();
    // A notify repo whose insert throws — must NOT turn the resolve into a 500.
    const throwingNotify: NotifyRepo = {
      async listParticipantIds() { return []; },
      async getDocOwnerId() { return null; },
      async getUserEmail() { return null; },
      async insertNotification() { throw new Error("db boom"); },
    };
    const app = buildResolutionApp({ resolveSession: carol, authorId: "Bob", notifyRepo: throwingNotify, mail });

    const res = await app.handle(
      req("/api/w/ws_1/annotations/ann_1/resolution", {
        method: "PATCH",
        body: JSON.stringify({ resolved: true }),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.status).toBe("resolved");
  });
});
