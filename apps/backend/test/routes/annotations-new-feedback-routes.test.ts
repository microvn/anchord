// In-process route tests for notify-on-new-feedback (notifications-email S-001, AS-001/AS-002).
//
// A brand-new annotation is NEW FEEDBACK (C-004): the doc owner + every active editor are
// notified in-app + email, minus the actor (C-002), minus any candidate without CURRENT doc
// access (C-003). These exercise the HTTP glue (route → createAnnotationWithComment → notify)
// via app.handle(Request)→Response with fake repos + a fake mail enqueuer.
//
// AS-002 is the LINKED-FIELD SEAM: the access-filter is wired from the REAL
// `createResolveAccess` (not a stubbed allow-all) against a real `resolveDocRole` that returns
// no role for the revoked editor — so the access-filter, not a mock, drops him.

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import { createResolveAccess } from "../../src/sharing/resolve-access";
import type { SessionResolver } from "../../src/http/auth-gate";
import type { Role } from "../../src/sharing/roles";
import type { DocLookup, DocLookupRepo } from "../../src/routes/versions";
import type { AnnotationLookupRepo } from "../../src/routes/annotations";
import type { MailEnqueuer, NewNotification, NotifyRepo } from "../../src/notify/notify";

const VISIBLE_DOC: DocLookup = {
  id: "doc_1",
  title: "Doc One",
  kind: "markdown",
  generalAccess: "restricted",
};

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

// A NotifyRepo whose owner/editor sets back the new-feedback candidate computation.
function fakeNotifyRepo(opts: {
  owner: string | null;
  editors: string[];
}): NotifyRepo & { inserted: NewNotification[] } {
  const inserted: NewNotification[] = [];
  return {
    inserted,
    async listParticipantIds() {
      return [];
    },
    async getDocOwnerId() {
      return opts.owner;
    },
    async listEditorIds() {
      return opts.editors;
    },
    async getUserEmail(userId) {
      return `${userId}@example.com`;
    },
    async getDocSlug() {
      return "spec-v2";
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

// The REAL access resolver (the seam): user path delegates to resolveDocRole; db is never
// touched on the user path (only the anon branch reads it), so a bare stub is safe.
function realResolveAccess(roleFor: (userId: string) => Role | null) {
  const dbStub = {} as never;
  return createResolveAccess(dbStub, {
    resolveDocRole: async (_docId, userId) => roleFor(userId),
  });
}

function buildApp(opts: {
  resolveSession: SessionResolver;
  notifyRepo: NotifyRepo;
  mail: MailEnqueuer;
  resolveAccess: ReturnType<typeof realResolveAccess>;
  resolveDocRole: (docId: string, userId: string) => Promise<Role | null>;
}) {
  return createApp({
    dbCheck: async () => {},
    annotations: {
      // The create path needs a real-ish annotationRepo: return a created annotation with a comment.
      annotationRepo: {
        async insertAnnotation() {
          return { id: "ann_new" };
        },
        async insertAnnotationWithComment() {
          return { id: "ann_new", commentId: "c_1" };
        },
        async listByDoc() {
          return [];
        },
        async listCommentsByDoc() {
          return [];
        },
      },
      commentRepo: { async listByAnnotation() { return []; }, async insertComment() { return { id: "c" }; } },
      guestCommentRepo: { async listByAnnotation() { return []; }, async insertComment() { return { id: "g" }; } },
      resolutionRepo: { async setAnnotationStatus() {}, async resetSuggestionStatusToPending() {} },
      deleteRepo: { async setDeletedAt() {} },
      restoreRepo: { async clearDeletedAt() {} },
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
      resolveDocRole: opts.resolveDocRole,
      resolveAccess: opts.resolveAccess,
      notify: { repo: opts.notifyRepo, mail: opts.mail, appUrl: "https://anchord.example.com" },
    },
  });
}

function req(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const createBody = JSON.stringify({
  type: "range",
  anchor: { blockId: "b1", textSnippet: "x", offset: 0, length: 1 },
  comment: { body: "this section is wrong" },
});

describe("POST create annotation dispatches new_feedback (S-001)", () => {
  // Alice owns the doc, Dan is an editor, Bob is a commenter who creates the annotation.
  const actorBob: SessionResolver = async () => ({ userId: "Bob" });

  test("AS-001: Bob creates a new annotation → Alice + Dan each get an in-app row + email; Bob (actor) gets neither", async () => {
    const notifyRepo = fakeNotifyRepo({ owner: "Alice", editors: ["Dan"] });
    const mail = fakeMail();
    // Everyone currently has access (Bob commenter; Alice/Dan editor-class).
    const resolveAccess = realResolveAccess(() => "editor");
    const app = buildApp({
      resolveSession: actorBob,
      notifyRepo,
      mail,
      resolveAccess,
      resolveDocRole: async () => "commenter",
    });

    const res = await app.handle(
      req("/api/w/ws_1/docs/spec-v2/annotations", { method: "POST", body: createBody }),
    );
    expect(res.status).toBe(201);

    // in-app: Alice + Dan only, type=new_feedback; Bob excluded
    expect(notifyRepo.inserted.map((n) => n.userId).sort()).toEqual(["Alice", "Dan"]);
    expect(notifyRepo.inserted.map((n) => n.userId)).not.toContain("Bob");
    expect(notifyRepo.inserted.every((n) => n.type === "new_feedback")).toBe(true);
    // email: Alice + Dan only
    expect(mail.sent.map((m) => m.to).sort()).toEqual(["Alice@example.com", "Dan@example.com"]);
    expect(mail.sent.map((m) => m.to)).not.toContain("Bob@example.com");
  });

  test("AS-002: a removed editor (no current access) is dropped by the REAL resolveAccess seam — no row, no email", async () => {
    const notifyRepo = fakeNotifyRepo({ owner: "Alice", editors: ["Dan"] });
    const mail = fakeMail();
    // SEAM: the real resolver grants Alice a role but returns NULL for Dan (membership revoked).
    // The access-filter, not a stub, must drop Dan.
    const resolveAccess = realResolveAccess((userId) => (userId === "Dan" ? null : "editor"));
    const app = buildApp({
      resolveSession: actorBob,
      notifyRepo,
      mail,
      resolveAccess,
      resolveDocRole: async () => "commenter",
    });

    const res = await app.handle(
      req("/api/w/ws_1/docs/spec-v2/annotations", { method: "POST", body: createBody }),
    );
    expect(res.status).toBe(201);

    // Alice notified; Dan dropped on BOTH channels by the access-filter.
    expect(notifyRepo.inserted.map((n) => n.userId)).toEqual(["Alice"]);
    expect(notifyRepo.inserted.map((n) => n.userId)).not.toContain("Dan");
    expect(mail.sent.map((m) => m.to)).toEqual(["Alice@example.com"]);
    expect(mail.sent.map((m) => m.to)).not.toContain("Dan@example.com");
  });
});
