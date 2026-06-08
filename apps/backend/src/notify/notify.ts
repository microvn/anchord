// Notify on reply (workspace-project S-006, AS-011 / C-004).
//
// On a SUCCESSFUL reply to an annotation, notify the thread participants ∪ the doc
// owner, MINUS the replier — over TWO channels per recipient: an in-app row
// (notifications table) AND one email (the shared MailQueue). The replier never
// notifies themselves; the owner-who-is-also-a-participant is deduped to ONE
// notification.
//
// GAP-002 (email opt-out / digest vs per-event) is OPEN and parked for v0. This
// builds the SIMPLE form per AS-011: ALWAYS send, ONE email per reply event — no
// opt-out preference, no digest, no preferences table.
//
// BEST-EFFORT / POST-COMMIT: the reply has already persisted by the time this runs;
// notify must NEVER fail the reply. A throwing repo/mail-queue is swallowed (logged),
// never surfaced — see notifyOnReply's try/catch. Pure logic + injectable ports
// (NotifyRepo + a minimal MailEnqueuer), unit-tested with fakes; the route composition
// + the real MailQueue wiring are integration/glue-verified.

import type { NotificationType } from "./types";

/** What insertNotification persists — one in-app notification row for one recipient. */
export interface NewNotification {
  /** The recipient (account-holder user.id). */
  userId: string;
  type: NotificationType;
  /** Deep-link target — the annotation (thread) id that received the reply. */
  refId: string;
}

/**
 * Persistence + lookup port for notify. The Drizzle implementation
 * (src/notify/repo.ts) is thin glue; keeping it a port makes the recipient-set logic
 * unit-testable without a DB (the project's established pattern).
 */
export interface NotifyRepo {
  /** DISTINCT account-holder author_ids on the annotation (guests excluded — null author_id). */
  listParticipantIds(annotationId: string): Promise<string[]>;
  /** The annotation's doc's owner_id, or null when the doc has no owner. */
  getDocOwnerId(annotationId: string): Promise<string | null>;
  /** The recipient's email (for the email channel), or null when absent. */
  getUserEmail(userId: string): Promise<string | null>;
  /** Insert one in-app notification row. */
  insertNotification(input: NewNotification): Promise<{ id: string }>;
}

/**
 * Minimal email-enqueue port — the subset of MailQueue the notify path uses. The real
 * MailQueue (src/auth/mail-queue.ts) satisfies this structurally (its `enqueue` returns
 * a queue id). A fake in tests records calls / can throw. Notify only ENQUEUES (one mail
 * per recipient); draining/retry/dead-letter stays the queue's own concern.
 */
export interface MailEnqueuer {
  enqueue(msg: { to: string; subject: string; body: string }): string;
}

export interface NotifyOnReplyInput {
  /** The annotation (thread) the reply landed on — also the in-app deep-link ref. */
  annotationId: string;
  /**
   * The acting replier's user id, or null for a GUEST reply (no account). A guest is
   * never a recipient anyway, so a null replier simply excludes nobody from the set.
   */
  replierUserId: string | null;
}

/** What a notify pass did — the recipients reached and rows/mails sent (for assertions/logs). */
export interface NotifyResult {
  /** Distinct recipient user ids actually notified (participants ∪ owner − replier). */
  recipients: string[];
  /** Count of in-app notification rows inserted (one per recipient). */
  inAppSent: number;
  /** Count of emails enqueued (one per recipient that has an email). */
  emailsSent: number;
}

export interface NotifyDeps {
  repo: NotifyRepo;
  mail: MailEnqueuer;
  /** Optional structured logger for best-effort failures (defaults to console.error). */
  logError?: (msg: string, err: unknown) => void;
}

/**
 * Compute the recipient set for a reply: (participants ∪ {docOwner}) − replier, deduped.
 *
 * - participants: account-holder author_ids on the thread (guests already excluded by
 *   the repo — a null author_id never appears here).
 * - docOwner: included when present (null → no owner to notify).
 * - replier: removed last — the rule "the replier never notifies themselves" wins even
 *   when the replier is also a participant or the owner. A guest replier (null) removes
 *   nobody.
 *
 * Returns a deduped list (C is both owner and participant → ONE entry).
 */
export function computeRecipients(
  participantIds: string[],
  docOwnerId: string | null,
  replierUserId: string | null,
): string[] {
  const set = new Set<string>(participantIds);
  if (docOwnerId != null) set.add(docOwnerId);
  if (replierUserId != null) set.delete(replierUserId);
  return [...set];
}

/**
 * Notify thread participants + doc owner of a reply (AS-011 / C-004), over in-app +
 * email, excluding the replier and deduping owner==participant.
 *
 * BEST-EFFORT: this runs AFTER the reply has persisted (post-commit). The whole pass is
 * wrapped so a throwing repo or mail enqueue is logged and swallowed — a reply is never
 * turned into a 500 because notify failed. The route awaits this but ignores its outcome
 * for the response.
 *
 * Per recipient: insert ONE in-app row (type='reply', ref=annotationId) AND enqueue ONE
 * email (looked up from the user's email; skipped/guarded when the user has no email —
 * shouldn't happen for an account-holder, but we don't crash on it).
 */
export async function notifyOnReply(
  input: NotifyOnReplyInput,
  deps: NotifyDeps,
): Promise<NotifyResult> {
  const { annotationId, replierUserId } = input;
  const log = deps.logError ?? ((msg, err) => console.error(msg, err));
  const empty: NotifyResult = { recipients: [], inAppSent: 0, emailsSent: 0 };

  try {
    const [participantIds, docOwnerId] = await Promise.all([
      deps.repo.listParticipantIds(annotationId),
      deps.repo.getDocOwnerId(annotationId),
    ]);
    const recipients = computeRecipients(participantIds, docOwnerId, replierUserId);

    let inAppSent = 0;
    let emailsSent = 0;
    for (const userId of recipients) {
      // Channel 1 — in-app: one notification row per recipient.
      await deps.repo.insertNotification({ userId, type: "reply", refId: annotationId });
      inAppSent += 1;

      // Channel 2 — email: one mail per recipient that has an address. Guard a missing
      // email (account-holders should always have one, but never crash the loop on null).
      const email = await deps.repo.getUserEmail(userId);
      if (email != null && email.length > 0) {
        deps.mail.enqueue({
          to: email,
          subject: "New reply on a doc you're following",
          body: `<p>There's a new reply in a thread you're part of.</p>`,
        });
        emailsSent += 1;
      }
    }
    return { recipients, inAppSent, emailsSent };
  } catch (err) {
    // Post-commit best-effort: log and swallow so the reply still succeeds (C-004 intent
    // — notify must not block/fail the reply).
    log("notifyOnReply failed (best-effort, reply already persisted)", err);
    return empty;
  }
}
