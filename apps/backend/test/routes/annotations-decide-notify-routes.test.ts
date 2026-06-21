// In-process route tests for notify-on-suggestion-decided (notifications-email S-003,
// AS-006/AS-007 / C-002/C-003/C-007). The S-001/S-002 sibling route suites cover create
// (new_feedback) and comment (thread_activity); this is the parity suite for the DECIDE route.
//
// Exercise the HTTP GLUE only — the decide route (PATCH /api/suggestions/:id, owner-only) dispatches
// a best-effort notification AFTER a SETTLED accept/reject (past the 404 / 403-self_approve /
// 409-stale gates) — via app.handle(Request)→Response. Fake suggestion + notify repos + a fake mail
// enqueuer are injected so route→service→notify runs without Postgres; the real-DB path is the
// notify integration suite's job.
//
// The point of these (vs the S-003 UNIT tests in src/notify/notify.test.ts): catch a decide→notify
// MISWIRE the pure logic can't see — wrong arg order (author/actor swapped), premature dispatch
// placement (firing before the gates), or the wrong emitted type. So each test asserts the actual
// recipient IDENTITY and the emitted TYPE came through the REAL route, not just that "something fired".
//
// AS map:
//   AS-006  owner accepts another user's (Bob's) suggestion → Bob gets ONE in-app row
//           (type suggestion_decided) + ONE email; the deciding owner gets neither.
//   AS-006  (reject parity) owner rejects another's suggestion → same author notified.
//   AS-007  owner decides their OWN suggestion → the route 403-gates self_approve BEFORE
//           dispatch, so NO notify row/email is emitted (assert 403 AND zero enqueued).
//   C-007   a throwing mail enqueuer still returns 200 on a settled decide (best-effort, post-commit).
//   C-003   a suggestion author who lost doc access is dropped (real resolveAccess seam, like S-002).

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { SessionResolver } from "../../src/http/auth-gate";
import type { Role } from "../../src/sharing/roles";
import type { Viewer } from "../../src/sharing/access";
import type { AccessResult } from "../../src/sharing/resolve-access";
import type { DocLookup, DocLookupRepo } from "../../src/routes/versions";
import type { AnnotationLookupRepo } from "../../src/routes/annotations";
import type { SuggestionRepo, SuggestionRow, SuggestionStatus } from "../../src/annotation/suggestion";
import type { MailEnqueuer, NewNotification, NotifyRepo } from "../../src/notify/notify";

const VISIBLE_DOC: DocLookup = {
  id: "doc_1",
  title: "Doc One",
  kind: "markdown",
  generalAccess: "anyone_with_link",
};

// A suggestion whose `from` matches the current doc HTML below, so accept SETTLES (not stale).
const SUG: SuggestionRow = {
  id: "sug_1",
  docId: "doc_1",
  type: "suggestion",
  anchor: { blockId: "block-p-1", textSnippet: "hello world", offset: 0, length: 11 },
  suggestion: { kind: "replace", from: "hello", to: "hi", againstVersion: 1 },
  status: "pending",
};
const CURRENT_HTML = "<p>hello world</p>";

