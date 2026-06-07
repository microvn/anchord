import { test, expect } from "bun:test";
import { MailQueue, type MailMessage, type MailTransport } from "./mail-queue";

// S-005 / AS-011 / C-009: SMTP mandatory-at-boot != can-send-at-runtime.
// Every outbound mail enqueues + retries + dead-letters + surfaces a status.
// Pure logic, injectable transport — NO real SMTP.

const msg: MailMessage = { to: "bob@x.com", subject: "Verify", body: "click" };

/** Transport that throws the first `failTimes` attempts, then succeeds. */
function flakyTransport(failTimes: number): { transport: MailTransport; calls: () => number } {
  let calls = 0;
  return {
    transport: {
      async send() {
        calls += 1;
        if (calls <= failTimes) throw new Error(`provider 5xx (attempt ${calls})`);
      },
    },
    calls: () => calls,
  };
}

/** Transport that always throws (provider permanently down / rate-limited). */
const alwaysFails: MailTransport = {
  async send() {
    throw new Error("provider rate-limited");
  },
};

test("AS-011: a runtime send failure enqueues the message and retries (does not get stuck)", async () => {
  const q = new MailQueue({ maxAttempts: 3 });
  const { transport, calls } = flakyTransport(2); // fail twice, then succeed

  const final = await q.send(msg, transport);

  expect(final.status).toBe("sent");
  expect(calls()).toBe(3); // retried until it went through
  expect(final.attempts).toBe(3);
});

test("AS-011: a permanently failing transport dead-letters after N attempts and surfaces a status", async () => {
  const q = new MailQueue({ maxAttempts: 3 });

  const final = await q.send(msg, alwaysFails);

  expect(final.status).toBe("dead"); // dead-lettered, not retried forever
  expect(final.attempts).toBe(3); // boundary: exactly maxAttempts
  expect(final.lastError).toContain("rate-limited"); // failure surfaced to operator
  expect(q.statusOf(final.id)).toBe("dead");
  expect(q.deadLetters()).toHaveLength(1);
});

test("C-009: queue exposes operator-visible status counts (send-failed surface)", async () => {
  const q = new MailQueue({ maxAttempts: 2 });
  const sent = q.enqueue({ ...msg, subject: "ok" });
  const dead = q.enqueue({ ...msg, subject: "doomed" });

  await q.deliverWithRetry(sent, flakyTransport(0).transport); // succeeds first try
  await q.deliverWithRetry(dead, alwaysFails); // dead-letters

  const counts = q.statusCounts();
  expect(counts.sent).toBe(1);
  expect(counts.dead).toBe(1);
  expect(counts.pending).toBe(0);
});

test("C-009: a freshly enqueued message starts pending (status state machine)", () => {
  const q = new MailQueue();
  const id = q.enqueue(msg);
  expect(q.statusOf(id)).toBe("pending");
  expect(q.get(id)?.attempts).toBe(0);
});

test("C-009: attempting an unknown message id throws (invalid-input edge)", async () => {
  const q = new MailQueue();
  await expect(q.attempt("nope", alwaysFails)).rejects.toThrow("unknown message");
});

test("C-009: a single attempt below max marks the message failed (retry-eligible), not dead", async () => {
  const q = new MailQueue({ maxAttempts: 3 });
  const id = q.enqueue(msg);

  const after = await q.attempt(id, alwaysFails);

  expect(after.status).toBe("failed"); // 1 of 3 — still eligible for retry
  expect(after.attempts).toBe(1);
});

test("C-009: re-attempting an already-sent message is a no-op (idempotent terminal state)", async () => {
  const q = new MailQueue();
  const id = q.enqueue(msg);
  await q.deliverWithRetry(id, flakyTransport(0).transport);

  const again = await q.attempt(id, alwaysFails); // must not flip a sent msg to failed
  expect(again.status).toBe("sent");
  expect(again.attempts).toBe(1);
});

test("AS-011: maxAttempts boundary — maxAttempts=1 dead-letters on the first failure", async () => {
  const q = new MailQueue({ maxAttempts: 1 });
  const final = await q.send(msg, alwaysFails);
  expect(final.status).toBe("dead");
  expect(final.attempts).toBe(1);
});
