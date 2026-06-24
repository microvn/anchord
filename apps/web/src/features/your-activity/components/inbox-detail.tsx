import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Icon } from "@/components/icon";
import { initials, avatarColor } from "@/lib/initials";
import {
  headlineParts,
  iconFor,
  relativeTime,
  deepLinkFor,
} from "@/features/notifications/lib/format";
import type { NotificationItem, NotificationType } from "@/features/notifications/types";
import {
  useReplyToThread,
  useResolveThread,
  useAcceptInvite,
  useDeclineInvite,
} from "@/features/your-activity/hooks/use-inbox-actions";

// S-004: the comment-type rows whose detail offers a reply composer + resolve. A reply-eligible item
// is one of these AND carries a non-null `slug` (the doc the thread lives in). A `workspace_invited`
// row (or any no-slug / non-comment row) gets no composer.
const REPLY_TYPES: ReadonlySet<NotificationType> = new Set<NotificationType>([
  "reply",
  "thread_activity",
  "new_feedback",
]);

// your-activity-inbox S-003 — an inbox item's DETAIL (Anchord-Design `PersonalDetail`): a back link,
// a hero (type node-icon + actor avatar + headline sentence + a type badge + time), then a card with
// the snippet/body and a key/value grid (From / Workspace / Document / When), and — for doc-backed
// items with a resolvable slug — an "Open in doc" control that deep-links to the source thread.
//
// C-008 (mark-on-detail-open): opening the DETAIL is the deliberate engagement gesture, so it marks
// the item read — distinct from the bell's C-009 (opening the dropdown panel does NOT mark read).
// The mark fires once on mount via the EXISTING `markNotificationRead` mutation (passed in as
// `onMarkRead` from the page), guarded so a re-render / already-read row never re-marks (AS-006).
//
// C-003: the "Open in doc" control only NAVIGATES (a deep-link the viewer route then authorizes); it
// never bypasses any auth. It is shown ONLY when `deepLinkFor(item)` resolves — i.e. a doc-backed
// item with a slug — so a `workspace_invited` row (no slug → null) and a deleted-doc row (null slug)
// show no "Open in doc" (AS-012). Reply composer (S-004) + accept/decline (S-005) land later.
//
// The data shape is the REAL `NotificationItem` (richer in the prototype than in production): we map
// only fields that EXIST — actor=`actorName`, workspace=`workspaceName`, document=`docTitle`, when=
// `relativeTime(createdAt)` + absolute date, body/preview=`snippet`. Every field renders null-safe.

