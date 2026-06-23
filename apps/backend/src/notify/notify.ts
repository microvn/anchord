// Notify on thread activity (notifications-email S-002, AS-003/AS-004/AS-005/AS-023 / C-004).
// (Folds the workspace-project S-006 reply baseline into the broader thread-activity event.)
//
// On a SUCCESSFUL comment OR reply landing on an EXISTING annotation, notify the thread
// participants ∪ the doc owner, MINUS the actor — over TWO channels per recipient: an in-app
// row (notifications table) AND one email (the shared MailQueue). The actor never notifies
// themselves; the owner-who-is-also-a-participant is deduped to ONE notification. The emitted
// type is `thread_activity` (C-004) — a brand-new annotation is `new_feedback` (S-001), NOT
// thread activity, so a top-level comment on an EXISTING annotation routes HERE, not there
// (the trigger-drift fix, AS-004). A per-recipient access-filter (C-003) drops a participant
// who lost doc access before any channel fires (same real-resolver seam S-001 uses).
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
import { defaultEnabled } from "./preferences-matrix";

/** What insertNotification persists — one in-app notification row for one recipient. */
export interface NewNotification {
  /** The recipient (account-holder user.id). */
  userId: string;
  type: NotificationType;
  /** Deep-link target — the annotation (thread) id that received the reply. */
  refId: string;
  /**
   * S-006 (AS-027/AS-028): the TRIGGERING comment id for a comment-type row
   * (reply/new_feedback/thread_activity) — backs the panel's actorName + snippet via a read-side
   * join. Null/undefined for non-comment types; persisted as NULL and set-null if the comment is
   * later removed (C-014, the read then degrades to the generic per-type summary).
   */
  commentId?: string | null;
  /**
   * workspace-notifications S-001 (F1): a human-readable display label snapshotted at EMIT time
   * (e.g. the workspace name for `workspace_invited`). Persisted to `notifications.ref_label` so
   * the bell renders without a live join that could leak a workspace's CURRENT name to a
   * since-removed member. Undefined/null for annotation/doc rows (they enrich via refId→docs).
   */
  refLabel?: string | null;
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
  /**
   * S-001 (new_feedback): DISTINCT account-holder user_ids that are ACTIVE EDITORS on the
   * annotation's doc (doc_members where role='editor', status='active', bound to a user).
   * Empty for an owner-only doc. Optional so existing reply-path fakes stay valid — the
   * new-feedback dispatch treats a missing impl as "no editors".
   */
  listEditorIds?(annotationId: string): Promise<string[]>;
  /** The recipient's email (for the email channel), or null when absent. */
  getUserEmail(userId: string): Promise<string | null>;
  /**
   * S-007: the annotation's doc slug — used to build the email deep-link
   * `{APP_URL}/d/{slug}#annotation-{id}` (C-013). Null when the slug can't be resolved (the
   * email then omits the link rather than crashing). Optional so existing fakes stay valid.
   */
  getDocSlug?(annotationId: string): Promise<string | null>;
  /**
   * workspace-notifications S-001: resolve the account user id for an email, or null when no
   * account exists for it (a pending invite to an account-less address — then no in-app row).
   * Optional so existing annotation-path fakes stay valid.
   */
  findUserIdByEmail?(email: string): Promise<string | null>;
  /**
   * workspace-notifications S-001: every ADMIN's user id in the workspace. S-001 itself only needs
   * the invitee path, but the port is added now (S-002 join-notify consumes it). Optional so
   * existing fakes stay valid.
   */
  listWorkspaceAdminIds?(workspaceId: string): Promise<string[]>;
  /**
   * workspace-notifications S-001: every MEMBER's user id in the workspace (admins + members). Added
   * now for S-004 (rename → all members). Optional so existing fakes stay valid.
   */
  listWorkspaceMemberIds?(workspaceId: string): Promise<string[]>;
  /**
   * workspace-notifications S-002: the workspace's CURRENT name, snapshotted at emit into the
   * `workspace_member_joined` refLabel (F1 — rendered without a live `workspaces` join). Null when
   * the workspace can't be resolved. Optional so existing annotation-path fakes stay valid.
   */
  getWorkspaceName?(workspaceId: string): Promise<string | null>;
  /**
   * workspace-notifications S-002: a user's DISPLAY NAME (the `user.name` column — NEVER their email,
   * F-security), for the join notice's "<joiner> joined <ws>" copy. Null when absent. Optional so
   * existing fakes stay valid.
   */
  getUserName?(userId: string): Promise<string | null>;
  /** Insert one in-app notification row. */
  insertNotification(input: NewNotification): Promise<{ id: string }>;
  /**
   * workspace-notifications S-002 (C-005): BATCH-insert N in-app rows in ONE round-trip (a single
   * Drizzle `insert().values([...])`), not a serial per-recipient loop. Backs the multi-recipient
   * fan-out events (join → all admins; S-004 rename → all members). Optional so existing fakes stay
   * valid — the batch path falls back to per-row `insertNotification` when this port is absent.
   */
  insertNotifications?(rows: NewNotification[]): Promise<{ id: string }[]>;
  /**
   * notification-preferences S-002 (C-006): the BATCHED per-recipient preferences read. Given the
   * full recipient set + the event type, return — per user — the EFFECTIVE channel decision
   * `{ inApp, email }` for THIS type, built from the matrix default ∪ the user's stored overrides ∪
   * their master email switch. Read ONCE per dispatch (NOT once per recipient — no N+1). A user
   * absent from the returned map reads the matrix default (no override, master on). Optional so the
   * existing notify fakes (which have no prefs port) stay valid: a missing port means "matrix
   * defaults, no overrides, master on" — so high-signal types still email by default (back-compat).
   * On throw the delivery path fails CLOSED for email (skip + log) and OPEN for in-app (still write).
   */
  listPreferencesFor?(
    userIds: string[],
    type: NotificationType,
  ): Promise<Map<string, { inApp: boolean; email: boolean }>>;
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
 * notification-preferences S-002 — the SINGLE source of truth for "does this type send email by
 * DEFAULT" is now the supported-channel MATRIX (preferences-matrix.ts), NOT a hand-kept
 * HIGH_SIGNAL_TYPES set. Routing eligibility through the matrix is what makes per-user overrides
 * apply at delivery — the matrix is the SSOT S-001 already built, so a second set here would be a
 * drift hazard. The legacy HIGH_SIGNAL_TYPES set is retired in favor of `defaultEnabled(type,
 * "email")`. The doc-share `invited` event is in-app only in the matrix (no email channel — the
 * transactional invite email is a separate pre-existing channel), so it emails no one here.
 *
 * Crucially this only ever sets the DEFAULT base eligibility: a low-signal type (resolved/detached)
 * has no email channel in the matrix → false → still emails no one. Per-recipient preferences and
 * the master switch (read in the delivery path) only ever NARROW from this default, never widen it.
 */
export function isEmailEligible(type: NotificationType): boolean {
  return defaultEnabled(type, "email");
}

/**
 * C-002 (delivery lock): the CRITICAL in-app notices that are always-on and CANNOT be suppressed by
 * any stored preference or a prefs-read failure. This hardcoded set is consulted BEFORE reading any
 * preference row, so a stray `{type, in_app, false}` override (which the write API already refuses)
 * or a transient prefs-read error can never drop the in-app row for these types. Mirrors the matrix
 * `locked` flag (defence-in-depth) but enforced at the DELIVERY path (S-001 enforces it at the
 * write API + effective-read; S-002 enforces it here).
 */
const ALWAYS_DELIVER_IN_APP: ReadonlySet<NotificationType> = new Set<NotificationType>([
  "detached",
  "workspace_member_removed",
]);

/**
 * notification-preferences S-002 (C-006) — resolve the EFFECTIVE per-recipient channel decisions
 * for one dispatch in ONE batched read. Returns a function `(userId) → { inApp, email }`.
 *
 * - No prefs port (existing fakes / unwired callers) → matrix defaults for everyone, master on.
 * - The port THROWS (transient DB error) → fail CLOSED for email (email=false for everyone — never
 *   re-send a silenced email) and OPEN for in-app (inApp=true — the durable row is still written);
 *   the failure is logged. This is the channel-split fail-safe (C-006).
 * - Otherwise: a user present in the port's map uses their effective decision; a user ABSENT reads
 *   the matrix default for the type (no override, master on).
 *
 * In ALL cases the C-002 always-deliver set forces in-app on for its types — applied by the caller
 * AFTER this resolver, so even a fail-closed/disabled decision can't drop a critical in-app row.
 */
async function resolvePreferenceDecisions(
  recipients: string[],
  type: NotificationType,
  deps: NotifyDeps,
): Promise<(userId: string) => { inApp: boolean; email: boolean }> {
  const matrixDefault = {
    inApp: defaultEnabled(type, "in_app"),
    email: defaultEnabled(type, "email"),
  };
  if (recipients.length === 0 || !deps.repo.listPreferencesFor) {
    return () => matrixDefault;
  }
  try {
    const map = await deps.repo.listPreferencesFor(recipients, type);
    return (userId) => map.get(userId) ?? matrixDefault;
  } catch (err) {
    // C-006 fail-safe: email fails CLOSED (skip everywhere), in-app fails OPEN (still deliver).
    const log = deps.logError ?? ((msg, e) => console.error(msg, e));
    log("listPreferencesFor failed — email fails closed, in-app fails open (C-006)", err);
    return () => ({ inApp: true, email: false });
  }
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
 * workspace-notifications S-001 (F3): build the absolute deep-link to a WORKSPACE —
 * `{APP_URL}/w/{workspaceId}`. The existing annotation deep-link is doc-shaped
 * (`/d/{slug}#annotation-{id}`) and useless for a workspace event, so this is a new builder.
 * S-001's `workspace_invited` is in-app only (no email), but S-003's member-removed email needs
 * this — added now so the email half lands without re-touching this module. `encodeURIComponent`
 * keeps a special-char or control-char id from breaking the URL (the builder never throws).
 */
export function buildWorkspaceDeepLink(appUrl: string, workspaceId: string): string {
  const base = appUrl.replace(/\/+$/, "");
  return `${base}/w/${encodeURIComponent(workspaceId)}`;
}

/**
 * workspace-notifications C-006 (S-001 minimal form): strip CR/LF + other control characters
 * from an untrusted, user-controlled workspace name before it is snapshotted into a refLabel or
 * (S-003) interpolated into an email. S-001 only needs the inert-snapshot half; the full
 * length-bounding + email-injection coverage is S-003/AS-009. Bounds length defensively so a
 * pathological name can't bloat a row.
 */
const REF_LABEL_MAX = 200;
export function sanitizeRefLabel(name: string): string {
  // Strip ASCII control chars (incl. CR/LF/TAB, U+0000-U+001F and U+007F) and trim; bound length.
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, REF_LABEL_MAX);
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
  // workspace-notifications S-001 (F3): real, non-fallback copy for ALL FOUR workspace types so the
  // maps stay total over the widened union (tsc) AND S-003's member-removed email never ships
  // placeholder text. workspace_invited/joined/renamed are in-app only (never reach this builder);
  // workspace_member_removed is high-signal and uses this body.
  workspace_invited: "You were invited to a workspace.",
  workspace_member_joined: "Someone joined a workspace you administer.",
  workspace_member_removed: "You were removed from a workspace.",
  workspace_renamed: "A workspace you're in was renamed.",
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
  // workspace-notifications S-001 (F3): non-fallback subjects for all four (totality + S-003 email).
  workspace_invited: "You've been invited to a workspace",
  workspace_member_joined: "A new member joined your workspace",
  workspace_member_removed: "You've been removed from a workspace",
  workspace_renamed: "A workspace you're in was renamed",
};

export function emailSubjectFor(type: NotificationType): string {
  return EVENT_SUBJECT[type] ?? "anchord notification";
}

export interface NotifyOnThreadActivityInput {
  /** The annotation (thread) the comment/reply landed on — also the in-app deep-link ref. */
  annotationId: string;
  /**
   * The acting commenter/replier's user id, or null for a GUEST action (no account). A guest is
   * never a recipient anyway, so a null actor simply excludes nobody from the set (C-002/C-011).
   */
  actorUserId: string | null;
  /**
   * S-006 (AS-027/AS-028): the just-inserted triggering comment id — stored on each in-app row so
   * the panel can join the commenter's display name + a body excerpt. The route has this in hand.
   */
  commentId?: string | null;
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
  /**
   * S-001 / C-003: the access-filter — a candidate without CURRENT doc access is dropped
   * before any channel fires (no in-app row, no email). This MUST call the real access
   * resolver (the seam, AS-002), not a stubbed allow-all: `(userId) → has current access`.
   * Omit on the reply path (it already constrains to participants ∪ owner); the new-feedback
   * dispatch wires it from the route's real `resolveAccess`. Absent → no filtering.
   */
  accessFilter?: (userId: string) => Promise<boolean>;
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
 * S-001 (new_feedback) — compute the candidate set for a brand-new annotation:
 * ({docOwner} ∪ editors) − actor, deduped.
 *
 * - docOwner: included when present (null → no owner row to notify).
 * - editors: every account-holder active editor on the doc (C-001 relationship-derived).
 * - actor: removed last — self-exclusion wins even when the actor is also the owner or an
 *   editor (C-002). A GUEST actor (null) removes nobody, so a guest's new annotation still
 *   notifies owner + editors (C-011).
 *
 * Returns a deduped list — owner-who-is-also-an-editor collapses to ONE entry (C-005). This
 * is the RELATIONSHIP set only; the per-recipient access-filter (C-003) runs in the dispatch
 * after this, against the real resolver.
 */
export function computeNewFeedbackCandidates(
  docOwnerId: string | null,
  editorIds: string[],
  actorUserId: string | null,
): string[] {
  const set = new Set<string>(editorIds);
  if (docOwnerId != null) set.add(docOwnerId);
  if (actorUserId != null) set.delete(actorUserId);
  return [...set];
}

/**
 * S-002 — notify on THREAD ACTIVITY (a comment OR reply on an EXISTING annotation):
 * thread participants ∪ doc owner, minus the actor (C-002), minus any candidate without
 * CURRENT doc access (C-003), over in-app + email (thread_activity is high-signal, C-006),
 * deduped owner==participant (C-005). Emits type `thread_activity` by default (C-004) — a
 * brand-new annotation goes through notifyOnNewFeedback instead, so a top-level comment on an
 * existing annotation lands HERE, not on the new-feedback path (the trigger-drift fix, AS-004).
 *
 * The recipients are RELATIONSHIP-derived server-side (C-001) — participants read from the real
 * thread + the doc owner, never client-selected. The access-filter (deps.accessFilter, C-003) is
 * the seam (AS-002 pattern): it MUST call the real resolver so a participant whose access was
 * revoked is dropped before any channel fires. A guest actor (null) excludes nobody and still
 * notifies the account-holder participants + owner (C-011).
 *
 * BEST-EFFORT / POST-COMMIT (C-007): runs AFTER the comment/reply persists; the whole pass is
 * wrapped so a throwing repo/mail/filter is logged and swallowed — a comment is never turned into
 * a 500 because notify failed. The route awaits this but ignores its outcome for the response.
 *
 * Per recipient: insert ONE in-app row (type='thread_activity', ref=annotationId) AND enqueue ONE
 * email (looked up from the user's email; skipped/guarded when the user has no email — shouldn't
 * happen for an account-holder, but we don't crash on it).
 */
export async function notifyOnThreadActivity(
  input: NotifyOnThreadActivityInput,
  deps: NotifyDeps,
): Promise<NotifyResult> {
  const { annotationId, actorUserId, commentId } = input;
  const type: NotificationType = deps.type ?? "thread_activity";
  const log = deps.logError ?? ((msg, err) => console.error(msg, err));
  const empty: NotifyResult = { recipients: [], inAppSent: 0, emailsSent: 0 };

  try {
    const [participantIds, docOwnerId] = await Promise.all([
      deps.repo.listParticipantIds(annotationId),
      deps.repo.getDocOwnerId(annotationId),
    ]);
    const candidates = computeRecipients(participantIds, docOwnerId, actorUserId);

    // C-003: drop any candidate without CURRENT doc access BEFORE any channel fires. The filter
    // calls the real resolver (the seam) — a revoked participant gets no row and no email. Same
    // approach S-001's notifyOnNewFeedback uses; absent filter → no filtering (back-compat).
    let recipients = candidates;
    if (deps.accessFilter) {
      const filter = deps.accessFilter;
      const checks = await Promise.all(candidates.map((u) => filter(u)));
      recipients = candidates.filter((_, i) => checks[i]);
    }

    return await deliverToRecipients(annotationId, recipients, type, deps, commentId);
  } catch (err) {
    // Post-commit best-effort: log and swallow so the comment still succeeds (C-004/C-007 intent
    // — notify must not block/fail the comment).
    log("notifyOnThreadActivity failed (best-effort, comment already persisted)", err);
    return empty;
  }
}

export interface NotifyOnNewFeedbackInput {
  /** The brand-new annotation — also the in-app deep-link ref. */
  annotationId: string;
  /**
   * The acting creator's user id, or null for a GUEST create (no account). A guest is never a
   * recipient and excludes nobody from the candidate set (C-002/C-011).
   */
  actorUserId: string | null;
  /**
   * S-006 (AS-027/AS-028): the triggering comment id (the create's initial comment) — stored on
   * each in-app row so the panel can show the commenter + a body excerpt. Null when the create
   * carried no comment (annotation without an opening comment), the read then degrades cleanly.
   */
  commentId?: string | null;
}

/**
 * S-001 — notify on NEW FEEDBACK (a brand-new annotation): the doc OWNER and EVERY active
 * EDITOR, minus the actor (C-002), minus any candidate without CURRENT doc access (C-003),
 * over in-app + email (new_feedback is high-signal, C-006), deduped (C-005).
 *
 * The recipients are RELATIONSHIP-derived candidates computed server-side (C-001) — owner +
 * editors, never client-selected. The access-filter (deps.accessFilter, C-003) is the seam
 * (AS-002): it MUST call the real resolver so a candidate whose access was revoked is dropped
 * before any channel fires. A guest actor (null) still notifies owner + editors (C-011).
 *
 * BEST-EFFORT / POST-COMMIT (C-007): runs AFTER the annotation persists; the whole pass is
 * wrapped so a throwing repo/mail/filter is logged and swallowed — a create is never turned
 * into a 500 because notify failed.
 */
export async function notifyOnNewFeedback(
  input: NotifyOnNewFeedbackInput,
  deps: NotifyDeps,
): Promise<NotifyResult> {
  const { annotationId, actorUserId, commentId } = input;
  const type: NotificationType = deps.type ?? "new_feedback";
  const log = deps.logError ?? ((msg, err) => console.error(msg, err));
  const empty: NotifyResult = { recipients: [], inAppSent: 0, emailsSent: 0 };

  try {
    const [docOwnerId, editorIds] = await Promise.all([
      deps.repo.getDocOwnerId(annotationId),
      deps.repo.listEditorIds ? deps.repo.listEditorIds(annotationId) : Promise.resolve([]),
    ]);
    const candidates = computeNewFeedbackCandidates(docOwnerId, editorIds, actorUserId);

    // C-003: drop any candidate without CURRENT doc access BEFORE any channel fires. The filter
    // calls the real resolver (the seam) — a revoked editor gets no row and no email (AS-002).
    let recipients = candidates;
    if (deps.accessFilter) {
      const filter = deps.accessFilter;
      const checks = await Promise.all(candidates.map((u) => filter(u)));
      recipients = candidates.filter((_, i) => checks[i]);
    }

    return await deliverToRecipients(annotationId, recipients, type, deps, commentId);
  } catch (err) {
    log("notifyOnNewFeedback failed (best-effort, annotation already persisted)", err);
    return empty;
  }
}

export interface NotifyOnSuggestionDecidedInput {
  /**
   * The decided suggestion's annotation id — a suggestion IS a suggestion-type annotation, so this
   * is both the deep-link ref and the key the repo (getDocSlug) resolves the doc slug from.
   */
  annotationId: string;
  /**
   * The proposal's durable author (account id), or null for a guest-authored proposal. A guest has
   * no account → no recipient (C-011); a null author yields an empty recipient set.
   */
  authorId: string | null;
  /**
   * The acting owner who decided (accept/reject), resolved SERVER-side. When it equals the author
   * the proposal was self-decided → no recipient (C-002 self-exclusion). Owner-gated route, so an
   * actor always exists in prod; the pure logic still handles a null defensively.
   */
  actorUserId: string | null;
}

/**
 * S-003 — compute the recipient set for a decided suggestion: the proposal's AUTHOR, minus the
 * actor (C-002 self-exclusion). The outcome (accept vs reject) does NOT change the recipient —
 * the author is notified identically either way.
 *
 * - author present + ≠ actor → [author] (the one recipient).
 * - author == actor (owner decided their OWN proposal, AS-007) → [] (self-exclusion, C-002).
 * - author null (guest-authored, C-011) → [] (a guest is never a recipient; and a null author can
 *   never equal a non-null actor, so the guard collapses cleanly to empty).
 *
 * Trivially at most one recipient, so dedup (C-005) is a no-op here, but it routes through the same
 * deliverToRecipients stage as the multi-recipient events.
 */
export function computeSuggestionDecidedRecipient(
  authorId: string | null,
  actorUserId: string | null,
): string[] {
  if (authorId == null) return []; // guest-authored → no account recipient (C-011).
  if (authorId === actorUserId) return []; // self-decided → self-exclusion (C-002, AS-007).
  return [authorId];
}

/**
 * S-003 — notify on SUGGESTION DECIDED (an owner accepted or rejected a proposal): the proposal's
 * AUTHOR, minus the actor (C-002), minus the author if they lost doc access (C-003), over in-app +
 * email (suggestion_decided is high-signal, C-006). The recipient is the durable author resolved
 * SERVER-side (C-001) — never client-selected. Accept and reject notify identically (the recipient
 * rule is independent of the decision outcome).
 *
 * BEST-EFFORT / POST-COMMIT (C-007): runs AFTER the decision persists; the whole pass is wrapped so
 * a throwing repo/mail/filter is logged and swallowed — the decide is never turned into a 500
 * because notify failed. A guest-authored proposal (null author) is a clean no-op (no recipient).
 */
export async function notifyOnSuggestionDecided(
  input: NotifyOnSuggestionDecidedInput,
  deps: NotifyDeps,
): Promise<NotifyResult> {
  const { annotationId, authorId, actorUserId } = input;
  const type: NotificationType = deps.type ?? "suggestion_decided";
  const log = deps.logError ?? ((msg, err) => console.error(msg, err));
  const empty: NotifyResult = { recipients: [], inAppSent: 0, emailsSent: 0 };

  try {
    const candidates = computeSuggestionDecidedRecipient(authorId, actorUserId);

    // C-003: drop the author if they no longer have CURRENT doc access BEFORE any channel fires.
    // The filter hits the real resolver (the seam) — same approach the other events use; absent
    // filter → no filtering (back-compat with unit fakes).
    let recipients = candidates;
    if (deps.accessFilter) {
      const filter = deps.accessFilter;
      const checks = await Promise.all(candidates.map((u) => filter(u)));
      recipients = candidates.filter((_, i) => checks[i]);
    }

    return await deliverToRecipients(annotationId, recipients, type, deps);
  } catch (err) {
    log("notifyOnSuggestionDecided failed (best-effort, decision already persisted)", err);
    return empty;
  }
}

export interface NotifyOnResolvedInput {
  /** The resolved/reopened annotation — also the in-app deep-link ref. */
  annotationId: string;
  /**
   * The annotation's durable CREATOR (account id), or null for a guest-created annotation. A guest
   * has no account → no recipient (C-011); a null creator yields an empty recipient set.
   */
  creatorId: string | null;
  /**
   * The acting resolver/reopener, resolved SERVER-side. When it equals the creator the annotation
   * was self-resolved → no recipient (C-002 self-exclusion). Commenter+ gated route, so an actor
   * always exists in prod; the pure logic still handles a null defensively.
   */
  actorUserId: string | null;
}

/**
 * S-004 — compute the recipient for a resolved/reopened annotation: the annotation's CREATOR,
 * minus the actor (C-002 self-exclusion). Resolve and reopen are IDENTICAL — the recipient rule is
 * independent of the direction (both emit `resolved`).
 *
 * - creator present + ≠ actor → [creator] (the one recipient).
 * - creator == actor (resolver resolving their OWN annotation, AS-008) → [] (self-exclusion, C-002).
 * - creator null (guest-created, C-011) → [] (a guest is never a recipient; a null creator can
 *   never equal a non-null actor, so the guard collapses cleanly to empty).
 *
 * At most one recipient, so dedup (C-005) is a no-op here, but it routes through the same
 * deliverToRecipients stage as the multi-recipient events.
 */
export function computeResolvedRecipient(
  creatorId: string | null,
  actorUserId: string | null,
): string[] {
  if (creatorId == null) return []; // guest-created → no account recipient (C-011).
  if (creatorId === actorUserId) return []; // self-resolved → self-exclusion (C-002, AS-008).
  return [creatorId];
}

/**
 * S-004 — notify on RESOLVED/REOPENED (someone resolved or reopened an annotation): the
 * annotation's durable CREATOR, minus the actor (C-002 self-exclusion), minus the creator if they
 * lost doc access (C-003). IN-APP ONLY — `resolved` is LOW-SIGNAL (C-006), so NO email is ever
 * enqueued (isEmailEligible("resolved") === false → deliverToRecipients sends no mail). Reopen is
 * IDENTICAL: same event type `resolved`, same creator recipient (the toggle direction is invisible
 * to notify). The recipient is the durable creator resolved SERVER-side (C-001) — never client-fed.
 *
 * BEST-EFFORT / POST-COMMIT (C-007): runs AFTER the resolution persists; the whole pass is wrapped
 * so a throwing repo/filter is logged and swallowed — the resolve is never turned into a 500 because
 * notify failed. A guest-created annotation (null creator) is a clean no-op (no recipient).
 */
export async function notifyOnResolved(
  input: NotifyOnResolvedInput,
  deps: NotifyDeps,
): Promise<NotifyResult> {
  const { annotationId, creatorId, actorUserId } = input;
  // C-006: forced LOW-SIGNAL — `resolved` is in-app only regardless of any deps.type override.
  const type: NotificationType = "resolved";
  const log = deps.logError ?? ((msg, err) => console.error(msg, err));
  const empty: NotifyResult = { recipients: [], inAppSent: 0, emailsSent: 0 };

  try {
    const candidates = computeResolvedRecipient(creatorId, actorUserId);

    // C-003: drop the creator if they no longer have CURRENT doc access BEFORE any channel fires.
    // The filter hits the real resolver (the seam) — same approach the other events use; absent
    // filter → no filtering (back-compat with unit fakes).
    let recipients = candidates;
    if (deps.accessFilter) {
      const filter = deps.accessFilter;
      const checks = await Promise.all(candidates.map((u) => filter(u)));
      recipients = candidates.filter((_, i) => checks[i]);
    }

    return await deliverToRecipients(annotationId, recipients, type, deps);
  } catch (err) {
    log("notifyOnResolved failed (best-effort, resolution already persisted)", err);
    return empty;
  }
}

/** A grouped per-author detach tally for one publish: the author + how many of THEIR annotations
 *  detached in that publish. The count feeds the single grouped in-app row's content (AS-009). */
export interface DetachedAuthorGroup {
  authorId: string;
  count: number;
}

export interface NotifyOnDetachedInput {
  /**
   * The deep-link ref for the in-app row — the doc the publish detached annotations on. A detach is
   * a per-publish, per-author GROUP (not a single annotation), so the row points at the doc, not at
   * any one orphaned annotation.
   */
  refId: string;
  /**
   * One entry per AUTHOR whose annotations detached in THIS publish, carrying the count. Already
   * grouped by the caller (the reanchor job) — one row is written per entry (AS-009 grouping is
   * per-recipient per publish). GAP-002 (resolved): the doc owner is NOT auto-added — only the
   * affected annotation AUTHORS are recipients.
   */
  authors: DetachedAuthorGroup[];
}

/**
 * S-004 — notify on a DETACH BURST (a republish orphaned annotations): ONE grouped in-app row per
 * AUTHOR per publish (AS-009), minus any author who lost doc access (C-003). IN-APP ONLY — `detached`
 * is LOW-SIGNAL (C-006), so NO email is ever enqueued. The grouping is the caller's responsibility
 * (the reanchor job tallies per author); this writes exactly one `detached` row per surviving author.
 * An EMPTY author set (0 annotations detached) writes NOTHING — no empty "0 detached" row.
 *
 * Recipients are the affected annotation AUTHORS ONLY (GAP-002) — the owner is NOT notified for
 * OTHERS' detached annotations. A guest-authored annotation never reaches here (the job excludes a
 * null author from the tally — a guest has no account, C-011).
 *
 * BEST-EFFORT / POST-COMMIT (C-007): the reanchor job is fired async OFF the publish path, and this
 * runs after the orphan-marking persists; the whole pass is wrapped so a throwing repo/filter is
 * logged and swallowed — neither the job nor the publish is failed because notify failed.
 */
export async function notifyOnDetached(
  input: NotifyOnDetachedInput,
  deps: NotifyDeps,
): Promise<NotifyResult> {
  const { refId, authors } = input;
  const type: NotificationType = "detached"; // C-006: LOW-SIGNAL, in-app only.
  const log = deps.logError ?? ((msg, err) => console.error(msg, err));
  const empty: NotifyResult = { recipients: [], inAppSent: 0, emailsSent: 0 };

  try {
    // Defensive dedup (C-005): collapse any duplicate author entry to one row (the job already
    // groups, but a malformed caller never produces two rows for one author).
    const seen = new Set<string>();
    const candidates = authors
      .filter((a) => a.authorId != null && a.count > 0)
      .map((a) => a.authorId)
      .filter((id) => (seen.has(id) ? false : (seen.add(id), true)));

    // C-003: drop any author who lost doc access BEFORE any channel fires.
    let recipients = candidates;
    if (deps.accessFilter) {
      const filter = deps.accessFilter;
      const checks = await Promise.all(candidates.map((u) => filter(u)));
      recipients = candidates.filter((_, i) => checks[i]);
    }

    // One grouped row per surviving author. deliverToRecipients enqueues NO email (low-signal).
    return await deliverToRecipients(refId, recipients, type, deps);
  } catch (err) {
    log("notifyOnDetached failed (best-effort, orphan-marking already persisted)", err);
    return empty;
  }
}

export interface NotifyOnInvitedInput {
  /**
   * The deep-link ref for the in-app row — the doc (or workspace) the invitee was added to. The
   * `invited` row points at the resource the invite grants access to, not at any annotation.
   */
  refId: string;
  /**
   * The invitee's account user id, or null when the invite has NO resolvable account (a PENDING
   * invite to an email with no account yet). A null invitee writes NOTHING — there is no account to
   * attach an in-app row to; the transactional invite EMAIL (a separate pre-existing channel) is the
   * only thing a pending invitee receives. This is the crux of S-005's nuance.
   */
  inviteeUserId: string | null;
}

/**
 * S-005 — notify the INVITEE on being added to a doc/workspace: ONE in-app row to the bound
 * invitee account (AS-010). IN-APP ONLY — `invited` is LOW-SIGNAL (C-006), so NO email is ever
 * enqueued by the notify path (the transactional invite email is a SEPARATE pre-existing channel —
 * this never sends or removes it). Invite ACCEPTANCE raises NO notification (GAP-006: the
 * `invite_accepted` type does not exist).
 *
 * The recipient is the single invitee userId resolved SERVER-side at invite time (C-001). A null
 * invitee (a PENDING invite to an account-less email) yields an empty recipient set → no row — the
 * in-app channel needs an account to attach to. At most one recipient, so dedup (C-005) is a no-op,
 * but it routes through the same deliverToRecipients stage as the other events.
 *
 * BEST-EFFORT / POST-COMMIT (C-007): runs AFTER the doc_members row persists; the whole pass is
 * wrapped so a throwing repo is logged and swallowed — the invite is never turned into a 500 because
 * notify failed.
 */
export async function notifyOnInvited(
  input: NotifyOnInvitedInput,
  deps: NotifyDeps,
): Promise<NotifyResult> {
  const { refId, inviteeUserId } = input;
  // C-006: forced LOW-SIGNAL — `invited` is in-app only regardless of any deps.type override.
  const type: NotificationType = "invited";
  const log = deps.logError ?? ((msg, err) => console.error(msg, err));
  const empty: NotifyResult = { recipients: [], inAppSent: 0, emailsSent: 0 };

  try {
    // null invitee (pending, no account) → no recipient (no in-app row to attach).
    const recipients = inviteeUserId != null ? [inviteeUserId] : [];
    return await deliverToRecipients(refId, recipients, type, deps);
  } catch (err) {
    log("notifyOnInvited failed (best-effort, invite already persisted)", err);
    return empty;
  }
}

export interface NotifyOnWorkspaceInvitedInput {
  /** The workspace the invite targets — persisted as the in-app row's refId (Data Model). */
  workspaceId: string;
  /** The invited email; resolved to an account user id (null → no in-app row). */
  inviteeEmail: string;
  /** The workspace's CURRENT name — snapshotted into refLabel at emit (F1), sanitized (C-006). */
  workspaceName: string;
  /** The inviting admin — never a recipient of their own invite (C-002). */
  actorUserId: string | null;
}

/**
 * workspace-notifications S-001 — notify an INVITED MEMBER in the bell. Emits ONE in-app
 * `workspace_invited` row to the invited ACCOUNT, but ONLY when an account exists for the email
 * (AS-001); a no-account email writes NOTHING (AS-002 — the existing invite email is the only
 * thing they get). IN-APP ONLY (C-001) — `workspace_invited` is low-signal, so the notify path
 * enqueues NO email; the workspace invite email is the invite flow's own (separate) channel and is
 * never duplicated or removed here. The inviting admin is excluded even if they invite their own
 * address (C-002, AS-003). refId = workspaceId; refLabel = the sanitized workspace name snapshot
 * (F1) so the bell renders without a live `workspaces` join.
 *
 * BEST-EFFORT / POST-COMMIT (C-004): runs AFTER the invitation persists; the whole pass is wrapped
 * so a throwing repo is logged and swallowed — the invite is never turned into a 500 by notify.
 */
export async function notifyOnWorkspaceInvited(
  input: NotifyOnWorkspaceInvitedInput,
  deps: NotifyDeps,
): Promise<NotifyResult> {
  const { workspaceId, inviteeEmail, workspaceName, actorUserId } = input;
  const type: NotificationType = "workspace_invited"; // C-001: in-app only (low-signal).
  const log = deps.logError ?? ((msg, err) => console.error(msg, err));
  const empty: NotifyResult = { recipients: [], inAppSent: 0, emailsSent: 0 };

  try {
    // Resolve the invitee's account by email. No account → no in-app row to attach (AS-002).
    const inviteeUserId = deps.repo.findUserIdByEmail
      ? await deps.repo.findUserIdByEmail(inviteeEmail)
      : null;
    // C-002 (AS-003): the inviting admin is never a recipient — even self-invite resolves to []
    const recipients =
      inviteeUserId != null && inviteeUserId !== actorUserId ? [inviteeUserId] : [];
    // F1/C-006: snapshot the sanitized workspace name so the row is inert + survives a rename/delete.
    const refLabel = sanitizeRefLabel(workspaceName);
    return await deliverToRecipients(workspaceId, recipients, type, deps, null, refLabel);
  } catch (err) {
    log("notifyOnWorkspaceInvited failed (best-effort, invite already persisted)", err);
    return empty;
  }
}

export interface NotifyOnWorkspaceMemberJoinedInput {
  /** The workspace the member joined — persisted as each in-app row's refId (Data Model). */
  workspaceId: string;
  /** The joining member's account id — the ACTOR, excluded from the recipient set (C-002). */
  joinerUserId: string;
  /** The workspace's CURRENT name — snapshotted into refLabel at emit (F1), sanitized (C-006). */
  workspaceName: string;
  /**
   * The joiner's DISPLAY NAME snapshot (NEVER their email — F-security). Carried for the bell's
   * "<joiner> joined <ws>" copy; sanitized defensively (C-006). The refLabel itself snapshots the
   * workspace name (the cleanest inert label), with the joiner name available to the read side.
   */
  joinerName: string;
  /** The acting joiner (== joinerUserId) — never a recipient of their own join (C-002, AS-004). */
  actorUserId: string | null;
}

/**
 * workspace-notifications S-002 — notify EVERY ADMIN when a member joins (accepts an invite): ONE
 * in-app `workspace_member_joined` row per admin, MINUS the joining member (C-002, AS-004). The
 * joiner — even though a fresh joiner is now a `member` and could be an admin if they joined as one
 * — is excluded by construction. IN-APP ONLY by default (GAP-001): `workspace_member_joined` is NOT
 * in HIGH_SIGNAL_TYPES, so the notify path enqueues NO email (admins opt in later via
 * notification-preferences). refId = workspaceId; refLabel = the SANITIZED workspace name snapshot
 * (F1 — rendered without a live `workspaces` join; survives a later rename/delete).
 *
 * FAN-OUT (C-005): the admin set fans out to EXACTLY one row per admin, BATCH-inserted in ONE
 * round-trip via deliverBatch → repo.insertNotifications([...]), never a serial per-admin awaited
 * insert. The accept route fires this WITHOUT awaiting on the request critical path (fire-and-forget).
 *
 * BEST-EFFORT / POST-COMMIT (C-004): runs AFTER the membership commit; the whole pass is wrapped so a
 * throwing repo is logged and swallowed — the join (Bob is in) is never rolled back by a notify
 * failure. GAP-003 (open): notifications carry no idempotency key, so a double-accept could duplicate
 * rows; v0 accepts rare duplicates (best-effort) — no uniqueness mechanism is built here.
 */
export async function notifyOnWorkspaceMemberJoined(
  input: NotifyOnWorkspaceMemberJoinedInput,
  deps: NotifyDeps,
): Promise<NotifyResult> {
  const { workspaceId, joinerUserId, workspaceName, actorUserId } = input;
  const type: NotificationType = "workspace_member_joined"; // in-app only (GAP-001, not high-signal).
  const log = deps.logError ?? ((msg, err) => console.error(msg, err));
  const empty: NotifyResult = { recipients: [], inAppSent: 0, emailsSent: 0 };

  try {
    // Recipients = ALL admins − the joining member (C-002). The actor is the joiner; exclude both the
    // declared actor and the joiner id (defensively identical) so a fresh admin-joiner never self-notifies.
    const adminIds = deps.repo.listWorkspaceAdminIds
      ? await deps.repo.listWorkspaceAdminIds(workspaceId)
      : [];
    const excluded = new Set<string>([joinerUserId]);
    if (actorUserId != null) excluded.add(actorUserId);
    const recipients = [...new Set(adminIds)].filter((id) => !excluded.has(id));

    // F1/C-006: snapshot the sanitized workspace name → inert refLabel (no raw CR/LF / control chars).
    const refLabel = sanitizeRefLabel(workspaceName);
    // C-005: fan out via the BATCH path (one round-trip), in-app only (no email — GAP-001).
    return await deliverBatch(workspaceId, recipients, type, deps, refLabel);
  } catch (err) {
    log("notifyOnWorkspaceMemberJoined failed (best-effort, join already persisted)", err);
    return empty;
  }
}

export interface NotifyOnWorkspaceMemberRemovedInput {
  /** The workspace the user was removed from — persisted as the in-app row's refId (Data Model). */
  workspaceId: string;
  /**
   * The removed user's account id — THE recipient by construction (F1/C-003/AS-006). It is
   * snapshotted by the caller BEFORE the membership delete; this dispatch never re-checks "is
   * this user still a member" (they are not), so the just-removed user is never dropped.
   */
  removedUserId: string;
  /**
   * The workspace's name snapshotted BEFORE the delete (F1) — post-delete it may be unreadable via
   * membership joins, and a live read could leak a since-changed name. Sanitized (C-006) before it
   * reaches refLabel AND the email subject/body.
   */
  workspaceName: string;
  /**
   * The removed user's email snapshotted BEFORE the delete (F1), or null when absent. Passed for
   * documentation/parity; the email channel resolves the address via the repo (getUserEmail reads
   * the durable `user` row, which survives the membership delete) — a null here just signals the
   * caller couldn't find one (then no email channel, only the in-app row).
   */
  recipientEmail: string | null;
  /** The removing admin — never a recipient of their own action (C-002, AS-005). */
  actorUserId: string | null;
}

/**
 * workspace-notifications S-003 — notify a REMOVED MEMBER. Emits ONE in-app
 * `workspace_member_removed` row AND ONE email to the removed user: this is the ONLY workspace
 * type that emails (high-signal, a CRITICAL always-on notice — mirrors `detached`). The recipient
 * is the removed user BY CONSTRUCTION (F1/C-003/AS-006) — the caller snapshots { removedUserId,
 * workspaceName, recipientEmail } BEFORE the membership delete and passes them here, so the
 * membership-based recipient resolution never drops the just-removed user (no "is Bob still a
 * member" re-check). The removing admin is excluded even if they somehow target their own id
 * (C-002, AS-005). refId = workspaceId; refLabel = the SANITIZED workspace name (C-006), and the
 * SAME sanitized name is what the email body interpolates — no raw CR/LF reaches the subject/body
 * (AS-009). The email deep-link is WORKSPACE-shaped (`/w/{id}`), never annotation-shaped (GAP-002:
 * the click-landing on a no-longer-accessible workspace stays deferred — a workspace link is fine).
 *
 * BEST-EFFORT / POST-COMMIT (C-004/AS-008): runs AFTER the removal commits; the whole pass is
 * wrapped so a throwing repo/mail is logged and swallowed — the removal (Bob is gone) is never
 * rolled back by a notify failure.
 */
export async function notifyOnWorkspaceMemberRemoved(
  input: NotifyOnWorkspaceMemberRemovedInput,
  deps: NotifyDeps,
): Promise<NotifyResult> {
  const { workspaceId, removedUserId, workspaceName, actorUserId } = input;
  const type: NotificationType = "workspace_member_removed"; // high-signal: in-app + email.
  const log = deps.logError ?? ((msg, err) => console.error(msg, err));
  const empty: NotifyResult = { recipients: [], inAppSent: 0, emailsSent: 0 };

  try {
    // C-003/AS-006: the removed user IS the recipient — resolved from the snapshot, NOT a live
    // membership read. C-002 (AS-005): exclude the removing admin (a self-targeted removal yields []).
    const recipients = removedUserId !== actorUserId ? [removedUserId] : [];
    // F1/C-006: sanitize the snapshotted name → strips CR/LF + control chars + bounds length, BEFORE
    // it becomes refLabel (inert in-app row) AND before it is interpolated into the email body.
    const refLabel = sanitizeRefLabel(workspaceName);
    // F3/GAP-002: the email link is WORKSPACE-shaped — build it here and pass it as the override so
    // deliverToRecipients does not compute a (meaningless) annotation link from a missing doc slug.
    const emailDeepLink = deps.appUrl
      ? buildWorkspaceDeepLink(deps.appUrl, workspaceId)
      : undefined;
    return await deliverToRecipients(
      workspaceId,
      recipients,
      type,
      deps,
      null,
      refLabel,
      emailDeepLink,
    );
  } catch (err) {
    log("notifyOnWorkspaceMemberRemoved failed (best-effort, removal already persisted)", err);
    return empty;
  }
}

export interface NotifyOnWorkspaceRenamedInput {
  /** The renamed workspace — persisted as each in-app row's refId (Data Model). */
  workspaceId: string;
  /**
   * The workspace's name BEFORE the rename — captured by the caller via getWorkspaceName at/just
   * before rename time. User-controlled → sanitized (C-006) into the "<old> → <new>" refLabel.
   */
  oldName: string;
  /**
   * The workspace's name AFTER the rename (the new name the admin submitted). Also user-controlled
   * → sanitized (C-006) into the "<old> → <new>" refLabel.
   */
  newName: string;
  /** The renaming admin — never a recipient of their own rename (C-002, AS-007). */
  actorUserId: string | null;
}

/**
 * workspace-notifications S-004 — notify EVERY MEMBER when an admin renames the workspace: ONE
 * in-app `workspace_renamed` row per member, MINUS the renamer (C-002, AS-007). Members are ALL
 * workspace members (admins included — admins are members too), so the renamer is excluded by
 * construction. IN-APP ONLY: `workspace_renamed` is NOT in HIGH_SIGNAL_TYPES, so the notify path
 * enqueues NO email (AS-007.T3). refId = workspaceId; refLabel = the sanitized "<old> → <new>"
 * display text (F1 — rendered without a live `workspaces` join; survives a later rename/delete).
 * BOTH names are user-controlled, so each is run through sanitizeRefLabel (C-006) before they are
 * composed — no CR/LF / control char survives into the inert in-app row.
 *
 * FAN-OUT (C-005): the member set fans out to EXACTLY one row per member, BATCH-inserted in ONE
 * round-trip via deliverBatch → repo.insertNotifications([...]), never a serial per-member awaited
 * insert. The rename route fires this WITHOUT awaiting on the request critical path (fire-and-forget)
 * so a 500-member rename never holds the HTTP response.
 *
 * BEST-EFFORT / POST-COMMIT (C-004): runs AFTER the rename commits; the whole pass is wrapped so a
 * throwing repo is logged and swallowed — the rename is never rolled back / never 500s by a notify
 * failure. GAP-003 (open): notifications carry no idempotency key, so a retried rename could
 * duplicate rows; v0 accepts rare duplicates (best-effort) — no uniqueness mechanism is built here.
 */
export async function notifyOnWorkspaceRenamed(
  input: NotifyOnWorkspaceRenamedInput,
  deps: NotifyDeps,
): Promise<NotifyResult> {
  const { workspaceId, oldName, newName, actorUserId } = input;
  const type: NotificationType = "workspace_renamed"; // in-app only (not high-signal).
  const log = deps.logError ?? ((msg, err) => console.error(msg, err));
  const empty: NotifyResult = { recipients: [], inAppSent: 0, emailsSent: 0 };

  try {
    // Recipients = ALL members − the renamer (C-002). listWorkspaceMemberIds returns every member
    // (admins included); exclude the actor so the renamer never self-notifies.
    const memberIds = deps.repo.listWorkspaceMemberIds
      ? await deps.repo.listWorkspaceMemberIds(workspaceId)
      : [];
    const recipients =
      actorUserId != null
        ? [...new Set(memberIds)].filter((id) => id !== actorUserId)
        : [...new Set(memberIds)];

    // F1/C-006: sanitize EACH user-controlled name (defensive against a null too) BEFORE composing
    // the "<old> → <new>" label → strips CR/LF + control chars + bounds length; the row stays inert.
    const refLabel = `${sanitizeRefLabel(oldName ?? "")} → ${sanitizeRefLabel(newName ?? "")}`;
    // C-005: fan out via the BATCH path (one round-trip), in-app only (no email).
    return await deliverBatch(workspaceId, recipients, type, deps, refLabel);
  } catch (err) {
    log("notifyOnWorkspaceRenamed failed (best-effort, rename already persisted)", err);
    return empty;
  }
}

/**
 * Shared per-recipient channel send (C-005/C-006/C-012/C-013): for each recipient write ONE
 * in-app row (always — the durable channel) and, for a high-signal type only, enqueue ONE
 * email carrying the absolute deep-link. The recipient list is already deduped + filtered by
 * the caller; this stage owns only the two channels. Throws propagate to the caller's
 * best-effort try/catch.
 */
async function deliverToRecipients(
  annotationId: string,
  recipients: string[],
  type: NotificationType,
  deps: NotifyDeps,
  // S-006: the triggering comment id for a comment-type row (AS-027/AS-028). Absent for the
  // non-comment events (resolved/decided/detached/invited) → persisted NULL (C-014 degrade).
  commentId?: string | null,
  // workspace-notifications S-001 (F1): the snapshotted display label for a workspace row (e.g. the
  // workspace name). Undefined for annotation/doc rows — only spread into the insert when present so
  // existing exact-equality assertions on those rows stay valid.
  refLabel?: string | null,
  // workspace-notifications S-003 (F3): an absolute email deep-link the CALLER already built (the
  // WORKSPACE-shaped `/w/{id}` link for member-removed). When supplied it OVERRIDES the
  // annotation-shaped link this stage would otherwise compute from the doc slug — a workspace event
  // has no slug, and its link must point at the workspace, never an annotation fragment.
  emailDeepLinkOverride?: string,
): Promise<NotifyResult> {
  // C-006: email default eligibility is the MATRIX default for this type. A low-signal event
  // (resolved/detached) has no email channel → false → no mail to anyone. This is the base; the
  // per-recipient prefs decision below only ever NARROWS it (never widens), and the master switch
  // folds into each recipient's `email` decision (C-001).
  const emailEligible = isEmailEligible(type);

  // C-006: read ALL recipients' effective channel decisions in ONE batched call (no N+1). On a
  // prefs-read failure this returns a fail-safe (email closed, in-app open) decision function.
  const decisionFor = await resolvePreferenceDecisions(recipients, type, deps);

  // C-013: resolve the doc slug once (per event) to build the per-recipient deep-link. Skipped when
  // the caller supplied an explicit deep-link override (workspace events carry no doc slug).
  const slug =
    emailEligible && emailDeepLinkOverride === undefined && deps.repo.getDocSlug
      ? await deps.repo.getDocSlug(annotationId)
      : null;

  let inAppSent = 0;
  let emailsSent = 0;
  for (const userId of recipients) {
    const decision = decisionFor(userId);
    // C-002: a critical type forces the in-app row regardless of the stored/failed decision; for
    // every other type the recipient's in-app preference applies (default on per the matrix).
    const deliverInApp = ALWAYS_DELIVER_IN_APP.has(type) || decision.inApp;

    // Channel 1 — in-app: the durable channel. Carries the triggering comment id for comment-type
    // rows (S-006) — null otherwise. Suppressed only by a non-critical recipient in-app opt-out.
    if (deliverInApp) {
      await deps.repo.insertNotification({
        userId,
        type,
        refId: annotationId,
        commentId: commentId ?? null,
        // Only carry refLabel when the caller supplied one (workspace rows) — annotation/doc rows
        // leave it undefined so their existing exact-shape assertions are unaffected.
        ...(refLabel !== undefined ? { refLabel } : {}),
      });
      inAppSent += 1;
    }

    // Channel 2 — email: matrix-eligible AND the recipient's email decision is on (C-001/C-006).
    // The decision already folds in their per-event override + master switch; a fail-closed read
    // leaves it false. Guard a missing email (account-holders should always have one, never crash).
    if (!emailEligible || !decision.email) continue;
    const email = await deps.repo.getUserEmail(userId);
    if (email != null && email.length > 0) {
      // C-013 / C-012: plain-text body carrying the absolute deep-link (no doc body embedded). A
      // caller-supplied override (the workspace-shaped link) wins; otherwise build the
      // annotation-shaped link from the doc slug.
      const deepLink =
        emailDeepLinkOverride ??
        (deps.appUrl && slug ? buildAnnotationDeepLink(deps.appUrl, slug, annotationId) : null);
      const text = deepLink
        ? buildEmailBody(type, deepLink)
        : EVENT_SUMMARY[type] ?? "You have a new notification on anchord.";
      deps.mail.enqueue({ to: email, subject: emailSubjectFor(type), text });
      emailsSent += 1;
    }
  }
  return { recipients, inAppSent, emailsSent };
}

/**
 * workspace-notifications S-002 (C-005) — the multi-recipient FAN-OUT channel: write ONE in-app row
 * per recipient in a SINGLE batch round-trip (repo.insertNotifications([...])), not a serial awaited
 * insert per recipient. IN-APP ONLY — the fan-out events that route here (join → admins; S-004 rename
 * → members) are low-signal, so NO email is enqueued. An empty recipient set writes NOTHING (no empty
 * batch insert). Falls back to per-row insertNotification when the bulk port is absent (keeps older
 * fakes valid), still in-app only. The recipient list is already deduped + actor-excluded by the
 * caller; throws propagate to the caller's best-effort try/catch.
 */
async function deliverBatch(
  refId: string,
  recipients: string[],
  type: NotificationType,
  deps: NotifyDeps,
  refLabel?: string | null,
): Promise<NotifyResult> {
  if (recipients.length === 0) return { recipients: [], inAppSent: 0, emailsSent: 0 };

  // C-006/C-002: batched per-recipient in-app decision. The fan-out events here are in-app only,
  // so the email half is irrelevant; the always-deliver set forces critical types on regardless.
  const decisionFor = await resolvePreferenceDecisions(recipients, type, deps);
  const deliverTo = recipients.filter(
    (userId) => ALWAYS_DELIVER_IN_APP.has(type) || decisionFor(userId).inApp,
  );
  if (deliverTo.length === 0) return { recipients: [], inAppSent: 0, emailsSent: 0 };

  const rows: NewNotification[] = deliverTo.map((userId) => ({
    userId,
    type,
    refId,
    commentId: null,
    ...(refLabel !== undefined ? { refLabel } : {}),
  }));

  if (deps.repo.insertNotifications) {
    // One round-trip for the whole admin/member set (C-005 — not N serial inserts).
    await deps.repo.insertNotifications(rows);
  } else {
    // Back-compat fallback (bulk port absent): per-row insert, still in-app only.
    for (const row of rows) await deps.repo.insertNotification(row);
  }
  // In-app only (low-signal fan-out) → zero emails. `recipients` reflects who actually got a row
  // (after per-recipient in-app opt-out narrowing).
  return { recipients: deliverTo, inAppSent: rows.length, emailsSent: 0 };
}
