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
  notifyOnWorkspaceInvited,
  notifyOnWorkspaceMemberJoined,
  notifyOnWorkspaceMemberRemoved,
  notifyOnWorkspaceRenamed,
  isEmailEligible,
  buildAnnotationDeepLink,
  buildWorkspaceDeepLink,
  buildEmailBody,
  emailSubjectFor,
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

// ===========================================================================
// workspace-notifications S-001 — notify an invited member in the bell.
// `workspace_invited` is a NEW, DISTINCT type (NOT the doc-share `invited`): IN-APP
// ONLY (C-001), recipient = the invited ACCOUNT only when one exists for the email
// (else no row), inviting admin is never a recipient (C-002), refId = workspaceId,
// refLabel = the workspace name snapshotted at emit (rendered without a live join, F1).
// ===========================================================================

// A recording workspace-notify repo: resolves an invitee account id by email + records
// inserts (incl. refLabel). The four workspace recipient ports are real on the Drizzle
// impl; here they are fakes the dispatch logic plugs into.
function fakeWsRepo(opts: {
  accountByEmail?: Record<string, string>;
  adminIds?: string[];
  memberIds?: string[];
  emailByUser?: Record<string, string>;
  workspaceName?: string;
}): NotifyRepo & {
  inserted: NewNotification[];
  /** S-002 (C-005.T2): how many times the BULK port was called, and the batch sizes seen. */
  bulkCalls: number;
  bulkSizes: number[];
  findUserIdByEmail(email: string): Promise<string | null>;
  listWorkspaceAdminIds(workspaceId: string): Promise<string[]>;
  listWorkspaceMemberIds(workspaceId: string): Promise<string[]>;
  getWorkspaceName(workspaceId: string): Promise<string | null>;
  insertNotifications(rows: NewNotification[]): Promise<{ id: string }[]>;
} {
  const inserted: NewNotification[] = [];
  const self = {
    inserted,
    bulkCalls: 0,
    bulkSizes: [] as number[],
    async listParticipantIds() { return []; },
    async getDocOwnerId() { return null; },
    async getUserEmail(userId: string) { return opts.emailByUser?.[userId] ?? null; },
    async findUserIdByEmail(email: string) {
      const map = opts.accountByEmail ?? {};
      return map[email.toLowerCase()] ?? null;
    },
    async listWorkspaceAdminIds() { return opts.adminIds ?? []; },
    async listWorkspaceMemberIds() { return opts.memberIds ?? []; },
    async getWorkspaceName() { return opts.workspaceName ?? null; },
    async insertNotification(input: NewNotification) {
      inserted.push(input);
      return { id: `n_${inserted.length}` };
    },
    // S-002 (C-005.T2): the real batch path — ONE call inserting N rows in one round-trip.
    async insertNotifications(rows: NewNotification[]) {
      self.bulkCalls += 1;
      self.bulkSizes.push(rows.length);
      return rows.map((r) => {
        inserted.push(r);
        return { id: `n_${inserted.length}` };
      });
    },
  };
  return self;
}

describe("buildWorkspaceDeepLink (workspace-shaped deep-link, NOT annotation-shaped)", () => {
  test("VERIFY-S1: builds {APP_URL}/w/{workspaceId} and trims a trailing slash (edge: special chars + control char)", () => {
    expect(buildWorkspaceDeepLink("https://anchord.example.com/", "ws 123")).toBe(
      "https://anchord.example.com/w/ws%20123",
    );
    // A control-char workspace id must not crash the builder (C-006 sanity for the maps).
    expect(() => buildWorkspaceDeepLink("https://x.test", "ws\r\nid")).not.toThrow();
  });
});

