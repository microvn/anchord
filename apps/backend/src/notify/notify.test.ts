import { test, expect, describe } from "bun:test";
import {
  computeRecipients,
  computeNewFeedbackCandidates,
  computeSuggestionDecidedRecipient,
  computeResolvedRecipient,
  notifyOnThreadActivity,
  notifyOnNewFeedback,
  notifyOnSuggestionDecided,
  notifyOnResolved,
  notifyOnDetached,
  notifyOnInvited,
  isEmailEligible,
  buildAnnotationDeepLink,
  buildEmailBody,
  type MailEnqueuer,
  type NewNotification,
  type NotifyRepo,
} from "./notify";
import type { NotificationType } from "./types";

// workspace-project S-006 — notify on reply (AS-011 / C-004). On a successful reply,
// notify (participants ∪ doc owner) − replier, deduped, over TWO channels (in-app row +
// email). The replier never notifies themselves. Pure logic against fake ports
// (mirrors reply.test.ts): a recording NotifyRepo + a recording/throwing MailEnqueuer.

// A recording fake NotifyRepo: seeds participants / owner / emails, captures inserts.
function fakeRepo(opts: {
  participants?: string[];
  owner?: string | null;
  editors?: string[];
  emails?: Record<string, string | null>;
  slug?: string | null;
}): NotifyRepo & { inserted: NewNotification[] } {
  const inserted: NewNotification[] = [];
  return {
    inserted,
    async listParticipantIds() {
      return opts.participants ?? [];
    },
    async getDocOwnerId() {
      return opts.owner ?? null;
    },
    async listEditorIds() {
      return opts.editors ?? [];
    },
    async getUserEmail(userId: string) {
      const map = opts.emails ?? {};
      // Default: every user has a synthetic email unless the test overrides to null.
      return userId in map ? map[userId] : `${userId}@example.com`;
    },
    async getDocSlug() {
      // Default slug so deep-link tests have one unless overridden to null.
      return opts.slug === undefined ? "spec-v2" : opts.slug;
    },
    async insertNotification(input: NewNotification) {
      inserted.push(input);
      return { id: `n_${inserted.length}` };
    },
  };
}

// A recording mail enqueuer; `throwOnEnqueue` lets a test prove best-effort failure.
function fakeMail(throwOnEnqueue = false): MailEnqueuer & {
  sent: { to: string; subject: string; text?: string; html?: string }[];
} {
  const sent: { to: string; subject: string; text?: string; html?: string }[] = [];
  return {
    sent,
    enqueue(msg) {
      if (throwOnEnqueue) throw new Error("mail boom");
      sent.push(msg);
      return `mail_${sent.length}`;
    },
  };
}

describe("computeRecipients (recipient set = participants ∪ owner − replier, deduped)", () => {
  test("AS-011: recipients = {B, C} when A replies; thread {A,B}, owner C — A excluded", () => {
    const recipients = computeRecipients(["A", "B"], "C", "A");
    expect(recipients.sort()).toEqual(["B", "C"]);
    expect(recipients).not.toContain("A");
  });

  test("AS-011: owner==participant deduped to ONE entry", () => {
    // C is both a participant and the owner → appears exactly once.
    const recipients = computeRecipients(["B", "C"], "C", "A");
    expect(recipients.sort()).toEqual(["B", "C"]);
    expect(recipients.filter((r) => r === "C")).toHaveLength(1);
  });

  test("AS-011: replier excluded even when they are also a participant (replier rule wins)", () => {
    // A replies in their own thread {A} with no owner → nobody to notify.
    expect(computeRecipients(["A"], null, "A")).toEqual([]);
  });

  test("AS-011: null doc owner → owner skipped, participants still notified", () => {
    expect(computeRecipients(["B"], null, "A").sort()).toEqual(["B"]);
  });

  test("AS-011: guest replier (null) excludes nobody — participants + owner still notified", () => {
    expect(computeRecipients(["A", "B"], "C", null).sort()).toEqual(["A", "B", "C"]);
  });
});