export function InboxDetail({
  item,
  onBack,
  onMarkRead,
}: {
  item: NotificationItem;
  /** Return to the list (mirrors the prototype's `setSel(null)`). */
  onBack?: () => void;
  /** S-002 mark-read mutation, reused for C-008 — opening the detail marks the item read once. */
  onMarkRead?: (id: string) => void;
}) {
  // AS-006 / C-008: mark read once when the detail opens for an UNREAD item. Keyed on the item id so
  // navigating list → detail → another detail re-fires for the new id, but a re-render of the same
  // open detail does not (and an already-read item is never re-marked).
  const wasUnread = !item.read;
  useEffect(() => {
    if (wasUnread) onMarkRead?.(item.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const head = headlineParts(item);
  const actor = item.actorName ?? null;
  const workspace = item.workspaceName ?? null;
  const doc = item.docTitle ?? null;
  const deepLink = deepLinkFor(item);

  // S-004 (C-003): reply/resolve are offered for a comment-type item with a resolvable slug. The
  // backend re-authorizes every write — there is NO client-side role gate here (a refusal surfaces).
  const replyEligible = item.slug != null && REPLY_TYPES.has(item.type);
  const reply = useReplyToThread();
  const resolve = useResolveThread();
  const [draft, setDraft] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);

  const submitReply = () => {
    const body = draft.trim();
    if (!body || !item.slug) return;
    setRefusal(null);
    reply.mutate(
      { slug: item.slug, annotationId: item.refId, body },
      {
        onSuccess: () => {
          // AS-013: clear the composer and ensure the item is read (idempotent — the detail already
          // marks read on open via C-008).
          setDraft("");
          onMarkRead?.(item.id);
        },
        // AS-015 / C-003: a server refusal (viewer role / revoked) surfaces a visible message; the
        // failed reply does NOT mark the item read.
        onError: () => setRefusal("You can't reply on this thread."),
      },
    );
  };

  const submitResolve = () => {
    if (!item.slug || resolved) return;
    resolve.mutate(
      { slug: item.slug, annotationId: item.refId },
      {
        // AS-014: reflect the resolved state (disable the control) + a confirmation.
        onSuccess: () => {
          setResolved(true);
          toast("Thread resolved");
        },
        onError: () => toast.error("Couldn't resolve this thread"),
      },
    );
  };

  // S-005 (C-007 / AS-016/017/019): a `workspace_invited` item offers Accept / Decline ONLY — no
  // reply composer, no "Open in doc". The action is TOKENLESS (the hooks pass only `item.invitationId`,
  // never a token; the route authorizes by the session-email match). On success the row is marked read
  // and we return to the list (it clears on the next fetch). On a server refusal — the invite was
  // revoked / already settled since it landed — we surface "no longer available" and clear the row,
  // never a dead error (AS-019). `invitationId` is the dedicated field; `refId` stays the workspace id.
  const isInvite = item.type === "workspace_invited";
  const accept = useAcceptInvite();
  const decline = useDeclineInvite();
  const [inviteGone, setInviteGone] = useState(false);
  const inviteId = item.invitationId ?? null;
  const invitePending = accept.isPending || decline.isPending;

  const settleInvite = () => {
    // Mark read + return to the list; the list re-fetch drops the now-settled invite.
    onMarkRead?.(item.id);
    onBack?.();
  };
  const onInviteError = () => {
    // AS-019: degrade gracefully — never a dead error. Clear the (no-longer-actionable) row.
    setInviteGone(true);
    toast.error("This invitation is no longer available.");
    onMarkRead?.(item.id);
  };

  const submitAccept = () => {
    if (!inviteId || invitePending || inviteGone) return;
    accept.mutate(
      { invitationId: inviteId },
      {
        onSuccess: () => {
          toast(workspace ? `Joined ${workspace}` : "Joined the workspace");
          settleInvite();
        },
        onError: onInviteError,
      },
    );
  };
  const submitDecline = () => {
    if (!inviteId || invitePending || inviteGone) return;
    decline.mutate(
      { invitationId: inviteId },
      {
        onSuccess: () => {
          toast("Invite declined");
          settleInvite();
        },
        onError: onInviteError,
      },
    );
  };

  const kv: Array<{ label: string; node: React.ReactNode; value: string }> = [];
  if (actor) {
    kv.push({
      label: "From",
      node: (
        <span
          aria-hidden="true"
          className="inline-flex size-[18px] items-center justify-center rounded-full font-mono text-[8px] font-semibold text-white"
          style={{ background: avatarColor(actor) }}
        >
          {initials(actor)}
        </span>
      ),
      value: actor,
    });
  }
  if (workspace) {
    kv.push({
      label: "Workspace",
      node: <Icon name="dashboard" size={13} />,
      value: workspace,
    });
  }
  if (doc) {
    kv.push({ label: "Document", node: <Icon name="docs" size={13} />, value: doc });
  }
  kv.push({
    label: "When",
    node: <Icon name="clock" size={13} />,
    value: relativeTime(item.createdAt),
  });

  return (
    <div data-testid="inbox-detail" className="mx-auto max-w-[720px]">
      <button
        type="button"
        data-testid="inbox-detail-back"
        onClick={onBack}
        className="mb-[18px] inline-flex items-center gap-1.5 text-sm font-medium text-muted transition-colors hover:text-ink"
      >
        <Icon name="chevLeft" size={15} />
        Back
      </button>

      {/* Hero: the type node-icon + actor avatar, the headline sentence, a type badge + time. */}
      <div className="mb-[18px] flex items-start gap-3.5">
        <span className="relative grid size-[42px] flex-none place-items-center rounded-full bg-accent-soft text-accent-ink">
          <Icon name={iconFor(item.type)} size={19} />
          {actor && (
            <span
              aria-hidden="true"
              className="absolute -bottom-[3px] -right-[3px] inline-flex size-[18px] items-center justify-center rounded-full border-2 border-surface font-mono text-[8px] font-semibold text-white"
              style={{ background: avatarColor(actor) }}
            >
              {initials(actor)}
            </span>
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-serif text-[20px] font-medium leading-[1.25] tracking-[-0.01em] text-ink">
            {head.actor && <b className="font-semibold">{head.actor}</b>}
            {head.actor ? " " : ""}
            <span>{head.verb}</span>
            {head.title && (
              <>
                <span>{head.titleSeparator}</span>
                <span className="text-accent-ink">{head.title}</span>
              </>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted">
            <span className="font-mono text-[10.5px] text-subtle">
              {relativeTime(item.createdAt)}
            </span>
          </div>
        </div>
      </div>

      {/* Card: snippet (quote-ref) + body + the key/value grid. */}
      <div className="rounded-lg border border-line bg-surface px-5 py-[18px]">
        {item.snippet && (
          <div
            data-testid="inbox-detail-snippet"
            className="mb-3 border-l-2 border-accent py-[3px] pl-3 text-[13px] italic leading-relaxed text-muted"
          >
            “{item.snippet}”
          </div>
        )}

        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 border-t border-line pt-3.5">
          {kv.map((rowItem) => (
            <div key={rowItem.label} className="contents">
              <span className="self-center font-mono text-[10.5px] uppercase tracking-[0.05em] text-subtle">
                {rowItem.label}
              </span>
              <span className="flex flex-wrap items-center gap-1.5 text-sm text-ink">
                {rowItem.node}
                {rowItem.value}
              </span>
            </div>
          ))}
        </div>

        {/* AS-012 / C-003: "Open in doc" — shown for a doc-backed item with a resolvable slug
            (deepLinkFor returns null for workspace_invited + deleted-doc rows). It only navigates.
            For a reply-eligible item the link moves INTO the composer foot (below), so this
            standalone control is suppressed to avoid a duplicate. */}
        {deepLink && !replyEligible && (
          <div className="mt-4 flex">
            <Link
              to={deepLink}
              data-testid="inbox-detail-open-doc"
              className="inline-flex items-center gap-1.5 rounded-md border border-line bg-elev px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-accent-soft hover:text-accent-ink"
            >
              <Icon name="arrowRight" size={14} />
              Open in doc
            </Link>
          </div>
        )}

        {/* S-005 — invite Accept/Decline (prototype `.me-actions-row`). ONLY for a workspace_invited
            item; tokenless (targets item.invitationId via the existing invitation routes, C-003/C-007). */}
        {isInvite && (
          <div data-testid="inbox-detail-invite-actions" className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
            {inviteGone ? (
              // AS-019: graceful degrade — the invite is no longer actionable.
              <p data-testid="inbox-invite-gone" role="alert" className="text-[13px] text-muted">
                This invitation is no longer available.
              </p>
            ) : (
              <>
                <button
                  type="button"
                  data-testid="inbox-invite-accept"
                  onClick={submitAccept}
                  disabled={invitePending || !inviteId}
                  className="inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent px-3 py-1.5 text-sm font-medium text-on-accent transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Icon name="check" size={15} />
                  Accept invite
                </button>
                <button
                  type="button"
                  data-testid="inbox-invite-decline"
                  onClick={submitDecline}
                  disabled={invitePending || !inviteId}
                  className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-elev hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Decline
                </button>
              </>
            )}
          </div>
        )}

        {/* S-004 — reply composer + resolve (prototype `.me-reply`). Reply/resolve go through the
            existing annotation routes (C-003); the backend authorizes — no client-side role gate. */}
        {replyEligible && (
          <div data-testid="inbox-detail-reply" className="mt-4 border-t border-line pt-4">
            <label
              htmlFor="inbox-reply"
              className="mb-1.5 block font-mono text-[10.5px] uppercase tracking-[0.05em] text-subtle"
            >
              Reply
            </label>
            <textarea
              id="inbox-reply"
              data-testid="inbox-reply-input"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                if (refusal) setRefusal(null);
              }}
              placeholder={actor ? `Reply to ${actor}…` : "Write a reply…"}
              rows={3}
              className="w-full resize-y rounded-md border border-line bg-elev px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-subtle focus:border-accent"
            />

            {/* AS-015: a visible refusal when the backend's comment gate refuses (not swallowed). */}
            {refusal && (
              <p
                data-testid="inbox-reply-error"
                role="alert"
                className="mt-1.5 text-[13px] text-error"
              >
                {refusal}
              </p>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="inbox-reply-resolve"
                onClick={submitResolve}
                disabled={resolved || resolve.isPending}
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-elev hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Icon name="check" size={15} />
                {resolved ? "Resolved" : "Resolve"}
              </button>
              {deepLink && (
                <Link
                  to={deepLink}
                  data-testid="inbox-detail-open-doc"
                  className="inline-flex items-center gap-1.5 rounded-md border border-line bg-elev px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-accent-soft hover:text-accent-ink"
                >
                  Open in doc
                </Link>
              )}
              <button
                type="button"
                data-testid="inbox-reply-submit"
                onClick={submitReply}
                disabled={!draft.trim() || reply.isPending}
                className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent px-3 py-1.5 text-sm font-medium text-on-accent transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Icon name="arrowRight" size={14} />
                Reply
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
