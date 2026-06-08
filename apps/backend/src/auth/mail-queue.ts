// Mail queue with retry + dead-letter + operator-visible status (auth S-005, H6).
//
// AS-011 / C-009: SMTP being mandatory AT BOOT (C-008) is DIFFERENT from being able
// to SEND at runtime — the provider can error or rate-limit mid-flight. So every
// outbound mail enqueues, retries on failure, dead-letters after N attempts, and
// surfaces a status the operator can query. NONE of the invite flow may get stuck
// behind a failing transport — pending invites carry an email-independent
// accept-link (see invite.ts).
//
// Pure logic + injectable transport (the project's port pattern). The unit suite
// uses a fake transport that can throw — NO real SMTP here. The concrete nodemailer
// transport + the loop that drains this queue are integration-verified-later.

export interface MailMessage {
  to: string;
  subject: string;
  body: string;
}

/** Injectable transport. The real one wraps SMTP; the fake one can throw to test retry. */
export interface MailTransport {
  send(msg: MailMessage): Promise<void>;
}

/** Operator-visible lifecycle of a queued message. */
export type MailStatus = "pending" | "failed" | "sent" | "dead";

export interface QueuedMail {
  id: string;
  msg: MailMessage;
  status: MailStatus;
  attempts: number;
  /** Last transport error message, surfaced to the operator on failure. */
  lastError?: string;
}

export interface MailQueueOptions {
  /** Attempts before a message is dead-lettered. Default 3. */
  maxAttempts?: number;
  /** ID generator (injectable for deterministic tests). */
  idGen?: () => string;
}

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * In-memory mail queue: enqueue, attempt delivery via an injectable transport,
 * retry on failure, dead-letter after `maxAttempts`, and expose status.
 *
 * v0 keeps the queue in memory (single self-host box). Durable backing (a DB
 * table so a restart doesn't lose the queue) is integration-verified-later; the
 * enqueue/retry/dead-letter/status STATE MACHINE is what this story unit-tests.
 */
export class MailQueue {
  private readonly maxAttempts: number;
  private readonly idGen: () => string;
  private readonly items = new Map<string, QueuedMail>();

  constructor(opts: MailQueueOptions = {}) {
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    let seq = 0;
    this.idGen = opts.idGen ?? (() => `mail_${++seq}`);
  }

  /** Enqueue a message in `pending` state. Returns its queue id. */
  enqueue(msg: MailMessage): string {
    const id = this.idGen();
    this.items.set(id, { id, msg, status: "pending", attempts: 0 });
    return id;
  }

  /**
   * Attempt to deliver one queued message via the transport.
   * - success → `sent`.
   * - throw, attempts still below max → `failed` (eligible for retry).
   * - throw, attempts reach max → `dead` (dead-letter; operator must intervene).
   * Returns the resulting record.
   */
  async attempt(id: string, transport: MailTransport): Promise<QueuedMail> {
    const item = this.items.get(id);
    if (!item) throw new Error(`MailQueue: unknown message ${id}`);
    if (item.status === "sent" || item.status === "dead") return item;

    item.attempts += 1;
    try {
      await transport.send(item.msg);
      item.status = "sent";
      item.lastError = undefined;
    } catch (err) {
      item.lastError = err instanceof Error ? err.message : String(err);
      item.status = item.attempts >= this.maxAttempts ? "dead" : "failed";
    }
    return item;
  }

  /**
   * Drive a message through retries: keep attempting until it is sent or dead.
   * The fake transport recovering on a later attempt → `sent`; a permanently
   * failing transport → `dead` after `maxAttempts`. Returns the final record.
   */
  async deliverWithRetry(id: string, transport: MailTransport): Promise<QueuedMail> {
    let item = this.items.get(id);
    if (!item) throw new Error(`MailQueue: unknown message ${id}`);
    while (item.status !== "sent" && item.status !== "dead") {
      item = await this.attempt(id, transport);
    }
    return item;
  }

  /** Convenience: enqueue then drive through retries in one call. */
  async send(msg: MailMessage, transport: MailTransport): Promise<QueuedMail> {
    const id = this.enqueue(msg);
    return this.deliverWithRetry(id, transport);
  }

  /** Operator-visible status of one message. */
  statusOf(id: string): MailStatus | undefined {
    return this.items.get(id)?.status;
  }

  /** Snapshot of one message (for an operator status surface). */
  get(id: string): QueuedMail | undefined {
    const item = this.items.get(id);
    return item ? { ...item } : undefined;
  }

  /** All messages currently dead-lettered (operator must intervene). */
  deadLetters(): QueuedMail[] {
    return [...this.items.values()].filter((i) => i.status === "dead").map((i) => ({ ...i }));
  }

  /** Counts per status — the operator dashboard number (C-009 "surfaces a status"). */
  statusCounts(): Record<MailStatus, number> {
    const counts: Record<MailStatus, number> = { pending: 0, failed: 0, sent: 0, dead: 0 };
    for (const item of this.items.values()) counts[item.status] += 1;
    return counts;
  }
}