describe("emailSubjectFor / EVENT_SUMMARY totality over the widened union (F3)", () => {
  // VERIFY-S1: every email-eligible type must carry a NON-FALLBACK subject AND body —
  // no `?? "anchord notification"` leak, no generic body leak. The maps must also stay
  // TOTAL over the widened union (tsc would otherwise break — proven by compilation +
  // here by spot-checking the new workspace types have real copy).
  const FALLBACK_SUBJECT = "anchord notification";
  const FALLBACK_BODY = "You have a new notification on anchord.";
  const allTypes: NotificationType[] = [
    "reply",
    "new_feedback",
    "thread_activity",
    "suggestion_decided",
    "resolved",
    "detached",
    "invited",
    "workspace_invited",
    "workspace_member_joined",
    "workspace_member_removed",
    "workspace_renamed",
  ];

  test("VERIFY-S1: every email-eligible type has a non-fallback subject + non-fallback body", () => {
    for (const t of allTypes) {
      if (!isEmailEligible(t)) continue;
      expect(emailSubjectFor(t)).not.toBe(FALLBACK_SUBJECT);
      const body = buildEmailBody(t, "https://x.test/link");
      expect(body).not.toContain(FALLBACK_BODY);
    }
  });

  test("VERIFY-S1: the four new workspace types have real (non-fallback) subject + summary even though most are in-app only", () => {
    for (const t of [
      "workspace_invited",
      "workspace_member_joined",
      "workspace_member_removed",
      "workspace_renamed",
    ] as NotificationType[]) {
      expect(emailSubjectFor(t)).not.toBe(FALLBACK_SUBJECT);
      expect(buildEmailBody(t, "https://x.test/link")).not.toContain(FALLBACK_BODY);
    }
  });

  test("C-001: workspace_invited is NOT email-eligible (in-app only)", () => {
    expect(isEmailEligible("workspace_invited")).toBe(false);
  });
});

describe("notifyOnWorkspaceInvited (S-001 — in-app bell row for an invited account)", () => {
  test("AS-001.T1: inviting an existing account creates ONE in-app workspace_invited row for the invitee", async () => {
    const repo = fakeWsRepo({ accountByEmail: { "bob@x": "u_bob" } });
    const mail = fakeMail();

    const result = await notifyOnWorkspaceInvited(
      { workspaceId: "ws_acme", inviteeEmail: "bob@x", workspaceName: "Acme", actorUserId: "u_alice" },
      { repo, mail },
    );

    expect(result.recipients).toEqual(["u_bob"]);
    expect(result.inAppSent).toBe(1);
    expect(repo.inserted).toHaveLength(1);
    expect(repo.inserted[0].userId).toBe("u_bob");
    expect(repo.inserted[0].type).toBe("workspace_invited");
    // refId holds the workspaceId (Data Model); commentId is null for workspace types.
    expect(repo.inserted[0].refId).toBe("ws_acme");
    expect(repo.inserted[0].commentId).toBeNull();
  });

  test("AS-001.T2: the row carries refLabel = the workspace name (snapshot, no live join)", async () => {
    const repo = fakeWsRepo({ accountByEmail: { "bob@x": "u_bob" } });
    const mail = fakeMail();

    await notifyOnWorkspaceInvited(
      { workspaceId: "ws_acme", inviteeEmail: "bob@x", workspaceName: "Acme", actorUserId: "u_alice" },
      { repo, mail },
    );

    expect(repo.inserted[0].refLabel).toBe("Acme");
  });

  test("AS-001.T3: no email is sent beyond the existing invite email (in-app only, C-001)", async () => {
    const repo = fakeWsRepo({ accountByEmail: { "bob@x": "u_bob" } });
    const mail = fakeMail();

    const result = await notifyOnWorkspaceInvited(
      { workspaceId: "ws_acme", inviteeEmail: "bob@x", workspaceName: "Acme", actorUserId: "u_alice" },
      { repo, mail },
    );

    expect(result.emailsSent).toBe(0);
    expect(mail.sent).toHaveLength(0);
  });

  test("AS-002.T1: inviting an email with NO account creates no in-app row (null invitee account)", async () => {
    const repo = fakeWsRepo({ accountByEmail: {} }); // new@x has no account
    const mail = fakeMail();

    const result = await notifyOnWorkspaceInvited(
      { workspaceId: "ws_acme", inviteeEmail: "new@x", workspaceName: "Acme", actorUserId: "u_alice" },
      { repo, mail },
    );

    expect(repo.inserted).toHaveLength(0);
    expect(result).toEqual({ recipients: [], inAppSent: 0, emailsSent: 0 });
  });

  test("AS-003: the inviting admin is never a recipient (even if they invite their own email)", async () => {
    // Alice invites an address that resolves to Alice's own account → self-exclusion (C-002).
    const repo = fakeWsRepo({ accountByEmail: { "alice@x": "u_alice" } });
    const mail = fakeMail();

    const result = await notifyOnWorkspaceInvited(
      { workspaceId: "ws_acme", inviteeEmail: "alice@x", workspaceName: "Acme", actorUserId: "u_alice" },
      { repo, mail },
    );

    expect(result.recipients).toEqual([]);
    expect(repo.inserted).toHaveLength(0);
  });

  test("C-004: a throwing repo is swallowed (best-effort) — the invite is never failed by notify", async () => {
    const logged: unknown[] = [];
    const mail = fakeMail();
    const repo = fakeWsRepo({ accountByEmail: { "bob@x": "u_bob" } });
    repo.insertNotification = async () => { throw new Error("db boom"); };

    const result = await notifyOnWorkspaceInvited(
      { workspaceId: "ws_acme", inviteeEmail: "bob@x", workspaceName: "Acme", actorUserId: "u_alice" },
      { repo, mail, logError: (_m, e) => logged.push(e) },
    );

    expect(result).toEqual({ recipients: [], inAppSent: 0, emailsSent: 0 });
    expect(logged).toHaveLength(1);
  });

  test("C-006 (edge): a control-char workspace name is stripped before it reaches refLabel", async () => {
    // S-001 builds the maps/deep-link without crashing on a control char; refLabel must be
    // inert (no raw CR/LF). The full untrusted-name CRLF spec belongs to S-003/AS-009, but
    // S-001's snapshot path should already not carry raw control chars.
    const repo = fakeWsRepo({ accountByEmail: { "bob@x": "u_bob" } });
    const mail = fakeMail();

    await notifyOnWorkspaceInvited(
      { workspaceId: "ws_acme", inviteeEmail: "bob@x", workspaceName: "Ac\r\nme", actorUserId: "u_alice" },
      { repo, mail },
    );

    expect(repo.inserted[0].refLabel).not.toMatch(/[\r\n]/);
  });
});

