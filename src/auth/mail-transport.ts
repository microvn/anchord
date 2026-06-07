// Concrete MailTransport implementations + the email-provider selector (auth AS-012).
//
// C-008/C-009: the boot-mandatory provider (SMTP or Resend HTTP API) is realized here
// as a MailTransport (the mail-queue port). The selector reads the resolved
// EmailProvider (env.ts; both configured → resend wins) and returns the matching
// transport. Both transports map the queue's MailMessage onto the provider payload.
//
// The provider CLIENTS are injectable so unit tests assert message→payload mapping +
// that send is called, WITHOUT real network. Real network send is
// integration-verified-later; only the mapping + selection are unit-tested here.

import type { MailMessage, MailTransport, MailQueue, QueuedMail } from "./mail-queue";
import type { EmailProvider } from "../config/env";

// Default From — overridable later via config; kept here so the payload always carries
// one (Resend/SMTP both require a from). Not a secret, safe as a constant for v0.
const DEFAULT_FROM = "anchord <no-reply@anchord.local>";

// ---------------------------------------------------------------------------
// Injectable client shapes (structural subsets of the real SDKs — keeps the unit
// tests free of the real `resend` / `nodemailer` packages and any network).
// ---------------------------------------------------------------------------

/** Subset of the Resend client we use: `client.emails.send({from,to,subject,html})`. */
export interface ResendLike {
  emails: {
    send(payload: { from: string; to: string; subject: string; html: string }): Promise<{
      data: { id: string } | null;
      error: { name: string; message: string } | null;
    }>;
  };
}

/** Subset of a nodemailer transporter: `transporter.sendMail({from,to,subject,html})`. */
export interface NodemailerLike {
  sendMail(payload: { from: string; to: string; subject: string; html: string }): Promise<{
    messageId: string;
  }>;
}

export interface MailTransportDeps {
  /** Inject a fake Resend client in tests; the real one is built lazily otherwise. */
  resendClient?: ResendLike;
  /** Inject a fake nodemailer transporter in tests; the real one is built lazily otherwise. */
  smtpTransporter?: NodemailerLike;
  /** From address override (defaults to DEFAULT_FROM). */
  from?: string;
}

/** Build the real Resend client. Imported lazily so tests never touch the SDK. */
function realResend(apiKey: string): ResendLike {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Resend } = require("resend") as typeof import("resend");
  return new Resend(apiKey) as unknown as ResendLike;
}

/** Build the real nodemailer transporter. Imported lazily so tests never touch it. */
function realSmtp(cfg: Extract<EmailProvider, { kind: "smtp" }>): NodemailerLike {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodemailer = require("nodemailer") as typeof import("nodemailer");
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    auth: { user: cfg.user, pass: cfg.pass },
  }) as unknown as NodemailerLike;
}

/**
 * Select + build the MailTransport for the resolved email provider (AS-012).
 *
 * - `kind: "resend"` → wraps the Resend client; maps body → html.
 * - `kind: "smtp"`   → wraps a nodemailer transporter; maps body → html.
 *
 * A Resend API error is thrown (not swallowed) so the shared MailQueue's
 * retry/dead-letter machinery (C-009) drives it like any transport failure.
 */
export function createMailTransport(
  provider: EmailProvider,
  deps: MailTransportDeps = {},
): MailTransport {
  const from = deps.from ?? DEFAULT_FROM;

  if (provider.kind === "resend") {
    const client = deps.resendClient ?? realResend(provider.apiKey);
    return {
      async send(msg: MailMessage): Promise<void> {
        const res = await client.emails.send({
          from,
          to: msg.to,
          subject: msg.subject,
          html: msg.body,
        });
        if (res.error) {
          throw new Error(`Resend send failed: ${res.error.name} — ${res.error.message}`);
        }
      },
    };
  }

  // kind === "smtp"
  const transporter = deps.smtpTransporter ?? realSmtp(provider);
  return {
    async send(msg: MailMessage): Promise<void> {
      await transporter.sendMail({
        from,
        to: msg.to,
        subject: msg.subject,
        html: msg.body,
      });
    },
  };
}

/**
 * Enqueue an app mail on the shared queue and drive it to a terminal state through
 * the selected transport (AS-012 / C-009). All outbound app mail goes through here so
 * it inherits the queue's retry + dead-letter + status machinery.
 */
export function sendAppMail(
  queue: MailQueue,
  transport: MailTransport,
  msg: MailMessage,
): Promise<QueuedMail> {
  return queue.send(msg, transport);
}

/** The shape better-auth passes to emailVerification.sendVerificationEmail. */
export interface VerificationMailArgs {
  user: { email: string };
  url: string;
}

/**
 * Build the `sendVerificationEmail` callback better-auth calls (AS-012). It enqueues a
 * verification mail via the shared queue + selected transport — so verification mail
 * flows through the same retry/dead-letter path as everything else (C-009).
 *
 * The live better-auth callback registration (passing this into createAuth's
 * emailVerification block) is integration-verified-later; this unit-tests that the
 * returned callback enqueues + sends the mapped message.
 */
export function makeSendVerificationEmail(queue: MailQueue, transport: MailTransport) {
  return async ({ user, url }: VerificationMailArgs): Promise<void> => {
    await sendAppMail(queue, transport, {
      to: user.email,
      subject: "Verify your email",
      body: `<p>Confirm your anchord account:</p><p><a href="${url}">${url}</a></p>`,
    });
  };
}

/**
 * Send a pending-invite email through the shared queue + selected transport (AS-012 /
 * C-009). The mail carries the email-independent accept-link (invite.ts) so the
 * invitee can still join even if delivery later fails — the queue handles retry/
 * dead-letter, the link is the belt-and-braces path.
 */
export function sendInviteEmail(
  queue: MailQueue,
  transport: MailTransport,
  args: { to: string; acceptLink: string },
): Promise<QueuedMail> {
  return sendAppMail(queue, transport, {
    to: args.to,
    subject: "You've been invited to a doc on anchord",
    body: `<p>You have a pending invite. Accept it here:</p><p><a href="${args.acceptLink}">${args.acceptLink}</a></p>`,
  });
}