function fakeSuggestionRepo(seed: SuggestionRow[]): SuggestionRepo & {
  statuses: { id: string; status: SuggestionStatus }[];
} {
  const rows = [...seed];
  const statuses: { id: string; status: SuggestionStatus }[] = [];
  return {
    statuses,
    async insertSuggestion(row) {
      const id = row.id ?? "sug_new";
      rows.push({ ...row, id });
      return { id };
    },
    async getSuggestion(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async setSuggestionStatus(id, status) {
      statuses.push({ id, status });
      const r = rows.find((x) => x.id === id);
      if (r) r.status = status;
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

// findSuggestionDoc carries the proposal's durable authorId — the decide route reads it for both
// the self-approve gate and the notify recipient (the wiring under test).
function fakeAnnotationLookupRepo(authorId: string | null): AnnotationLookupRepo {
  return {
    async findAnnotationDoc() {
      return { docId: VISIBLE_DOC.id, generalAccess: VISIBLE_DOC.generalAccess, authorId };
    },
    async findSuggestionDoc() {
      return { docId: VISIBLE_DOC.id, generalAccess: VISIBLE_DOC.generalAccess, authorId };
    },
    async getCurrentVersionContent() {
      return CURRENT_HTML;
    },
    async getCurrentVersion() {
      return null;
    },
  };
}

function fakeNotifyRepo(): NotifyRepo & { inserted: NewNotification[] } {
  const inserted: NewNotification[] = [];
  return {
    inserted,
    async listParticipantIds() {
      return [];
    },
    async getDocOwnerId() {
      return null;
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
  suggestionRepo: SuggestionRepo;
  annotationLookupRepo: AnnotationLookupRepo;
  notifyRepo: NotifyRepo;
  mail: MailEnqueuer;
  // C-003 seam: lets a test revoke a recipient's access via the REAL resolveAccess the route wires
  // the access-filter from. Default admits everyone at owner (the decide route is owner-only).
  resolveAccess?: (docId: string, viewer: Viewer) => Promise<AccessResult>;
}) {
  return createApp({
    dbCheck: async () => {},
    annotations: {
      // Unused-by-these-tests repos: stubbed so the routes build without `db`. The decide path
      // only touches suggestionRepo + annotationLookupRepo + notify.
      annotationRepo: { async insertAnnotation() { return { id: "x" }; }, async insertAnnotationWithComment() { return { id: "x" }; }, async listByDoc() { return []; }, async listCommentsByDoc() { return []; } },
      commentRepo: { async listByAnnotation() { return []; }, async insertComment() { return { id: "c" }; } },
      guestCommentRepo: { async listByAnnotation() { return []; }, async insertComment() { return { id: "g" }; } },
      resolutionRepo: { async setAnnotationStatus() {}, async resetSuggestionStatusToPending() {} },
      deleteRepo: { async setDeletedAt() {} },
      restoreRepo: { async clearDeletedAt() {} },
      dismissReattachRepo: { async dismiss() {}, async reattach() {} },
      suggestionRepo: opts.suggestionRepo,
      lookupRepo: fakeLookupRepo(VISIBLE_DOC),
      annotationLookupRepo: opts.annotationLookupRepo,
      resolveSession: opts.resolveSession,
      resolveWorkspaceRole: async () => "member",
      // The decide route is owner-only — the deciding actor resolves to owner.
      resolveDocRole: async () => "owner",
      resolveAccess:
        opts.resolveAccess ?? (async (_docId, viewer) => ({ role: viewer.kind === "user" ? "owner" : null, canView: true })),
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

describe("PATCH /api/suggestions/:id dispatches suggestion_decided notify (S-003)", () => {
  // The deciding owner is `Owner`; the proposal's author is `Bob` (a different user).
  const decidingOwner: SessionResolver = async () => ({ userId: "Owner" });

  test("AS-006: owner ACCEPTS Bob's suggestion → Bob gets ONE in-app row (type suggestion_decided) + ONE email; the deciding owner gets neither", async () => {
    const notifyRepo = fakeNotifyRepo();
    const mail = fakeMail();
    const app = buildApp({
      resolveSession: decidingOwner,
      suggestionRepo: fakeSuggestionRepo([{ ...SUG, id: "sug_accept" }]),
      annotationLookupRepo: fakeAnnotationLookupRepo("Bob"),
      notifyRepo,
      mail,
    });

    const res = await app.handle(
      req("/api/w/ws_1/suggestions/sug_accept", { method: "PATCH", body: JSON.stringify({ decision: "accept" }) }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.status).toBe("accepted");

    // recipient IDENTITY: exactly Bob (the author), never the deciding Owner (self-exclusion C-002).
    expect(notifyRepo.inserted.map((n) => n.userId)).toEqual(["Bob"]);
    expect(notifyRepo.inserted.map((n) => n.userId)).not.toContain("Owner");
    // emitted TYPE came through the route as suggestion_decided, ref = the suggestion's annotation id.
    expect(notifyRepo.inserted[0]?.type).toBe("suggestion_decided");
    expect(notifyRepo.inserted[0]?.refId).toBe("sug_accept");
    // S-006 (AS-029): a NON-comment emit carries comment_id null — the panel then renders the
    // generic per-type summary (no actor/snippet to join).
    expect(notifyRepo.inserted[0]?.commentId ?? null).toBeNull();
    // ONE email, to Bob only — the high-signal channel; Owner excluded.
    expect(mail.sent.map((m) => m.to)).toEqual(["Bob@example.com"]);
    expect(mail.sent.map((m) => m.to)).not.toContain("Owner@example.com");
  });

  test("AS-006 (reject parity): owner REJECTS Bob's suggestion → Bob still notified (one row + email, type suggestion_decided)", async () => {
    const notifyRepo = fakeNotifyRepo();
    const mail = fakeMail();
    const app = buildApp({
      resolveSession: decidingOwner,
      suggestionRepo: fakeSuggestionRepo([{ ...SUG, id: "sug_reject" }]),
      annotationLookupRepo: fakeAnnotationLookupRepo("Bob"),
      notifyRepo,
      mail,
    });

    const res = await app.handle(
      req("/api/w/ws_1/suggestions/sug_reject", { method: "PATCH", body: JSON.stringify({ decision: "reject" }) }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.status).toBe("rejected");

    // The recipient rule is independent of the decision outcome — Bob notified on reject too.
    expect(notifyRepo.inserted.map((n) => n.userId)).toEqual(["Bob"]);
    expect(notifyRepo.inserted[0]?.type).toBe("suggestion_decided");
    expect(mail.sent.map((m) => m.to)).toEqual(["Bob@example.com"]);
  });

  test("AS-007: owner decides their OWN suggestion → route 403-gates self_approve BEFORE dispatch, so NO notify row/email is emitted", async () => {
    const notifyRepo = fakeNotifyRepo();
    const mail = fakeMail();
    // author === the deciding session actor (Owner) → self_approve.
    const app = buildApp({
      resolveSession: decidingOwner,
      suggestionRepo: fakeSuggestionRepo([{ ...SUG, id: "sug_self" }]),
      annotationLookupRepo: fakeAnnotationLookupRepo("Owner"),
      notifyRepo,
      mail,
    });

    const res = await app.handle(
      req("/api/w/ws_1/suggestions/sug_self", { method: "PATCH", body: JSON.stringify({ decision: "accept" }) }),
    );
    // The decide itself is forbidden (self-approve gate) — distinct from the 404 not-found case.
    expect(res.status).toBe(403);
    // Premature-dispatch guard: notify fires only PAST the gates, so nothing was enqueued.
    expect(notifyRepo.inserted).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  test("C-007: a throwing mail enqueuer still returns 200 on a settled decide (notify is best-effort, post-commit)", async () => {
    const notifyRepo = fakeNotifyRepo();
    const mail = fakeMail(true); // enqueue throws
    const app = buildApp({
      resolveSession: decidingOwner,
      suggestionRepo: fakeSuggestionRepo([{ ...SUG, id: "sug_mailboom" }]),
      annotationLookupRepo: fakeAnnotationLookupRepo("Bob"),
      notifyRepo,
      mail,
    });

    const res = await app.handle(
      req("/api/w/ws_1/suggestions/sug_mailboom", { method: "PATCH", body: JSON.stringify({ decision: "accept" }) }),
    );
    // The decision persisted; a mail failure must NOT turn it into a 500.
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.status).toBe("accepted");
  });

  test("C-003: a suggestion author who lost doc access is dropped by the REAL resolveAccess seam — no row, no email", async () => {
    const notifyRepo = fakeNotifyRepo();
    const mail = fakeMail();
    const app = buildApp({
      resolveSession: decidingOwner,
      suggestionRepo: fakeSuggestionRepo([{ ...SUG, id: "sug_revoked" }]),
      annotationLookupRepo: fakeAnnotationLookupRepo("Bob"),
      notifyRepo,
      mail,
      // The route read-gate (viewer = the deciding Owner) must admit; the per-recipient access-filter
      // (viewer = Bob) revokes Bob. Keyed on the viewer's userId.
      resolveAccess: async (_docId, viewer) => {
        const uid = viewer.kind === "user" ? viewer.userId : null;
        const canView = uid !== "Bob"; // Bob revoked; Owner (actor) retains access
        return { role: uid === "Bob" ? null : "owner", canView };
      },
    });

    const res = await app.handle(
      req("/api/w/ws_1/suggestions/sug_revoked", { method: "PATCH", body: JSON.stringify({ decision: "accept" }) }),
    );
    // The decide still settles (200); Bob is dropped by the access-filter before any channel fires.
    expect(res.status).toBe(200);
    expect(notifyRepo.inserted).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });
});
