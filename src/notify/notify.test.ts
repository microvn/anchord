import { test, expect, describe } from "bun:test";
import {
  computeRecipients,
  notifyOnReply,
  type MailEnqueuer,
  type NewNotification,
  type NotifyRepo,
} from "./notify";

// workspace-project S-006 — notify on reply (AS-011 / C-004). On a successful reply,
// notify (participants ∪ doc owner) − replier, deduped, over TWO channels (in-app row +
// email). The replier never notifies themselves. Pure logic against fake ports
// (mirrors reply.test.ts): a recording NotifyRepo + a recording/throwing MailEnqueuer.

// A recording fake NotifyRepo: seeds participants / owner / emails, captures inserts.
function fakeRepo(opts: {
  participants?: string[];
  owner?: string | null;
  emails?: Record<string, string | null>;
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
    async getUserEmail(userId: string) {
      const map = opts.emails ?? {};
      // Default: every user has a synthetic email unless the test overrides to null.
      return userId in map ? map[userId] : `${userId}@example.com`;
    },
    async insertNotification(input: NewNotification) {
      inserted.push(input);
      return { id: `n_${inserted.length}` };
    },
  };
}

// A recording mail enqueuer; `throwOnEnqueue` lets a test prove best-effort failure.
function fakeMail(throwOnEnqueue = false): MailEnqueuer & {
  sent: { to: string; subject: string; body: string }[];
} {
  const sent: { to: string; subject: string; body: string }[] = [];
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

describe("notifyOnReply (both channels fire per recipient; best-effort)", () => {
  test("C-004: A replies thread {A,B} owner C → B and C each get in-app + email; A gets none", async () => {
    const repo = fakeRepo({ participants: ["A", "B"], owner: "C" });
    const mail = fakeMail();

    const result = await notifyOnReply({ annotationId: "ann_1", replierUserId: "A" }, { repo, mail });

    // recipients are exactly {B, C}, A excluded
    expect(result.recipients.sort()).toEqual(["B", "C"]);
    // in-app: 2 rows (B, C), none for A; type='reply', ref=annotation id
    expect(repo.inserted).toHaveLength(2);
    expect(repo.inserted.map((n) => n.userId).sort()).toEqual(["B", "C"]);
    expect(repo.inserted.every((n) => n.type === "reply" && n.refId === "ann_1")).toBe(true);
    expect(repo.inserted.map((n) => n.userId)).not.toContain("A");
    // email: 2 enqueued (B, C), none for A
    expect(mail.sent).toHaveLength(2);
    expect(mail.sent.map((m) => m.to).sort()).toEqual(["B@example.com", "C@example.com"]);
    expect(mail.sent.map((m) => m.to)).not.toContain("A@example.com");
    expect(result.inAppSent).toBe(2);
    expect(result.emailsSent).toBe(2);
  });

  test("C-004: owner==participant deduped to ONE in-app row + ONE email", async () => {
    // C is owner AND a participant; A replies → recipients {B, C}, C exactly once.
    const repo = fakeRepo({ participants: ["B", "C"], owner: "C" });
    const mail = fakeMail();

    await notifyOnReply({ annotationId: "ann_1", replierUserId: "A" }, { repo, mail });

    expect(repo.inserted.filter((n) => n.userId === "C")).toHaveLength(1);
    expect(mail.sent.filter((m) => m.to === "C@example.com")).toHaveLength(1);
  });

  test("C-004: guest replier (null) still notifies account-holder participants + owner", async () => {
    const repo = fakeRepo({ participants: ["A", "B"], owner: "C" });
    const mail = fakeMail();

    const result = await notifyOnReply(
      { annotationId: "ann_1", replierUserId: null },
      { repo, mail },
    );

    expect(result.recipients.sort()).toEqual(["A", "B", "C"]);
    expect(repo.inserted).toHaveLength(3);
    expect(mail.sent).toHaveLength(3);
  });

  test("C-004: recipient with no email still gets in-app; email skipped (guarded)", async () => {
    // B has no email on the user row → in-app row inserted, email NOT enqueued for B.
    const repo = fakeRepo({ participants: ["B"], owner: null, emails: { B: null } });
    const mail = fakeMail();

    const result = await notifyOnReply({ annotationId: "ann_1", replierUserId: "A" }, { repo, mail });

    expect(repo.inserted.map((n) => n.userId)).toEqual(["B"]); // in-app fired
    expect(mail.sent).toHaveLength(0); // email guarded
    expect(result.inAppSent).toBe(1);
    expect(result.emailsSent).toBe(0);
  });

  test("AS-011: no other participants and no owner → zero notifications", async () => {
    const repo = fakeRepo({ participants: ["A"], owner: null });
    const mail = fakeMail();

    const result = await notifyOnReply({ annotationId: "ann_1", replierUserId: "A" }, { repo, mail });

    expect(result.recipients).toEqual([]);
    expect(repo.inserted).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  test("C-004: a throwing mail enqueue does NOT throw out of dispatch (best-effort)", async () => {
    const repo = fakeRepo({ participants: ["B"], owner: "C" });
    const mail = fakeMail(true); // enqueue throws
    const logged: unknown[] = [];

    // Must resolve, not reject — the reply has already persisted.
    const result = await notifyOnReply(
      { annotationId: "ann_1", replierUserId: "A" },
      { repo, mail, logError: (_m, e) => logged.push(e) },
    );

    expect(result).toBeDefined();
    expect(logged).toHaveLength(1); // failure logged, not surfaced
  });

  test("C-004: a throwing repo read does NOT throw out of dispatch (best-effort)", async () => {
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

    const result = await notifyOnReply(
      { annotationId: "ann_1", replierUserId: "A" },
      { repo: throwingRepo, mail, logError: (_m, e) => logged.push(e) },
    );

    expect(result.recipients).toEqual([]);
    expect(logged).toHaveLength(1);
  });
});