// ===========================================================================
// workspace-notifications S-003 — notify a REMOVED member.
// `workspace_member_removed` is HIGH-SIGNAL: in-app + EMAIL (the only new type that
// emails). Recipient = the removed user BY CONSTRUCTION (no membership re-check — the
// caller snapshots id + name + email PRE-delete, F1/C-003/AS-006). The removing admin is
// never a recipient (C-002). refId = workspaceId; refLabel = the SANITIZED workspace name,
// and the same sanitized name flows into the email subject/body (C-006/AS-009). The email
// deep-link is WORKSPACE-shaped (buildWorkspaceDeepLink), not annotation-shaped.
// ===========================================================================
describe("notifyOnWorkspaceMemberRemoved (S-003 — removed member gets in-app + email)", () => {
  test("workspace_member_removed is email-eligible (high-signal: in-app + email)", () => {
    expect(isEmailEligible("workspace_member_removed")).toBe(true);
  });

  test("AS-005.T1: removing a member creates ONE in-app workspace_member_removed row for the removed user", async () => {
    const repo = fakeWsRepo({ emailByUser: { u_bob: "bob@acme.com" } });
    const mail = fakeMail();

    const result = await notifyOnWorkspaceMemberRemoved(
      {
        workspaceId: "ws_acme",
        removedUserId: "u_bob",
        workspaceName: "Acme",
        recipientEmail: "bob@acme.com",
        actorUserId: "u_alice",
      },
      { repo, mail },
    );

    expect(result.recipients).toEqual(["u_bob"]);
    expect(result.inAppSent).toBe(1);
    expect(repo.inserted).toHaveLength(1);
    expect(repo.inserted[0].userId).toBe("u_bob");
    expect(repo.inserted[0].type).toBe("workspace_member_removed");
    // refId holds the workspaceId (Data Model); commentId is null for workspace types.
    expect(repo.inserted[0].refId).toBe("ws_acme");
    expect(repo.inserted[0].commentId).toBeNull();
  });

  test("AS-005.T2: the removed member gets ONE email titled for removal", async () => {
    const repo = fakeWsRepo({ emailByUser: { u_bob: "bob@acme.com" } });
    const mail = fakeMail();

    const result = await notifyOnWorkspaceMemberRemoved(
      {
        workspaceId: "ws_acme",
        removedUserId: "u_bob",
        workspaceName: "Acme",
        recipientEmail: "bob@acme.com",
        actorUserId: "u_alice",
      },
      { repo, mail, appUrl: "https://anchord.example.com" },
    );

    expect(result.emailsSent).toBe(1);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe("bob@acme.com");
    expect(mail.sent[0].subject).toMatch(/removed/i);
    // The email deep-link is WORKSPACE-shaped (/w/{id}), NOT annotation-shaped (/d/...#annotation-).
    expect(mail.sent[0].text).toContain("/w/ws_acme");
    expect(mail.sent[0].text).not.toContain("#annotation-");
  });

  test("AS-005.T3: the removing admin (Alice) gets no row and no email", async () => {
    const repo = fakeWsRepo({ emailByUser: { u_bob: "bob@acme.com", u_alice: "alice@acme.com" } });
    const mail = fakeMail();

    await notifyOnWorkspaceMemberRemoved(
      {
        workspaceId: "ws_acme",
        removedUserId: "u_bob",
        workspaceName: "Acme",
        recipientEmail: "bob@acme.com",
        actorUserId: "u_alice",
      },
      { repo, mail, appUrl: "https://anchord.example.com" },
    );

    // Only the removed user is ever a recipient — Alice never appears (C-002).
    expect(repo.inserted.map((r) => r.userId)).toEqual(["u_bob"]);
    expect(mail.sent.map((m) => m.to)).toEqual(["bob@acme.com"]);
  });

  test("AS-006 / C-003: the just-removed user is NOT dropped — recipient resolved from the pre-delete snapshot, no membership re-check", async () => {
    // The repo reports the workspace as having NO members (Bob's membership is already deleted).
    // The dispatch must still notify Bob — it relies on the snapshot, never re-checks membership.
    const repo = fakeWsRepo({ memberIds: [], adminIds: ["u_alice"], emailByUser: { u_bob: "bob@acme.com" } });
    const mail = fakeMail();

    const result = await notifyOnWorkspaceMemberRemoved(
      {
        workspaceId: "ws_acme",
        removedUserId: "u_bob",
        workspaceName: "Acme",
        recipientEmail: "bob@acme.com",
        actorUserId: "u_alice",
      },
      { repo, mail, appUrl: "https://anchord.example.com" },
    );

    expect(result.recipients).toEqual(["u_bob"]);
    expect(repo.inserted).toHaveLength(1);
    expect(repo.inserted[0].userId).toBe("u_bob");
  });

  test("AS-008 / C-004: a throwing repo is swallowed (best-effort) — the removal is never failed by notify", async () => {
    const logged: unknown[] = [];
    const mail = fakeMail();
    const repo = fakeWsRepo({ emailByUser: { u_bob: "bob@acme.com" } });
    repo.insertNotification = async () => { throw new Error("db boom"); };

    const result = await notifyOnWorkspaceMemberRemoved(
      {
        workspaceId: "ws_acme",
        removedUserId: "u_bob",
        workspaceName: "Acme",
        recipientEmail: "bob@acme.com",
        actorUserId: "u_alice",
      },
      { repo, mail, logError: (_m, e) => logged.push(e) },
    );

    // Swallowed: empty result, error logged, no throw propagated to the caller.
    expect(result).toEqual({ recipients: [], inAppSent: 0, emailsSent: 0 });
    expect(logged).toHaveLength(1);
  });

  test("AS-009.T1 / C-006: CR/LF + control chars are stripped from the name before it reaches the in-app row (refLabel inert)", async () => {
    const repo = fakeWsRepo({ emailByUser: { u_bob: "bob@acme.com" } });
    const mail = fakeMail();

    await notifyOnWorkspaceMemberRemoved(
      {
        workspaceId: "ws_acme",
        removedUserId: "u_bob",
        workspaceName: "Acme\r\nSubject: verify at evil.com",
        recipientEmail: "bob@acme.com",
        actorUserId: "u_alice",
      },
      { repo, mail, appUrl: "https://anchord.example.com" },
    );

    // AS-009.T3: the in-app row renders the name as inert text (refLabel, no raw CR/LF/control).
    expect(repo.inserted[0].refLabel).not.toMatch(/[\r\n]/);
    // eslint-disable-next-line no-control-regex
    expect(repo.inserted[0].refLabel).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  test("AS-009.T2 / C-006: no injected header / spoofed line survives into the email subject or body", async () => {
    const repo = fakeWsRepo({ emailByUser: { u_bob: "bob@acme.com" } });
    const mail = fakeMail();

    await notifyOnWorkspaceMemberRemoved(
      {
        workspaceId: "ws_acme",
        removedUserId: "u_bob",
        workspaceName: "Acme\r\nSubject: verify at evil.com",
        recipientEmail: "bob@acme.com",
        actorUserId: "u_alice",
      },
      { repo, mail, appUrl: "https://anchord.example.com" },
    );

    const sent = mail.sent[0];
    // The subject is a fixed non-interpolated string (never carries the name), so no CRLF.
    expect(sent.subject).not.toMatch(/[\r\n]/);
    // The body never carries a raw CR/LF-injected spoofed header line from the name. Body has
    // its OWN legitimate newlines (summary\n\nlink), so assert the injected "Subject:" line
    // cannot ride a CR/LF that came from the workspace name.
    expect(sent.text).not.toContain("\r");
    expect(sent.text).not.toMatch(/\nSubject: verify at evil\.com/);
  });

  test("AS-005 (edge: null email): a removed user with no resolvable email still gets the in-app row, no email", async () => {
    const repo = fakeWsRepo({ emailByUser: {} }); // no email on record
    const mail = fakeMail();

    const result = await notifyOnWorkspaceMemberRemoved(
      {
        workspaceId: "ws_acme",
        removedUserId: "u_bob",
        workspaceName: "Acme",
        recipientEmail: null,
        actorUserId: "u_alice",
      },
      { repo, mail, appUrl: "https://anchord.example.com" },
    );

    expect(result.inAppSent).toBe(1);
    expect(result.emailsSent).toBe(0);
    expect(mail.sent).toHaveLength(0);
  });
});

// ===========================================================================
// workspace-notifications S-002 — notify admins when a member JOINS.
// `workspace_member_joined` is IN-APP ONLY by default (GAP-001: email OFF, admins
// opt in later via notification-preferences). Recipients = ALL admins of the
// workspace MINUS the joining member (C-002). Fan-out (C-005): EXACTLY one row per
// admin, BATCH-inserted (one bulk port call with N rows, not N serial inserts), and
// NOT awaited on the request critical path. refId = workspaceId; refLabel = the
// sanitized workspace name snapshot (renders "<joiner> joined <ws>" with the joiner
// name; never the joiner's email — F-security). GAP-003 (open): no idempotency key,
// so a double-accept may duplicate rows — v0 accepts rare dups (no mechanism built).
// ===========================================================================
describe("notifyOnWorkspaceMemberJoined (S-002 — admins get an in-app row on a join)", () => {
  test("workspace_member_joined is NOT email-eligible (in-app only by default, GAP-001)", () => {
    // C-005 channel guard: member_joined must stay out of HIGH_SIGNAL_TYPES.
    expect(isEmailEligible("workspace_member_joined")).toBe(false);
  });

  test("AS-004.T1: accepting an invite notifies EVERY admin (Alice, Carol) with one in-app row 'Bob joined Acme'", async () => {
    const repo = fakeWsRepo({ adminIds: ["u_alice", "u_carol"], workspaceName: "Acme" });
    const mail = fakeMail();

    const result = await notifyOnWorkspaceMemberJoined(
      {
        workspaceId: "ws_acme",
        joinerUserId: "u_bob",
        workspaceName: "Acme",
        joinerName: "Bob",
        actorUserId: "u_bob",
      },
      { repo, mail },
    );

    // Both admins, exactly one row each (C-005.T1), typed workspace_member_joined.
    expect(result.recipients.sort()).toEqual(["u_alice", "u_carol"]);
    expect(result.inAppSent).toBe(2);
    expect(repo.inserted.map((r) => r.userId).sort()).toEqual(["u_alice", "u_carol"]);
    for (const row of repo.inserted) {
      expect(row.type).toBe("workspace_member_joined");
      // refId holds the workspaceId (Data Model); commentId is null for workspace types.
      expect(row.refId).toBe("ws_acme");
      expect(row.commentId).toBeNull();
      // refLabel snapshots the workspace name (inert, no live join, F1).
      expect(row.refLabel).toBe("Acme");
    }
  });

  test("AS-004.T2 / C-002: the joiner (Bob) is never a recipient — even though a fresh joiner is a member", async () => {
    // Bob's own admin id would be in the admin set if he joined as admin; he must still be excluded.
    const repo = fakeWsRepo({ adminIds: ["u_alice", "u_carol", "u_bob"], workspaceName: "Acme" });
    const mail = fakeMail();

    const result = await notifyOnWorkspaceMemberJoined(
      {
        workspaceId: "ws_acme",
        joinerUserId: "u_bob",
        workspaceName: "Acme",
        joinerName: "Bob",
        actorUserId: "u_bob",
      },
      { repo, mail },
    );

    expect(result.recipients).not.toContain("u_bob");
    expect(repo.inserted.map((r) => r.userId)).not.toContain("u_bob");
    expect(result.recipients.sort()).toEqual(["u_alice", "u_carol"]);
  });

  test("AS-004.T3 / C-005 channel: NO email is sent by default (in-app only)", async () => {
    const repo = fakeWsRepo({
      adminIds: ["u_alice", "u_carol"],
      workspaceName: "Acme",
      emailByUser: { u_alice: "alice@acme.com", u_carol: "carol@acme.com" },
    });
    const mail = fakeMail();

    const result = await notifyOnWorkspaceMemberJoined(
      {
        workspaceId: "ws_acme",
        joinerUserId: "u_bob",
        workspaceName: "Acme",
        joinerName: "Bob",
        actorUserId: "u_bob",
      },
      { repo, mail, appUrl: "https://anchord.example.com" },
    );

    expect(result.emailsSent).toBe(0);
    expect(mail.sent).toHaveLength(0);
  });

  test("C-005.T1: exactly ONE row per recipient per event — no duplicate across admins", async () => {
    const repo = fakeWsRepo({ adminIds: ["u_alice", "u_carol", "u_dan"], workspaceName: "Acme" });
    const mail = fakeMail();

    await notifyOnWorkspaceMemberJoined(
      { workspaceId: "ws_acme", joinerUserId: "u_bob", workspaceName: "Acme", joinerName: "Bob", actorUserId: "u_bob" },
      { repo, mail },
    );

    const ids = repo.inserted.map((r) => r.userId);
    expect(new Set(ids).size).toBe(ids.length); // no dup
    expect(ids.length).toBe(3);
  });

  test("C-005.T2: the fan-out is BATCH-inserted — bulk port called ONCE with N rows, not N serial inserts", async () => {
    const repo = fakeWsRepo({
      adminIds: ["u_a", "u_b", "u_c", "u_d", "u_e"], // many admins → batch exercised
      workspaceName: "Acme",
    });
    const mail = fakeMail();

    const result = await notifyOnWorkspaceMemberJoined(
      { workspaceId: "ws_acme", joinerUserId: "u_bob", workspaceName: "Acme", joinerName: "Bob", actorUserId: "u_bob" },
      { repo, mail },
    );

    // ONE bulk round-trip carrying all 5 rows — never 5 single insertNotification calls.
    expect(repo.bulkCalls).toBe(1);
    expect(repo.bulkSizes).toEqual([5]);
    expect(result.inAppSent).toBe(5);
  });

  test("AS-004 (edge: empty): no admins other than the joiner → NO rows, no bulk call", async () => {
    // Bob joins a workspace where he is the only admin (self-created) → recipients = admins − joiner = [].
    const repo = fakeWsRepo({ adminIds: ["u_bob"], workspaceName: "Acme" });
    const mail = fakeMail();

    const result = await notifyOnWorkspaceMemberJoined(
      { workspaceId: "ws_acme", joinerUserId: "u_bob", workspaceName: "Acme", joinerName: "Bob", actorUserId: "u_bob" },
      { repo, mail },
    );

    expect(result).toEqual({ recipients: [], inAppSent: 0, emailsSent: 0 });
    expect(repo.inserted).toHaveLength(0);
    // No recipients → no empty bulk insert.
    expect(repo.bulkCalls).toBe(0);
  });

  test("C-004: a throwing repo is swallowed (best-effort) — the join is never failed by notify", async () => {
    const logged: unknown[] = [];
    const mail = fakeMail();
    const repo = fakeWsRepo({ adminIds: ["u_alice", "u_carol"], workspaceName: "Acme" });
    repo.insertNotifications = async () => { throw new Error("db boom"); };

    const result = await notifyOnWorkspaceMemberJoined(
      { workspaceId: "ws_acme", joinerUserId: "u_bob", workspaceName: "Acme", joinerName: "Bob", actorUserId: "u_bob" },
      { repo, mail, logError: (_m, e) => logged.push(e) },
    );

    // Swallowed: empty result, error logged once, no throw propagated to the accept handler.
    expect(result).toEqual({ recipients: [], inAppSent: 0, emailsSent: 0 });
    expect(logged).toHaveLength(1);
  });

  test("C-006 (edge: special chars): a control-char workspace name is stripped before it reaches refLabel", async () => {
    const repo = fakeWsRepo({ adminIds: ["u_alice"], workspaceName: "Ac\r\nme" });
    const mail = fakeMail();

    await notifyOnWorkspaceMemberJoined(
      { workspaceId: "ws_acme", joinerUserId: "u_bob", workspaceName: "Ac\r\nme", joinerName: "B\r\nob", actorUserId: "u_bob" },
      { repo, mail },
    );

    expect(repo.inserted[0].refLabel).not.toMatch(/[\r\n]/);
    // eslint-disable-next-line no-control-regex
    expect(repo.inserted[0].refLabel).not.toMatch(/[\x00-\x1f\x7f]/);
  });
});

// ===========================================================================
// workspace-notifications S-004 — notify members on a workspace RENAME.
// `workspace_renamed` is IN-APP ONLY (NOT in HIGH_SIGNAL_TYPES — no email).
// Recipients = ALL current members of the workspace MINUS the renamer (C-002).
// Fan-out (C-005): EXACTLY one row per member, BATCH-inserted (one bulk port call
// with N rows, not N serial inserts), and NOT awaited on the request critical path.
// refId = workspaceId; refLabel = the sanitized "<old> → <new>" display text — BOTH
// names are user-controlled so each is stripped of CR/LF + control chars (C-006).
// Best-effort/post-commit (C-004): a throwing repo is swallowed; the rename never 500s.
// ===========================================================================
describe("notifyOnWorkspaceRenamed (S-004 — members get an in-app row on a rename)", () => {
  test("C-005 channel: workspace_renamed is NOT email-eligible (in-app only)", () => {
    // Channel guard: workspace_renamed must stay out of HIGH_SIGNAL_TYPES.
    expect(isEmailEligible("workspace_renamed")).toBe(false);
  });

  test("AS-007.T1: renaming notifies all members (Bob, Carol) with one in-app row '<old> → <new>'", async () => {
    const repo = fakeWsRepo({ memberIds: ["u_alice", "u_bob", "u_carol"] });
    const mail = fakeMail();

    const result = await notifyOnWorkspaceRenamed(
      {
        workspaceId: "ws_acme",
        oldName: "Acme",
        newName: "Acme Docs",
        actorUserId: "u_alice",
      },
      { repo, mail },
    );

    // Members minus the renamer (Alice) → Bob + Carol, exactly one row each (C-005.T1).
    expect(result.recipients.sort()).toEqual(["u_bob", "u_carol"]);
    expect(result.inAppSent).toBe(2);
    expect(repo.inserted.map((r) => r.userId).sort()).toEqual(["u_bob", "u_carol"]);
    for (const row of repo.inserted) {
      expect(row.type).toBe("workspace_renamed");
      // refId holds the workspaceId (Data Model); commentId is null for workspace types.
      expect(row.refId).toBe("ws_acme");
      expect(row.commentId).toBeNull();
      // refLabel snapshots the "<old> → <new>" display text (inert, no live join, F1).
      expect(row.refLabel).toBe("Acme → Acme Docs");
    }
  });

  test("AS-007.T2 / C-002: the renamer (Alice) gets none — excluded from the member fan-out", async () => {
    // Alice is a member (admins are members too) but is the actor → never a recipient.
    const repo = fakeWsRepo({ memberIds: ["u_alice", "u_bob", "u_carol"] });
    const mail = fakeMail();

    const result = await notifyOnWorkspaceRenamed(
      { workspaceId: "ws_acme", oldName: "Acme", newName: "Acme Docs", actorUserId: "u_alice" },
      { repo, mail },
    );

    expect(result.recipients).not.toContain("u_alice");
    expect(repo.inserted.map((r) => r.userId)).not.toContain("u_alice");
    expect(result.recipients.sort()).toEqual(["u_bob", "u_carol"]);
  });

  test("AS-007.T3: no email is sent (in-app only)", async () => {
    const repo = fakeWsRepo({
      memberIds: ["u_alice", "u_bob", "u_carol"],
      emailByUser: { u_bob: "bob@acme.com", u_carol: "carol@acme.com" },
    });
    const mail = fakeMail();

    const result = await notifyOnWorkspaceRenamed(
      { workspaceId: "ws_acme", oldName: "Acme", newName: "Acme Docs", actorUserId: "u_alice" },
      { repo, mail, appUrl: "https://anchord.example.com" },
    );

    expect(result.emailsSent).toBe(0);
    expect(mail.sent).toHaveLength(0);
  });

  test("C-005.T1: exactly ONE row per recipient — no duplicate across members", async () => {
    const repo = fakeWsRepo({ memberIds: ["u_alice", "u_bob", "u_carol", "u_dan"] });
    const mail = fakeMail();

    await notifyOnWorkspaceRenamed(
      { workspaceId: "ws_acme", oldName: "Acme", newName: "Acme Docs", actorUserId: "u_alice" },
      { repo, mail },
    );

    const ids = repo.inserted.map((r) => r.userId);
    expect(new Set(ids).size).toBe(ids.length); // no dup
    expect(ids.length).toBe(3); // Bob, Carol, Dan (Alice excluded)
  });

  test("C-005.T2 (boundary: many members): the fan-out is BATCH-inserted — bulk port called ONCE with N rows", async () => {
    // 500 members → one batch round-trip, never 500 serial inserts (C-005 non-blocking fan-out).
    const memberIds = ["u_alice", ...Array.from({ length: 500 }, (_, i) => `u_m${i}`)];
    const repo = fakeWsRepo({ memberIds });
    const mail = fakeMail();

    const result = await notifyOnWorkspaceRenamed(
      { workspaceId: "ws_acme", oldName: "Acme", newName: "Acme Docs", actorUserId: "u_alice" },
      { repo, mail },
    );

    expect(repo.bulkCalls).toBe(1);
    expect(repo.bulkSizes).toEqual([500]); // 501 members − the renamer
    expect(result.inAppSent).toBe(500);
  });

  test("AS-007 (edge: empty): no members other than the renamer → NO rows, no bulk call", async () => {
    // Alice renames a workspace where she is the only member → recipients = members − renamer = [].
    const repo = fakeWsRepo({ memberIds: ["u_alice"] });
    const mail = fakeMail();

    const result = await notifyOnWorkspaceRenamed(
      { workspaceId: "ws_acme", oldName: "Acme", newName: "Acme Docs", actorUserId: "u_alice" },
      { repo, mail },
    );

    expect(result).toEqual({ recipients: [], inAppSent: 0, emailsSent: 0 });
    expect(repo.inserted).toHaveLength(0);
    expect(repo.bulkCalls).toBe(0); // no empty bulk insert
  });

  test("C-004: a throwing repo is swallowed (best-effort) — the rename is never failed by notify", async () => {
    const logged: unknown[] = [];
    const mail = fakeMail();
    const repo = fakeWsRepo({ memberIds: ["u_alice", "u_bob"] });
    repo.insertNotifications = async () => { throw new Error("db boom"); };

    const result = await notifyOnWorkspaceRenamed(
      { workspaceId: "ws_acme", oldName: "Acme", newName: "Acme Docs", actorUserId: "u_alice" },
      { repo, mail, logError: (_m, e) => logged.push(e) },
    );

    // Swallowed: empty result, error logged once, no throw propagated to the rename handler.
    expect(result).toEqual({ recipients: [], inAppSent: 0, emailsSent: 0 });
    expect(logged).toHaveLength(1);
  });

  test("C-006 (special chars): CR/LF + control chars are stripped from BOTH names in the '<old> → <new>' refLabel", async () => {
    const repo = fakeWsRepo({ memberIds: ["u_alice", "u_bob"] });
    const mail = fakeMail();

    await notifyOnWorkspaceRenamed(
      {
        workspaceId: "ws_acme",
        oldName: "Ac\r\nme",
        newName: "Acme\r\nSubject: spoof",
        actorUserId: "u_alice",
      },
      { repo, mail },
    );

    expect(repo.inserted[0].refLabel).not.toMatch(/[\r\n]/);
    // eslint-disable-next-line no-control-regex
    expect(repo.inserted[0].refLabel).not.toMatch(/[\x00-\x1f\x7f]/);
    // Both sanitized halves still join with the arrow separator.
    expect(repo.inserted[0].refLabel).toBe("Acme → AcmeSubject: spoof");
  });

  test("C-006 (null/undefined names): a null old/new name does not crash; refLabel is an inert string", async () => {
    const repo = fakeWsRepo({ memberIds: ["u_alice", "u_bob"] });
    const mail = fakeMail();

    const result = await notifyOnWorkspaceRenamed(
      {
        workspaceId: "ws_acme",
        // Defensive: the caller may pass an unresolved (null) old name (getWorkspaceName miss).
        oldName: null as unknown as string,
        newName: "Acme Docs",
        actorUserId: "u_alice",
      },
      { repo, mail },
    );

    expect(result.recipients).toEqual(["u_bob"]);
    expect(typeof repo.inserted[0].refLabel).toBe("string");
    expect(repo.inserted[0].refLabel).not.toMatch(/[\r\n]/);
  });
});