// notifications-email S-002 — notify on THREAD ACTIVITY (a comment OR reply on an EXISTING
// annotation): participants ∪ owner − actor, deduped (C-005), access-filtered (C-003), over
// in-app + email (thread_activity is high-signal, C-006), best-effort post-commit (C-007).
// REGRESSION NOTE: this describe block is the migrated workspace-project S-006 reply-path suite —
// updated (NOT weakened) to the new taxonomy: notifyOnReply → notifyOnThreadActivity,
// replierUserId → actorUserId, emitted type 'reply' → 'thread_activity'. Same recipient
// invariants (exclusion, dedup, guest, email-guard, best-effort) are still asserted.
describe("notifyOnThreadActivity (both channels fire per recipient; best-effort)", () => {
  test("AS-003: A replies thread {A,B} owner C → B and C each get in-app + email; A (replier) gets none", async () => {
    const repo = fakeRepo({ participants: ["A", "B"], owner: "C" });
    const mail = fakeMail();

    const result = await notifyOnThreadActivity({ annotationId: "ann_1", actorUserId: "A" }, { repo, mail });

    // recipients are exactly {B, C}, A excluded
    expect(result.recipients.sort()).toEqual(["B", "C"]);
    // in-app: 2 rows (B, C), none for A; type='thread_activity', ref=annotation id (NOT 'reply')
    expect(repo.inserted).toHaveLength(2);
    expect(repo.inserted.map((n) => n.userId).sort()).toEqual(["B", "C"]);
    expect(repo.inserted.every((n) => n.type === "thread_activity" && n.refId === "ann_1")).toBe(true);
    expect(repo.inserted.map((n) => n.userId)).not.toContain("A");
    // email: 2 enqueued (B, C), none for A (thread_activity is high-signal)
    expect(mail.sent).toHaveLength(2);
    expect(mail.sent.map((m) => m.to).sort()).toEqual(["B@example.com", "C@example.com"]);
    expect(mail.sent.map((m) => m.to)).not.toContain("A@example.com");
    expect(result.inAppSent).toBe(2);
    expect(result.emailsSent).toBe(2);
  });

  test("AS-004: the emitted event TYPE is thread_activity (default) — NOT reply, NOT new_feedback", async () => {
    // The drift-fix assertion: a comment on an EXISTING annotation, dispatched with NO explicit
    // type, defaults to thread_activity — it must never emit the legacy 'reply' nor 'new_feedback'.
    const repo = fakeRepo({ participants: ["B"], owner: "C" });
    const mail = fakeMail();

    await notifyOnThreadActivity({ annotationId: "ann_1", actorUserId: "D" }, { repo, mail });

    expect(repo.inserted.every((n) => n.type === "thread_activity")).toBe(true);
    expect(repo.inserted.some((n) => n.type === "reply")).toBe(false);
    expect(repo.inserted.some((n) => n.type === "new_feedback")).toBe(false);
  });

  test("AS-005: owner==participant deduped to ONE in-app row + ONE email", async () => {
    // C is owner AND a participant; A replies → recipients {B, C}, C exactly once.
    const repo = fakeRepo({ participants: ["B", "C"], owner: "C" });
    const mail = fakeMail();

    await notifyOnThreadActivity({ annotationId: "ann_1", actorUserId: "A" }, { repo, mail });

    expect(repo.inserted.filter((n) => n.userId === "C")).toHaveLength(1);
    expect(mail.sent.filter((m) => m.to === "C@example.com")).toHaveLength(1);
  });

  test("AS-005: actor is owner+participant → self-exclusion wins over BOTH relationships (one fewer, never a row)", async () => {
    // C is the owner AND a participant AND the actor → C is excluded entirely; only B remains.
    const repo = fakeRepo({ participants: ["B", "C"], owner: "C" });
    const mail = fakeMail();

    const result = await notifyOnThreadActivity({ annotationId: "ann_1", actorUserId: "C" }, { repo, mail });

    expect(result.recipients).toEqual(["B"]);
    expect(repo.inserted.map((n) => n.userId)).not.toContain("C");
  });

  test("AS-023: guest actor (null) still notifies account-holder participants + owner; guest never a recipient", async () => {
    const repo = fakeRepo({ participants: ["B"], owner: "C" });
    const mail = fakeMail();

    const result = await notifyOnThreadActivity(
      { annotationId: "ann_1", actorUserId: null },
      { repo, mail },
    );

    // B + C notified; no guest entry (guests are never in the participant set — repo lists
    // account-holder author_ids only — and a null actor removes nobody).
    expect(result.recipients.sort()).toEqual(["B", "C"]);
    expect(repo.inserted).toHaveLength(2);
    expect(mail.sent).toHaveLength(2);
  });

  test("C-003: a participant who lost doc access is dropped before any channel fires", async () => {
    // Thread {A,B}, owner C; B's access was revoked. A replies → only C notified (B dropped by
    // the access-filter seam). Same real-resolver approach S-001 (AS-002) uses.
    const repo = fakeRepo({ participants: ["A", "B"], owner: "C" });
    const mail = fakeMail();
    const hasAccess = new Set(["A", "C"]); // B revoked

    const result = await notifyOnThreadActivity(
      { annotationId: "ann_1", actorUserId: "A" },
      { repo, mail, accessFilter: async (userId) => hasAccess.has(userId) },
    );

    expect(result.recipients).toEqual(["C"]); // B dropped, A is the actor
    expect(repo.inserted.map((n) => n.userId)).toEqual(["C"]);
    expect(repo.inserted.map((n) => n.userId)).not.toContain("B");
    expect(mail.sent.map((m) => m.to)).toEqual(["C@example.com"]);
    expect(mail.sent.map((m) => m.to)).not.toContain("B@example.com");
  });

  test("C-004: recipient with no email still gets in-app; email skipped (guarded)", async () => {
    // B has no email on the user row → in-app row inserted, email NOT enqueued for B.
    const repo = fakeRepo({ participants: ["B"], owner: null, emails: { B: null } });
    const mail = fakeMail();

    const result = await notifyOnThreadActivity({ annotationId: "ann_1", actorUserId: "A" }, { repo, mail });

    expect(repo.inserted.map((n) => n.userId)).toEqual(["B"]); // in-app fired
    expect(mail.sent).toHaveLength(0); // email guarded
    expect(result.inAppSent).toBe(1);
    expect(result.emailsSent).toBe(0);
  });

  test("AS-003: empty participant set + owner present → only the owner is notified", async () => {
    // No other participants, distinct owner C; actor A → only C (the empty-set edge).
    const repo = fakeRepo({ participants: ["A"], owner: "C" });
    const mail = fakeMail();

    const result = await notifyOnThreadActivity({ annotationId: "ann_1", actorUserId: "A" }, { repo, mail });

    expect(result.recipients).toEqual(["C"]);
    expect(result.inAppSent).toBe(1);
  });

  test("AS-023: all-guest thread (no account participants) + owner → only the owner is notified", async () => {
    // Participants list is empty (every prior commenter was a guest → no account_id rows); a guest
    // comments now (actor null). Only the account-holder owner C is notified.
    const repo = fakeRepo({ participants: [], owner: "C" });
    const mail = fakeMail();

    const result = await notifyOnThreadActivity({ annotationId: "ann_1", actorUserId: null }, { repo, mail });

    expect(result.recipients).toEqual(["C"]);
    expect(repo.inserted.map((n) => n.userId)).toEqual(["C"]);
  });

  test("AS-003: no other participants and no owner → zero notifications", async () => {
    const repo = fakeRepo({ participants: ["A"], owner: null });
    const mail = fakeMail();

    const result = await notifyOnThreadActivity({ annotationId: "ann_1", actorUserId: "A" }, { repo, mail });

    expect(result.recipients).toEqual([]);
    expect(repo.inserted).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  test("C-007: a throwing mail enqueue does NOT throw out of dispatch (best-effort)", async () => {
    const repo = fakeRepo({ participants: ["B"], owner: "C" });
    const mail = fakeMail(true); // enqueue throws
    const logged: unknown[] = [];

    // Must resolve, not reject — the comment has already persisted.
    const result = await notifyOnThreadActivity(
      { annotationId: "ann_1", actorUserId: "A" },
      { repo, mail, logError: (_m, e) => logged.push(e) },
    );

    expect(result).toBeDefined();
    expect(logged).toHaveLength(1); // failure logged, not surfaced
  });

  test("C-007: a throwing repo read does NOT throw out of dispatch (best-effort)", async () => {
    const throwingRepo: NotifyRepo = {
      async listParticipantIds() {
        throw new Error("db boom");
      },
      async getDocOwnerId() {
        return null;
      },
      async getUserEmail() {
        return null;
      },
      async insertNotification() {
        return { id: "x" };
      },
    };
    const mail = fakeMail();
    const logged: unknown[] = [];

    const result = await notifyOnThreadActivity(
      { annotationId: "ann_1", actorUserId: "A" },
      { repo: throwingRepo, mail, logError: (_m, e) => logged.push(e) },
    );

    expect(result.recipients).toEqual([]);
    expect(logged).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// S-007 — email eligibility (C-006), deep-link (C-013), minimal plain-text body (C-012),
// best-effort post-commit (C-007). The per-event dispatch (S-001/S-002) is NOT built here;
// these test the reusable email/delivery seams via notifyOnThreadActivity parameterized by `type`.
// ---------------------------------------------------------------------------

describe("isEmailEligible (C-006: channel policy derived from notification type)", () => {
  test("C-006: high-signal types are email-eligible", () => {
    for (const t of ["new_feedback", "thread_activity", "suggestion_decided", "reply"] as NotificationType[]) {
      expect(isEmailEligible(t)).toBe(true);
    }
  });

  test("C-006: low-signal types are NOT email-eligible (in-app only)", () => {
    for (const t of ["resolved", "detached", "invited"] as NotificationType[]) {
      expect(isEmailEligible(t)).toBe(false);
    }
  });
});

describe("buildAnnotationDeepLink (C-013: {APP_URL}/d/{slug}#annotation-{id})", () => {
  test("C-013: builds the absolute deep-link in the exact spec format", () => {
    expect(buildAnnotationDeepLink("https://anchord.example.com", "spec-v2", "abc123")).toBe(
      "https://anchord.example.com/d/spec-v2#annotation-abc123",
    );
  });

  test("C-013: trims a trailing slash on APP_URL so the path joins clean (edge)", () => {
    expect(buildAnnotationDeepLink("https://anchord.example.com/", "spec-v2", "abc123")).toBe(
      "https://anchord.example.com/d/spec-v2#annotation-abc123",
    );
  });

  test("C-012/C-013: the email body carries the deep-link and NO doc body (minimal content)", () => {
    const link = "https://anchord.example.com/d/spec-v2#annotation-abc123";
    const body = buildEmailBody("new_feedback", link);
    expect(body).toContain(link);
    // Minimal: a short summary line + the link, nothing resembling embedded doc HTML.
    expect(body).not.toContain("<");
  });

  test("AS-028 (email guard, C-012/C-014): the email body NEVER carries the comment snippet", () => {
    // buildEmailBody takes only (type, deepLink) — it has no comment-body parameter, so the in-app
    // snippet can never leak into email. Assert the actual comment text is absent from every body.
    const snippet = "can we cap the partial refund at 50% of the original charge";
    const link = "https://anchord.example.com/d/spec-v2#annotation-abc123";
    for (const t of ["new_feedback", "thread_activity", "reply", "suggestion_decided"] as const) {
      const body = buildEmailBody(t, link);
      expect(body).not.toContain(snippet);
      expect(body).not.toContain("refund");
    }
  });
});

describe("notifyOnThreadActivity parameterized by type (S-007 email/delivery seams)", () => {
  test("AS-019.T1/T2/T3: a high-signal event sends ONE plain-text email with the absolute deep-link", async () => {
    const repo = fakeRepo({ participants: [], owner: "Alice", slug: "spec-v2" });
    const mail = fakeMail();

    const result = await notifyOnThreadActivity(
      { annotationId: "abc123", actorUserId: "Bob" },
      { repo, mail, type: "new_feedback", appUrl: "https://anchord.example.com" },
    );

    // T1: exactly ONE email (one recipient = Alice the owner; Bob the actor excluded).
    expect(result.recipients).toEqual(["Alice"]);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toBe("Alice@example.com");
    // T2: plain text — `text` set, `html` NOT set.
    expect(mail.sent[0]!.text).toBeDefined();
    expect(mail.sent[0]!.html).toBeUndefined();
    // T3: the body contains the absolute deep-link in the exact spec format.
    expect(mail.sent[0]!.text).toContain(
      "https://anchord.example.com/d/spec-v2#annotation-abc123",
    );
  });

  test("AS-021: a low-signal (resolved) event writes the in-app row but enqueues NO email", async () => {
    const repo = fakeRepo({ participants: [], owner: "Bob", slug: "spec-v2" });
    const mail = fakeMail();

    const result = await notifyOnThreadActivity(
      { annotationId: "abc123", actorUserId: "Carol" },
      { repo, mail, type: "resolved", appUrl: "https://anchord.example.com" },
    );

    expect(repo.inserted).toHaveLength(1); // in-app row written
    expect(repo.inserted[0]!.type).toBe("resolved");
    expect(result.inAppSent).toBe(1);
    expect(mail.sent).toHaveLength(0); // C-006: low-signal → no email
    expect(result.emailsSent).toBe(0);
  });

  test("C-007: a high-signal email enqueue that throws does NOT fail the action (best-effort)", async () => {
    const repo = fakeRepo({ participants: [], owner: "Alice", slug: "spec-v2" });
    const mail = fakeMail(true); // enqueue throws
    const logged: unknown[] = [];

    const result = await notifyOnThreadActivity(
      { annotationId: "abc123", actorUserId: "Bob" },
      { repo, mail, type: "new_feedback", appUrl: "https://anchord.example.com", logError: (_m, e) => logged.push(e) },
    );

    expect(result).toBeDefined(); // resolved, not rejected — the action already persisted
    expect(logged).toHaveLength(1); // swallowed + logged
  });

  test("C-013: with APP_URL present but slug null, the email still sends (summary only, link omitted)", async () => {
    const repo = fakeRepo({ participants: [], owner: "Alice", slug: null });
    const mail = fakeMail();

    const result = await notifyOnThreadActivity(
      { annotationId: "abc123", actorUserId: "Bob" },
      { repo, mail, type: "new_feedback", appUrl: "https://anchord.example.com" },
    );

    expect(result.emailsSent).toBe(1);
    expect(mail.sent[0]!.text).toBeDefined();
    expect(mail.sent[0]!.text).not.toContain("#annotation-"); // no link when slug unresolved
  });
});

// ---------------------------------------------------------------------------
// notifications-email S-001 — notify on NEW FEEDBACK (a brand-new annotation): the doc
// owner + every active editor, minus the actor (C-002), minus any candidate without current
// doc access (C-003, the access-filter seam), over in-app + email (high-signal, C-006),
// deduped (C-005). Recipients are relationship-derived server-side (C-001).
// ---------------------------------------------------------------------------

describe("computeNewFeedbackCandidates (candidates = owner ∪ editors − actor, deduped)", () => {
  test("C-001: owner Alice + editor Dan, actor Bob (commenter) → {Alice, Dan}", () => {
    const c = computeNewFeedbackCandidates("Alice", ["Dan"], "Bob");
    expect(c.sort()).toEqual(["Alice", "Dan"]);
  });

  test("C-005: owner-who-is-also-an-editor collapses to ONE entry", () => {
    // Alice is the owner AND appears in the editor list → exactly once.
    const c = computeNewFeedbackCandidates("Alice", ["Alice", "Dan"], "Bob");
    expect(c.sort()).toEqual(["Alice", "Dan"]);
    expect(c.filter((u) => u === "Alice")).toHaveLength(1);
  });

  test("C-002: actor IS the owner → owner excluded (creator of own annotation notifies no one)", () => {
    // Alice owns the doc and creates the annotation; no editors → nobody.
    expect(computeNewFeedbackCandidates("Alice", [], "Alice")).toEqual([]);
  });

  test("C-002: actor is also an editor → still self-excluded (rule wins over editor membership)", () => {
    expect(computeNewFeedbackCandidates("Alice", ["Dan", "Bob"], "Bob").sort()).toEqual([
      "Alice",
      "Dan",
    ]);
  });

  test("AS-001 edge: empty editor set, owner present → owner-only", () => {
    expect(computeNewFeedbackCandidates("Alice", [], "Bob")).toEqual(["Alice"]);
  });

  test("AS-001 edge: null owner + empty editors → no candidates", () => {
    expect(computeNewFeedbackCandidates(null, [], "Bob")).toEqual([]);
  });

  test("C-011: guest actor (null) excludes nobody — owner + editors still candidates", () => {
    expect(computeNewFeedbackCandidates("Alice", ["Dan"], null).sort()).toEqual(["Alice", "Dan"]);
  });
});

describe("notifyOnNewFeedback (owner + editors, both channels, access-filtered)", () => {
  test("AS-001.T1/T2/T3: Bob creates a new annotation → Alice + Dan each get one in-app row + one email; Bob (actor) gets neither", async () => {
    const repo = fakeRepo({ owner: "Alice", editors: ["Dan"], slug: "spec-v2" });
    const mail = fakeMail();

    const result = await notifyOnNewFeedback(
      { annotationId: "ann_1", actorUserId: "Bob" },
      { repo, mail, type: "new_feedback", appUrl: "https://anchord.example.com" },
    );

    // recipients are exactly {Alice, Dan}; Bob excluded
    expect(result.recipients.sort()).toEqual(["Alice", "Dan"]);
    expect(result.recipients).not.toContain("Bob");
    // T1: one in-app row each (type=new_feedback, ref=annotation id), none for Bob
    expect(result.inAppSent).toBe(2);
    expect(repo.inserted.map((n) => n.userId).sort()).toEqual(["Alice", "Dan"]);
    expect(repo.inserted.every((n) => n.type === "new_feedback" && n.refId === "ann_1")).toBe(true);
    expect(repo.inserted.map((n) => n.userId)).not.toContain("Bob");
    // T2: one email each (high-signal), none for Bob
    expect(result.emailsSent).toBe(2);
    expect(mail.sent.map((m) => m.to).sort()).toEqual(["Alice@example.com", "Dan@example.com"]);
    // T3: actor excluded on the email channel too
    expect(mail.sent.map((m) => m.to)).not.toContain("Bob@example.com");
  });

  test("AS-002: a candidate without current access is dropped before any channel (no row, no email)", async () => {
    // Dan was removed from the doc; Alice still has access. The access-filter (the seam in
    // prod; here a real predicate) drops Dan: no in-app row, no email — only Alice notified.
    const repo = fakeRepo({ owner: "Alice", editors: ["Dan"], slug: "spec-v2" });
    const mail = fakeMail();
    const hasAccess = new Set(["Alice"]); // Dan revoked

    const result = await notifyOnNewFeedback(
      { annotationId: "ann_1", actorUserId: "Bob" },
      {
        repo,
        mail,
        type: "new_feedback",
        appUrl: "https://anchord.example.com",
        accessFilter: async (userId) => hasAccess.has(userId),
      },
    );

    expect(result.recipients).toEqual(["Alice"]);
    expect(repo.inserted.map((n) => n.userId)).toEqual(["Alice"]);
    expect(repo.inserted.map((n) => n.userId)).not.toContain("Dan");
    expect(mail.sent.map((m) => m.to)).toEqual(["Alice@example.com"]);
    expect(mail.sent.map((m) => m.to)).not.toContain("Dan@example.com");
  });

  test("C-005: owner-also-editor gets exactly ONE in-app row + ONE email (dedup through dispatch)", async () => {
    const repo = fakeRepo({ owner: "Alice", editors: ["Alice", "Dan"], slug: "spec-v2" });
    const mail = fakeMail();

    await notifyOnNewFeedback(
      { annotationId: "ann_1", actorUserId: "Bob" },
      { repo, mail, type: "new_feedback", appUrl: "https://anchord.example.com" },
    );

    expect(repo.inserted.filter((n) => n.userId === "Alice")).toHaveLength(1);
    expect(mail.sent.filter((m) => m.to === "Alice@example.com")).toHaveLength(1);
  });

  test("C-002: actor is the owner (owner creates own annotation), no editors → no one notified", async () => {
    const repo = fakeRepo({ owner: "Alice", editors: [], slug: "spec-v2" });
    const mail = fakeMail();

    const result = await notifyOnNewFeedback(
      { annotationId: "ann_1", actorUserId: "Alice" },
      { repo, mail, type: "new_feedback", appUrl: "https://anchord.example.com" },
    );

    expect(result.recipients).toEqual([]);
    expect(repo.inserted).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  test("AS-001 edge: owner-only doc (empty editor set) → only the owner notified", async () => {
    const repo = fakeRepo({ owner: "Alice", editors: [], slug: "spec-v2" });
    const mail = fakeMail();

    const result = await notifyOnNewFeedback(
      { annotationId: "ann_1", actorUserId: "Bob" },
      { repo, mail, type: "new_feedback", appUrl: "https://anchord.example.com" },
    );

    expect(result.recipients).toEqual(["Alice"]);
    expect(result.inAppSent).toBe(1);
    expect(result.emailsSent).toBe(1);
  });

  test("C-011: a GUEST actor (null) still notifies owner + editors", async () => {
    const repo = fakeRepo({ owner: "Alice", editors: ["Dan"], slug: "spec-v2" });
    const mail = fakeMail();

    const result = await notifyOnNewFeedback(
      { annotationId: "ann_1", actorUserId: null },
      { repo, mail, type: "new_feedback", appUrl: "https://anchord.example.com" },
    );

    expect(result.recipients.sort()).toEqual(["Alice", "Dan"]);
    expect(repo.inserted).toHaveLength(2);
    expect(mail.sent).toHaveLength(2);
  });

  test("C-007: a throwing repo read does NOT throw out of dispatch (best-effort, post-commit)", async () => {
    const throwingRepo: NotifyRepo = {
      async listParticipantIds() {
        return [];
      },
      async getDocOwnerId() {
        throw new Error("db boom");
      },
      async getUserEmail() {
        return null;
      },
      async insertNotification() {
        return { id: "x" };
      },
    };
    const mail = fakeMail();
    const logged: unknown[] = [];

    const result = await notifyOnNewFeedback(
      { annotationId: "ann_1", actorUserId: "Bob" },
      { repo: throwingRepo, mail, type: "new_feedback", logError: (_m, e) => logged.push(e) },
    );

    expect(result.recipients).toEqual([]);
    expect(logged).toHaveLength(1);
  });
});

// notifications-email S-003 — notify on suggestion decided (AS-006/AS-007 / C-002, C-003, C-005).
// On a settled decision (accept OR reject), notify the proposal's AUTHOR, minus the deciding actor
// (self-exclusion). High-signal → in-app + email. A guest-authored proposal (null author) and a
// self-decided proposal both yield no recipient. Pure logic + the shared dispatch against fakes.

describe("computeSuggestionDecidedRecipient (recipient = author − actor; guest/self → none)", () => {
  test("C-001: author Bob, decider Alice (owner) → [Bob]", () => {
    expect(computeSuggestionDecidedRecipient("Bob", "Alice")).toEqual(["Bob"]);
  });

  test("C-002: author == actor (owner decided own proposal) → [] (self-exclusion, AS-007)", () => {
    expect(computeSuggestionDecidedRecipient("Alice", "Alice")).toEqual([]);
  });

  test("C-011: guest-authored proposal (null author) → [] (a guest is never a recipient)", () => {
    expect(computeSuggestionDecidedRecipient(null, "Alice")).toEqual([]);
  });

  test("C-002 edge: null author can never equal a non-null actor → [] (no crash, no recipient)", () => {
    expect(computeSuggestionDecidedRecipient(null, null)).toEqual([]);
  });
});

describe("notifyOnSuggestionDecided (author recipient, both channels, access-filtered)", () => {
  test("AS-006: Alice (owner) accepts Bob's suggestion → Bob gets ONE in-app row + ONE email; Alice (decider) gets neither", async () => {
    const repo = fakeRepo({ slug: "spec-v2" });
    const mail = fakeMail();

    const result = await notifyOnSuggestionDecided(
      { annotationId: "sug_1", authorId: "Bob", actorUserId: "Alice" },
      { repo, mail, type: "suggestion_decided", appUrl: "https://anchord.example.com" },
    );

    // recipient is exactly Bob (the author); Alice the decider excluded.
    expect(result.recipients).toEqual(["Bob"]);
    expect(result.recipients).not.toContain("Alice");
    // ONE in-app row (type=suggestion_decided, ref=the suggestion's annotation id).
    expect(result.inAppSent).toBe(1);
    expect(repo.inserted).toHaveLength(1);
    expect(repo.inserted[0]!.userId).toBe("Bob");
    expect(repo.inserted[0]!.type).toBe("suggestion_decided");
    expect(repo.inserted[0]!.refId).toBe("sug_1");
    // ONE email (high-signal), carrying the absolute deep-link; none for Alice.
    expect(result.emailsSent).toBe(1);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toBe("Bob@example.com");
    expect(mail.sent[0]!.text).toContain("https://anchord.example.com/d/spec-v2#annotation-sug_1");
    expect(mail.sent.map((m) => m.to)).not.toContain("Alice@example.com");
  });

  test("AS-006 (reject parity): rejecting notifies the SAME author identically (recipient is decision-independent)", async () => {
    // The dispatch is given only author + actor — the outcome (accept/reject) lives in the route,
    // not here — so reject reaches the author exactly as accept does. The route fires this same
    // dispatch for both the accept and the reject branch.
    const repo = fakeRepo({ slug: "spec-v2" });
    const mail = fakeMail();

    const result = await notifyOnSuggestionDecided(
      { annotationId: "sug_2", authorId: "Bob", actorUserId: "Alice" },
      { repo, mail, type: "suggestion_decided", appUrl: "https://anchord.example.com" },
    );

    expect(result.recipients).toEqual(["Bob"]);
    expect(result.inAppSent).toBe(1);
    expect(result.emailsSent).toBe(1);
  });

  test("AS-007: Alice (owner) authored AND decides her own suggestion (reject) → NO notification (self-exclusion)", async () => {
    const repo = fakeRepo({ slug: "spec-v2" });
    const mail = fakeMail();

    const result = await notifyOnSuggestionDecided(
      { annotationId: "sug_1", authorId: "Alice", actorUserId: "Alice" },
      { repo, mail, type: "suggestion_decided", appUrl: "https://anchord.example.com" },
    );

    expect(result.recipients).toEqual([]);
    expect(repo.inserted).toHaveLength(0); // no in-app row
    expect(mail.sent).toHaveLength(0); // no email
  });

  test("C-011: a guest-authored proposal (null author) → no recipient, no row, no email (no crash)", async () => {
    const repo = fakeRepo({ slug: "spec-v2" });
    const mail = fakeMail();

    const result = await notifyOnSuggestionDecided(
      { annotationId: "sug_1", authorId: null, actorUserId: "Alice" },
      { repo, mail, type: "suggestion_decided", appUrl: "https://anchord.example.com" },
    );

    expect(result.recipients).toEqual([]);
    expect(repo.inserted).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  test("C-003: the author who lost doc access is dropped before any channel (no row, no email)", async () => {
    const repo = fakeRepo({ slug: "spec-v2" });
    const mail = fakeMail();
    const hasAccess = new Set<string>(); // Bob revoked → empty allow-set

    const result = await notifyOnSuggestionDecided(
      { annotationId: "sug_1", authorId: "Bob", actorUserId: "Alice" },
      {
        repo,
        mail,
        type: "suggestion_decided",
        appUrl: "https://anchord.example.com",
        accessFilter: async (userId) => hasAccess.has(userId),
      },
    );

    expect(result.recipients).toEqual([]);
    expect(repo.inserted).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  test("C-007: a throwing mail enqueue does NOT throw out of dispatch (best-effort, decide already persisted)", async () => {
    const repo = fakeRepo({ slug: "spec-v2" });
    const mail = fakeMail(true); // enqueue throws
    const logged: unknown[] = [];

    const result = await notifyOnSuggestionDecided(
      { annotationId: "sug_1", authorId: "Bob", actorUserId: "Alice" },
      {
        repo,
        mail,
        type: "suggestion_decided",
        appUrl: "https://anchord.example.com",
        logError: (_m, e) => logged.push(e),
      },
    );

    // The in-app row was written before the mail throw; the throw is swallowed (returns empty).
    expect(result.recipients).toEqual([]);
    expect(logged).toHaveLength(1);
    // Best-effort: the row that landed before the throw stays (no rollback in notify).
    expect(repo.inserted).toHaveLength(1);
  });
});

// ===========================================================================
// notifications-email S-004 — notify on RESOLUTION (resolved/reopened) and DETACH.
// resolved + detached are LOW-SIGNAL (C-006): in-app ONLY, NEVER email. The crux of every
// assertion below is ZERO emails. Pure logic against the same fake ports.
// ===========================================================================

describe("computeResolvedRecipient (recipient = creator − actor; guest/self → none)", () => {
  test("C-001: creator Bob, resolver Carol → [Bob]", () => {
    expect(computeResolvedRecipient("Bob", "Carol")).toEqual(["Bob"]);
  });

  test("C-002: creator == actor (resolver resolved own annotation) → [] (self-exclusion, AS-008)", () => {
    expect(computeResolvedRecipient("Bob", "Bob")).toEqual([]);
  });

  test("C-011: guest-created annotation (null creator) → [] (a guest is never a recipient)", () => {
    expect(computeResolvedRecipient(null, "Carol")).toEqual([]);
  });
});

describe("notifyOnResolved (creator recipient, in-app ONLY — C-006 low-signal, NO email)", () => {
  test("AS-008: Carol resolves Bob's annotation → Bob gets ONE in-app row, ZERO emails (type resolved)", async () => {
    const repo = fakeRepo({ slug: "spec-v2" });
    const mail = fakeMail();

    const result = await notifyOnResolved(
      { annotationId: "ann_1", creatorId: "Bob", actorUserId: "Carol" },
      { repo, mail, appUrl: "https://anchord.example.com" },
    );

    // recipient is exactly Bob (the creator); Carol the resolver excluded.
    expect(result.recipients).toEqual(["Bob"]);
    expect(result.recipients).not.toContain("Carol");
    // ONE in-app row (type=resolved, ref=the annotation id).
    expect(result.inAppSent).toBe(1);
    expect(repo.inserted).toHaveLength(1);
    expect(repo.inserted[0]!.userId).toBe("Bob");
    expect(repo.inserted[0]!.type).toBe("resolved");
    expect(repo.inserted[0]!.refId).toBe("ann_1");
    // CRUX (C-006): resolved is LOW-SIGNAL → ZERO emails, even with appUrl set.
    expect(result.emailsSent).toBe(0);
    expect(mail.sent).toHaveLength(0);
  });

  test("AS-008 (reopen parity): reopening notifies the SAME creator with the SAME type, ZERO emails", async () => {
    // Reopen reaches the dispatch identically — the route fires notifyOnResolved for BOTH the
    // resolve and the reopen branch; the toggle direction is invisible here.
    const repo = fakeRepo({ slug: "spec-v2" });
    const mail = fakeMail();

    const result = await notifyOnResolved(
      { annotationId: "ann_2", creatorId: "Bob", actorUserId: "Carol" },
      { repo, mail, appUrl: "https://anchord.example.com" },
    );

    expect(result.recipients).toEqual(["Bob"]);
    expect(repo.inserted[0]!.type).toBe("resolved"); // same event type as resolve
    expect(result.inAppSent).toBe(1);
    expect(result.emailsSent).toBe(0); // still no email
    expect(mail.sent).toHaveLength(0);
  });

  test("AS-008 (self-resolve): the creator resolves their OWN annotation → NO notify (C-002)", async () => {
    const repo = fakeRepo({ slug: "spec-v2" });
    const mail = fakeMail();

    const result = await notifyOnResolved(
      { annotationId: "ann_1", creatorId: "Bob", actorUserId: "Bob" },
      { repo, mail },
    );

    expect(result.recipients).toEqual([]);
    expect(repo.inserted).toHaveLength(0); // no in-app row
    expect(mail.sent).toHaveLength(0); // no email
  });

  test("C-011 edge: a guest-created annotation (null creator) → no recipient, no row, no crash", async () => {
    const repo = fakeRepo({ slug: "spec-v2" });
    const mail = fakeMail();

    const result = await notifyOnResolved(
      { annotationId: "ann_1", creatorId: null, actorUserId: "Carol" },
      { repo, mail },
    );

    expect(result.recipients).toEqual([]);
    expect(repo.inserted).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  test("C-003: the creator who lost doc access is dropped before any channel (no row, no email)", async () => {
    const repo = fakeRepo({ slug: "spec-v2" });
    const mail = fakeMail();
    const hasAccess = new Set<string>(); // Bob revoked → empty allow-set

    const result = await notifyOnResolved(
      { annotationId: "ann_1", creatorId: "Bob", actorUserId: "Carol" },
      { repo, mail, accessFilter: async (userId) => hasAccess.has(userId) },
    );

    expect(result.recipients).toEqual([]);
    expect(repo.inserted).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  test("C-007: a throwing repo does NOT throw out of dispatch (best-effort, resolution already persisted)", async () => {
    const mail = fakeMail();
    const logged: unknown[] = [];
    const repo: NotifyRepo = {
      async listParticipantIds() { return []; },
      async getDocOwnerId() { return null; },
      async getUserEmail() { return null; },
      async insertNotification() { throw new Error("db boom"); },
    };

    const result = await notifyOnResolved(
      { annotationId: "ann_1", creatorId: "Bob", actorUserId: "Carol" },
      { repo, mail, logError: (_m, e) => logged.push(e) },
    );

    // Swallowed — returns the empty result, never throws (the resolve must not become a 500).
    expect(result).toEqual({ recipients: [], inAppSent: 0, emailsSent: 0 });
    expect(logged).toHaveLength(1);
  });
});

describe("notifyOnDetached (ONE grouped row per author, in-app ONLY — C-006 low-signal, NO email)", () => {
  test("AS-009: a 5-annotation detach burst → Bob gets ONE in-app row, ZERO emails (type detached)", async () => {
    const repo = fakeRepo({ slug: "spec-v2" });
    const mail = fakeMail();

    const result = await notifyOnDetached(
      { refId: "doc_1", authors: [{ authorId: "Bob", count: 5 }] },
      { repo, mail, appUrl: "https://anchord.example.com" },
    );

    // Exactly ONE row for Bob covering all 5 (grouped) — NOT five rows.
    expect(result.recipients).toEqual(["Bob"]);
    expect(result.inAppSent).toBe(1);
    expect(repo.inserted).toHaveLength(1);
    expect(repo.inserted[0]!.userId).toBe("Bob");
    expect(repo.inserted[0]!.type).toBe("detached");
    expect(repo.inserted[0]!.refId).toBe("doc_1");
    // CRUX (C-006): detached is LOW-SIGNAL → ZERO emails.
    expect(result.emailsSent).toBe(0);
    expect(mail.sent).toHaveLength(0);
  });

  test("AS-009 (multi-author, GAP-002): two authors in one publish → each gets exactly one row, correct refId", async () => {
    const repo = fakeRepo({ slug: "spec-v2" });
    const mail = fakeMail();

    const result = await notifyOnDetached(
      { refId: "doc_1", authors: [{ authorId: "Bob", count: 3 }, { authorId: "Dora", count: 2 }] },
      { repo, mail },
    );

    expect(result.recipients.sort()).toEqual(["Bob", "Dora"]);
    expect(result.inAppSent).toBe(2);
    expect(repo.inserted.map((n) => n.userId).sort()).toEqual(["Bob", "Dora"]);
    expect(repo.inserted.every((n) => n.type === "detached")).toBe(true);
    expect(mail.sent).toHaveLength(0); // still no email for anyone
  });

  test("AS-009 edge: empty author set (0 detached) → NO row at all (no empty notice)", async () => {
    const repo = fakeRepo({ slug: "spec-v2" });
    const mail = fakeMail();

    const result = await notifyOnDetached({ refId: "doc_1", authors: [] }, { repo, mail });

    expect(result.recipients).toEqual([]);
    expect(repo.inserted).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  test("C-005: a duplicate author entry collapses to ONE row (defensive dedup)", async () => {
    const repo = fakeRepo({ slug: "spec-v2" });
    const mail = fakeMail();

    const result = await notifyOnDetached(
      { refId: "doc_1", authors: [{ authorId: "Bob", count: 2 }, { authorId: "Bob", count: 3 }] },
      { repo, mail },
    );

    expect(result.recipients).toEqual(["Bob"]);
    expect(repo.inserted).toHaveLength(1);
  });

  test("C-003: an author who lost doc access is dropped before any channel fires", async () => {
    const repo = fakeRepo({ slug: "spec-v2" });
    const mail = fakeMail();
    const hasAccess = new Set<string>(["Dora"]); // Bob revoked, Dora retains

    const result = await notifyOnDetached(
      { refId: "doc_1", authors: [{ authorId: "Bob", count: 5 }, { authorId: "Dora", count: 1 }] },
      { repo, mail, accessFilter: async (userId) => hasAccess.has(userId) },
    );

    expect(result.recipients).toEqual(["Dora"]);
    expect(repo.inserted.map((n) => n.userId)).toEqual(["Dora"]);
  });

  test("C-007: a throwing repo does NOT throw out of dispatch (best-effort, off-publish job)", async () => {
    const mail = fakeMail();
    const logged: unknown[] = [];
    const repo: NotifyRepo = {
      async listParticipantIds() { return []; },
      async getDocOwnerId() { return null; },
      async getUserEmail() { return null; },
      async insertNotification() { throw new Error("db boom"); },
    };

    const result = await notifyOnDetached(
      { refId: "doc_1", authors: [{ authorId: "Bob", count: 5 }] },
      { repo, mail, logError: (_m, e) => logged.push(e) },
    );

    expect(result).toEqual({ recipients: [], inAppSent: 0, emailsSent: 0 });
    expect(logged).toHaveLength(1);
  });

  test("C-007b: detached + resolved are NOT email-eligible (low-signal channel confirmed)", () => {
    expect(isEmailEligible("resolved")).toBe(false);
    expect(isEmailEligible("detached")).toBe(false);
  });
});

// notifications-email S-005 — notify the invitee on being added (AS-010 / C-005 / C-006 / C-007).
// `invited` is LOW-SIGNAL → IN-APP ONLY, ZERO notify-email. The recipient is the single bound
// invitee userId resolved at invite time; a pending invite (no userId) never reaches here.
describe("notifyOnInvited (invitee in-app row — in-app only, low-signal)", () => {
  test("AS-010: an invited account-holder gets ONE in-app `invited` row, NO email", async () => {
    const repo = fakeRepo({});
    const mail = fakeMail();

    const result = await notifyOnInvited({ refId: "doc_1", inviteeUserId: "dev-user" }, { repo, mail });

    // ONE in-app row, typed `invited`, pointing at the doc (refId).
    // S-006: every row now carries comment_id — null for a non-comment type like `invited` (AS-029).
    expect(repo.inserted).toEqual([{ userId: "dev-user", type: "invited", refId: "doc_1", commentId: null }]);
    expect(result).toEqual({ recipients: ["dev-user"], inAppSent: 1, emailsSent: 0 });
    // C-006: invited is low-signal → ZERO notify-email enqueued by the notify path.
    expect(mail.sent).toHaveLength(0);
  });

  test("C-006: `invited` is NOT email-eligible (low-signal channel confirmed)", () => {
    expect(isEmailEligible("invited")).toBe(false);
  });

  test("AS-010 (pending nuance): a null invitee userId → NO in-app row (no account to attach to)", async () => {
    const repo = fakeRepo({});
    const mail = fakeMail();

    const result = await notifyOnInvited({ refId: "doc_1", inviteeUserId: null }, { repo, mail });

    expect(repo.inserted).toHaveLength(0);
    expect(result).toEqual({ recipients: [], inAppSent: 0, emailsSent: 0 });
    expect(mail.sent).toHaveLength(0);
  });

  test("C-005: a duplicate dispatch for the same invitee still writes ONE row per call (single recipient)", async () => {
    const repo = fakeRepo({});
    const mail = fakeMail();

    const result = await notifyOnInvited({ refId: "doc_1", inviteeUserId: "dev-user" }, { repo, mail });

    // The recipient set is a single id — deliverToRecipients dedups, so one row, never spam.
    expect(result.recipients).toEqual(["dev-user"]);
    expect(result.inAppSent).toBe(1);
  });

  test("C-007: a throwing repo is swallowed (best-effort) — the invite is never failed by notify", async () => {
    const logged: unknown[] = [];
    const mail = fakeMail();
    const repo: NotifyRepo = {
      async listParticipantIds() { return []; },
      async getDocOwnerId() { return null; },
      async getUserEmail() { return null; },
      async insertNotification() { throw new Error("db boom"); },
    };

    const result = await notifyOnInvited(
      { refId: "doc_1", inviteeUserId: "dev-user" },
      { repo, mail, logError: (_m, e) => logged.push(e) },
    );

    // Swallowed: returns the empty result, logs once, never throws.
    expect(result).toEqual({ recipients: [], inAppSent: 0, emailsSent: 0 });
    expect(logged).toHaveLength(1);
  });
});
