import { useEffect } from "react";
import { Link } from "react-router-dom";
import { Icon } from "@/components/icon";
import { initials, avatarColor } from "@/lib/initials";
import {
  headlineParts,
  iconFor,
  relativeTime,
  deepLinkFor,
} from "@/features/notifications/lib/format";
import type { NotificationItem } from "@/features/notifications/types";

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

        {/* AS-012 / C-003: "Open in doc" — shown ONLY for a doc-backed item with a resolvable slug
            (deepLinkFor returns null for workspace_invited + deleted-doc rows). It only navigates. */}
        {deepLink && (
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
      </div>
    </div>
  );
}
