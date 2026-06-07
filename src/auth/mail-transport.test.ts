import { test, expect } from "bun:test";
import {
  createMailTransport,
  sendAppMail,
  makeSendVerificationEmail,
  sendInviteEmail,
  type ResendLike,
  type NodemailerLike,
} from "./mail-transport";
import { buildAcceptLink } from "./invite";
import { MailQueue, type MailMessage } from "./mail-queue";
import type { EmailProvider } from "../config/env";

// AS-012 (auth S-005): mail is delivered via the CONFIGURED email provider, through
// the shared MailTransport port + queue. With a Resend config the queue drains into
// the Resend client; with an SMTP config it drains into nodemailer. The transport
// clients are INJECTED so we assert message→payload mapping WITHOUT real network.
// Real network send = integration-verified-later.

const msg: MailMessage = { to: "bob@x.com", subject: "Verify your email", body: "<a href='#'>click</a>" };

const resendCfg: EmailProvider = { kind: "resend", apiKey: "re_test_key" };
const smtpCfg: EmailProvider = {
  kind: "smtp",
  host: "smtp.example.com",
  port: 587,
  user: "anchord",
  pass: "secret",
};

/** Fake Resend client capturing the send payload — no network. */
function fakeResend(): { client: ResendLike; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    client: {
      emails: {
        async send(payload) {
          calls.push(payload as Record<string, unknown>);
          return { data: { id: "re_123" }, error: null };
        },
      },
    },
    calls,
  };
}

/** Fake nodemailer transporter capturing sendMail args — no network. */
function fakeTransporter(): { transporter: NodemailerLike; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    transporter: {
      async sendMail(payload) {
        calls.push(payload as Record<string, unknown>);
        return { messageId: "smtp_123" };
      },
    },
    calls,
  };
}

test("AS-012: Resend transport — draining the queue calls the Resend client with the mapped payload", async () => {
  const { client, calls } = fakeResend();
  const transport = createMailTransport(resendCfg, { resendClient: client });
  const q = new MailQueue();

  const final = await q.send(msg, transport);

  expect(final.status).toBe("sent");
  expect(calls).toHaveLength(1);
  // body → html mapping; from is the configured/default sender.
  expect(calls[0]).toMatchObject({
    to: "bob@x.com",
    subject: "Verify your email",
    html: "<a href='#'>click</a>",
  });
  expect(typeof calls[0]!.from).toBe("string");
});

test("AS-012: Resend transport — a provider error surfaces as a thrown send (so the queue can retry/dead-letter)", async () => {
  const errClient: ResendLike = {
    emails: {
      async send() {
        return { data: null, error: { name: "rate_limit_exceeded", message: "slow down" } };
      },
    },
  };
  const transport = createMailTransport(resendCfg, { resendClient: errClient });
  const q = new MailQueue({ maxAttempts: 2 });

  const final = await q.send(msg, transport);

  // The transport must throw on a Resend error so the existing queue retry/dead-letter
  // machinery (C-009) drives it — it must NOT silently swallow the failure.
  expect(final.status).toBe("dead");
  expect(final.lastError).toContain("slow down");
});

test("AS-012: SMTP transport — draining the queue calls nodemailer sendMail with the mapped payload", async () => {
  const { transporter, calls } = fakeTransporter();
  const transport = createMailTransport(smtpCfg, { smtpTransporter: transporter });
  const q = new MailQueue();

  const final = await q.send(msg, transport);

  expect(final.status).toBe("sent");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    to: "bob@x.com",
    subject: "Verify your email",
    html: "<a href='#'>click</a>",
  });
});

test("AS-012: selector picks Resend when the config kind is resend, SMTP otherwise", async () => {
  // The active transport is chosen purely by the resolved EmailProvider kind
  // (env resolves both→resend). Prove the selector routes to the right client.
  const r = fakeResend();
  const s = fakeTransporter();

  const resendT = createMailTransport(resendCfg, { resendClient: r.client, smtpTransporter: s.transporter });
  const smtpT = createMailTransport(smtpCfg, { resendClient: r.client, smtpTransporter: s.transporter });

  await resendT.send(msg);
  await smtpT.send(msg);

  expect(r.calls).toHaveLength(1); // resend config → resend client only
  expect(s.calls).toHaveLength(1); // smtp config → nodemailer only
});

test("AS-012 / C-009: sendAppMail enqueues on the queue and delivers via the selected transport", async () => {
  const { client, calls } = fakeResend();
  const transport = createMailTransport(resendCfg, { resendClient: client });
  const q = new MailQueue();

  const rec = await sendAppMail(q, transport, msg);

  // Wired through the shared queue (C-009 retry/dead-letter machinery), not sent ad-hoc.
  expect(rec.status).toBe("sent");
  expect(q.statusOf(rec.id)).toBe("sent");
  expect(calls).toHaveLength(1);
});

test("AS-012 / C-009: makeSendVerificationEmail enqueues a verification mail through queue+transport", async () => {
  // better-auth calls emailVerification.sendVerificationEmail({user,url}); the helper
  // we hand it must enqueue via the shared MailQueue + selected transport (the live
  // better-auth callback wiring is integration-verified-later).
  const { client, calls } = fakeResend();
  const transport = createMailTransport(resendCfg, { resendClient: client });
  const q = new MailQueue();

  const send = makeSendVerificationEmail(q, transport);
  await send({ user: { email: "alice@x.com" }, url: "https://app/verify?t=abc" });

  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ to: "alice@x.com" });
  expect(String(calls[0]!.html)).toContain("https://app/verify?t=abc"); // verify URL in the body
  expect(q.statusCounts().sent).toBe(1);
});

test("AS-012 / C-009: sendInviteEmail enqueues an invite mail carrying the accept-link through queue+transport", async () => {
  const { client, calls } = fakeResend();
  const transport = createMailTransport(resendCfg, { resendClient: client });
  const q = new MailQueue();
  const link = buildAcceptLink("inv_1", "tok_abc");

  await sendInviteEmail(q, transport, { to: "carol@x.com", acceptLink: link });

  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ to: "carol@x.com" });
  expect(String(calls[0]!.html)).toContain(link); // email-independent accept-link in body
  expect(q.statusCounts().sent).toBe(1);
});

test("AS-012: empty recipient still maps through (transport does not silently drop) — edge", async () => {
  // The transport is a thin mapper; validation lives upstream. An empty `to` must
  // still reach the client as an empty string, not be dropped, so a misuse is visible.
  const { client, calls } = fakeResend();
  const transport = createMailTransport(resendCfg, { resendClient: client });
  await transport.send({ to: "", subject: "s", body: "b" });
  expect(calls[0]).toMatchObject({ to: "", subject: "s", html: "b" });
});
