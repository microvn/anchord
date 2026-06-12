// In-process route tests for notify-on-reply (workspace-project S-006, AS-011 / C-004).
//
// Exercise the HTTP GLUE only — the reply route dispatches a best-effort notification
// AFTER a successful comment insert — via app.handle(Request)→Response. Fake comment +
// notify repos + a fake mail enqueuer are injected so route→service→notify runs without
// Postgres; the real-DB path is covered by test/integration/notify.itest.ts.
//
// AS map:
//   AS-011  a session reply dispatches in-app + email to the OTHER participants/owner,
//           never the replier; a throwing mail queue still returns 201 (best-effort).
//   C-004   same — participants + owner, both channels, replier excluded.

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
      return { docId: VISIBLE_DOC.id, generalAccess: VISIBLE_DOC.generalAccess };
    },
    async findSuggestionDoc() {
      return null;
    },
    async getCurrentVersionContent() {
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
}) {
  return createApp({
    dbCheck: async () => {},
    annotations: {
      commentRepo: fakeCommentRepo(opts.commentSeed),
      // Unused-by-these-tests repos: stub the comment list only; the reply path needs
      // commentRepo. The other annotation repos are not exercised here.
      annotationRepo: { async insertAnnotation() { return { id: "x" }; }, async listByDoc() { return []; }, async listCommentsByDoc() { return []; } },
      guestCommentRepo: { async listByAnnotation() { return []; }, async insertComment() { return { id: "g" }; } },
      resolutionRepo: { async setAnnotationStatus() {} },
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
      accessDeps: { isInvited: () => true, isWorkspaceMember: () => true },
      loadShareConfig: async () => ({ guestCommentingEnabled: true }),
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

describe("POST /api/annotations/:id/comments dispatches notify (S-006)", () => {
  // Thread {A,B}, owner C; A replies. The root comment seeds A as an existing participant.
  const replierA: SessionResolver = async () => ({ userId: "A" });
  const seed: CommentRow[] = [
    { id: "root", annotationId: "ann_1", parentId: null, authorId: "B", guestName: null, body: "B's comment" },
  ];

  test("AS-011: a session reply enqueues in-app + email for B and C, not the replier A", async () => {
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
    expect(notifyRepo.inserted.every((n) => n.type === "reply" && n.refId === "ann_1")).toBe(true);
    // email: B and C only
    expect(mail.sent.map((m) => m.to).sort()).toEqual(["B@example.com", "C@example.com"]);
    expect(mail.sent.map((m) => m.to)).not.toContain("A@example.com");
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
