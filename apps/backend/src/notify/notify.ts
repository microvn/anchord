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
  /**
   * S-007: the annotation's doc slug — used to build the email deep-link
   * `{APP_URL}/d/{slug}#annotation-{id}` (C-013). Null when the slug can't be resolved (the
   * email then omits the link rather than crashing). Optional so existing fakes stay valid.
   */
  getDocSlug?(annotationId: string): Promise<string | null>;
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
  // S-007: the mail message now carries `text?`/`html?` (v0 fills `text`), matching MailMessage.
  enqueue(msg: { to: string; subject: string; text?: string; html?: string }): string;
}

// ---------------------------------------------------------------------------
// S-007 — email eligibility (C-006) + deep-link building (C-013). These are the
// reusable seams the per-event dispatch (S-001/S-002/S-003/S-004/S-005) plugs into:
// every event resolves its email eligibility from its NotificationType, and every
// high-signal email body carries an absolute deep-link built from APP_URL.
// ---------------------------------------------------------------------------

/**
 * High-signal notification types — these send email AND in-app (C-006). Everything else is
 * low-signal: in-app only, no email. Eligibility is DERIVED from `type`, never a stored column.
 * `reply` counts as high-signal (it is the legacy thread-activity alias, kept green until S-002).
 */
const HIGH_SIGNAL_TYPES: ReadonlySet<NotificationType> = new Set<NotificationType>([
  "reply",
  "new_feedback",
  "thread_activity",
  "suggestion_decided",
]);

/** True iff a notification of this type should also send an email (C-006). */
export function isEmailEligible(type: NotificationType): boolean {
  return HIGH_SIGNAL_TYPES.has(type);
}

/**
 * Build the absolute deep-link to an annotation in a doc (C-013):
 * `{APP_URL}/d/{slug}#annotation-{id}`. The route is `/d/:slug` (no `/v/:id` version route —
 * deep-links omit version); the viewer reads the `#annotation-:id` fragment on mount and scrolls
 * to + highlights that annotation. A trailing slash on APP_URL is trimmed so the path joins clean.
 */
export function buildAnnotationDeepLink(appUrl: string, slug: string, annotationId: string): string {
  const base = appUrl.replace(/\/+$/, "");
  return `${base}/d/${encodeURIComponent(slug)}#annotation-${encodeURIComponent(annotationId)}`;
}

/**
 * Compose the per-event plain-text email body for a high-signal notification (C-012, GAP-004).
 * Minimal content only: a one-line per-type summary + the deep-link line. The doc body is NEVER
 * embedded (personal-data minimization). GAP-004 is a build-time copy decision — these are the
 * chosen sensible one-liners; tweak copy freely without touching behavior.
 */
const EVENT_SUMMARY: Record<NotificationType, string> = {
  reply: "There's a new reply in a thread you're part of.",
  thread_activity: "There's new activity in a thread you're part of.",
  new_feedback: "Someone left new feedback on your doc.",
  suggestion_decided: "A decision was made on your suggestion.",
  // low-signal types never reach the email body builder, but keep the map total for the type.
  resolved: "An annotation you created was resolved.",
  detached: "Some of your annotations were detached.",
  invited: "You were invited.",
};

export function buildEmailBody(type: NotificationType, deepLink: string): string {
  const summary = EVENT_SUMMARY[type] ?? "You have a new notification on anchord.";
  return `${summary}\n\nOpen it here:\n${deepLink}`;
}

const EVENT_SUBJECT: Record<NotificationType, string> = {
  reply: "New reply on a doc you're following",
  thread_activity: "New activity on a doc you're following",
  new_feedback: "New feedback on your doc",
  suggestion_decided: "Your suggestion was decided",
  resolved: "An annotation was resolved",
  detached: "Annotations were detached",
  invited: "You've been invited",
};

export function emailSubjectFor(type: NotificationType): string {
  return EVENT_SUBJECT[type] ?? "anchord notification";
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
  /**
   * S-007: the absolute public base URL (config APP_URL). Used to build the email deep-link
   * (C-013). When absent the email still sends with its summary but without the link line.
   */
  appUrl?: string;
  /**
   * S-007: the notification type for this event (C-006). Email eligibility is derived from it —
   * a low-signal type sends NO email (in-app row only). Defaults to `reply` (the legacy
   * high-signal alias) so the existing reply-notify path is unchanged.
   */
  type?: NotificationType;
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
  const type: NotificationType = deps.type ?? "reply";
  const log = deps.logError ?? ((msg, err) => console.error(msg, err));
  const empty: NotifyResult = { recipients: [], inAppSent: 0, emailsSent: 0 };

  try {
    const [participantIds, docOwnerId] = await Promise.all([
      deps.repo.listParticipantIds(annotationId),
      deps.repo.getDocOwnerId(annotationId),
    ]);
    const recipients = computeRecipients(participantIds, docOwnerId, replierUserId);

    // C-006: email is sent ONLY for a high-signal type. A low-signal event writes the in-app
    // row(s) and enqueues NO mail. Eligibility is derived from `type`, never a stored column.
    const emailEligible = isEmailEligible(type);
    // C-013: resolve the doc slug once (per event) to build the per-recipient deep-link.
    const slug = emailEligible && deps.repo.getDocSlug ? await deps.repo.getDocSlug(annotationId) : null;

    let inAppSent = 0;
    let emailsSent = 0;
    for (const userId of recipients) {
      // Channel 1 — in-app: one notification row per recipient (always, the durable channel).
      await deps.repo.insertNotification({ userId, type, refId: annotationId });
      inAppSent += 1;

      // Channel 2 — email: high-signal only (C-006); one mail per recipient that has an address.
      // Guard a missing email (account-holders should always have one, but never crash on null).
      if (!emailEligible) continue;
      const email = await deps.repo.getUserEmail(userId);
      if (email != null && email.length > 0) {
        // C-013 / C-012: plain-text body carrying the absolute deep-link (no doc body embedded).
        const deepLink =
          deps.appUrl && slug ? buildAnnotationDeepLink(deps.appUrl, slug, annotationId) : null;
        const text = deepLink
          ? buildEmailBody(type, deepLink)
          : EVENT_SUMMARY[type] ?? "You have a new notification on anchord.";
        deps.mail.enqueue({ to: email, subject: emailSubjectFor(type), text });
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
