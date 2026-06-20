import { test, expect, describe } from "bun:test";
import {
  computeRecipients,
  computeNewFeedbackCandidates,
  notifyOnThreadActivity,
  notifyOnNewFeedback,
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
