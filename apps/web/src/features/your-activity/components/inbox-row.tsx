import { Icon } from "@/components/icon";
import { initials, avatarColor } from "@/lib/initials";
import { headlineParts, relativeTime } from "@/features/notifications/lib/format";
import { inboxIconFor, inboxNodeToneFor, NODE_TONE_CLASS } from "@/features/your-activity/lib/node-style";
import type { NotificationItem } from "@/features/notifications/types";

// your-activity-inbox S-001 — one inbox row (Anchord-Design `.me-row`): a type node-icon + actor
// avatar, the headline sentence, a workspace chip + doc chip, the relative time, and an unread dot.
// Opens the detail on click (the detail itself lands in S-003). Reuses the bell's pure formatters
// (headlineParts/iconFor/relativeTime) so the inbox reads consistently with the bell.

export function InboxRow({
  item,
  onOpen,
  onMarkRead,
}: {
  item: NotificationItem;
  onOpen?: (item: NotificationItem) => void;
  /** S-002: mark THIS row read without opening it. Rendered only while the row is unread. */
  onMarkRead?: (item: NotificationItem) => void;
}) {
  const unread = !item.read;
  const head = headlineParts(item);
  const actor = item.actorName ?? null;
  // The node circle is TONED BY TYPE (Anchord-Design `.me-node.*`), consistent with the Your-actions
  // node — invite/workspace_invited amber, resolved green, detached amber, comment-types accent, the
  // rest muted — not a single hardcoded teal.
  const nodeTone = NODE_TONE_CLASS[inboxNodeToneFor(item.type)];

  return (
    <div className="group relative border-b border-line last:border-b-0">
    <button
      type="button"
      data-testid={`inbox-row-${item.id}`}
      data-unread={unread || undefined}
      onClick={() => onOpen?.(item)}
      className="grid w-full grid-cols-[8px_34px_1fr] items-start gap-3 py-[13px] pl-[7px] pr-[15px] text-left transition-colors hover:bg-elev data-[unread]:bg-accent-soft/30"
    >
      {/* Unread dot (col 1) — teal when unread, transparent otherwise. */}
      <span
        aria-hidden="true"
        className={
          "mt-1.5 size-[7px] justify-self-center rounded-full " +
          (unread ? "bg-accent" : "bg-transparent")
        }
      />

      {/* Type node-icon + actor avatar (col 2) — toned by notification type. */}
      <span className={`relative grid size-[34px] place-items-center rounded-full ${nodeTone}`}>
        <Icon name={inboxIconFor(item.type)} size={16} />
        {actor && (
          <span
            aria-hidden="true"
            className="absolute -bottom-[3px] -right-[3px] inline-flex size-[17px] items-center justify-center rounded-full border-2 border-surface font-mono text-[7.5px] font-semibold text-white"
            style={{ background: avatarColor(actor) }}
          >
            {initials(actor)}
          </span>
        )}
      </span>

      {/* Main column (col 3): headline + time, then chips. */}
      <div className="min-w-0">
        <div className="flex items-start gap-2">
          <span className="min-w-0 text-[12.5px] leading-[1.5] text-muted">
            {head.actor && <b className="font-semibold text-ink">{head.actor}</b>}
            {head.actor ? " " : ""}
            <span>{head.verb}</span>
            {head.title && (
              <>
                <span>{head.titleSeparator}</span>
                <span className="font-semibold text-accent-ink">{head.title}</span>
              </>
            )}
          </span>
          <span className="ml-auto flex-none font-mono text-[10.5px] text-subtle">
            {relativeTime(item.createdAt)}
          </span>
        </div>

        {/* The anchored text (Anchord-Design `.me-quote`): italic, accent left-border, one-line
            clamp — rendered ABOVE the body preview when the thread anchors to a snippet. */}
        {item.quote && (
          <div className="mt-1.5 line-clamp-1 border-l-2 border-accent pl-[9px] text-[12px] italic leading-[1.45] text-muted">
            “{item.quote}”
          </div>
        )}

        {/* The comment-body excerpt (Anchord-Design `.me-preview`): ink, two-line clamp, no quote
            marks — the body of the triggering comment. */}
        {item.snippet && (
          <div className="mt-1.5 line-clamp-2 text-[12.5px] leading-[1.55] text-ink">{item.snippet}</div>
        )}

        <InboxRowChips item={item} />
      </div>
    </button>

      {/* Row-level "mark read" control (Anchord-Design `.me-rowact`): shown only while the row is
          unread, appears on hover (focus-visible for keyboard), and is HIDDEN on mobile (the
          prototype's `@media (max-width:599px) { .me-rowact { display:none } }`). Clicking it marks
          JUST this row read WITHOUT opening the detail (AS-007) — stopPropagation so the row's open
          handler never fires. Absolutely positioned over the row so the outer click target stays one
          element (no nested buttons). */}
      {unread && onMarkRead && (
        <button
          type="button"
          data-testid={`inbox-mark-read-${item.id}`}
          aria-label="Mark read"
          title="Mark read"
          onClick={(e) => {
            e.stopPropagation();
            onMarkRead(item);
          }}
          className="absolute right-2 top-2.5 hidden size-[26px] place-items-center rounded-md border border-line bg-surface text-muted opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 sm:grid"
        >
          <Icon name="check" size={14} />
        </button>
      )}
    </div>
  );
}

// The chip row under the sentence (Anchord-Design `.me-foot`): the owning workspace chip (AS-003)
// then the doc chip. Each renders only when its field is present (NULL-safe enrichment).
function InboxRowChips({ item }: { item: NotificationItem }) {
  const ws = item.workspaceName ?? null;
  const doc = item.docTitle ?? null;
  if (!ws && !doc) return null;
  // `.me-foot`: gap 8px, margin-top 9px. `.me-chip`: gap 5px, radius --r-sm (6px), padding 2px 7px,
  // mono 10px, elev bg + line border.
  const CHIP = "inline-flex items-center gap-[5px] rounded-[6px] border border-line bg-elev px-[7px] py-0.5 font-mono text-[10px]";
  return (
    <div className="mt-[9px] flex flex-wrap items-center gap-2">
      {ws && (
        <span data-testid={`inbox-chip-workspace-${item.id}`} className={`${CHIP} text-accent-ink`}>
          {/* The workspace GLYPH (Anchord-Design `.me-chip.ws .ws-glyph`): a 13px accent-soft
              rounded square with the workspace's 2-char initials — NOT a generic icon. */}
          <span className="grid size-[13px] flex-none place-items-center rounded-[3px] bg-accent-soft text-[7px] font-semibold uppercase leading-none text-accent-ink">
            {initials(ws)}
          </span>
          {ws}
        </span>
      )}
      {doc && (
        <span className={`${CHIP} text-ink`}>
          <Icon name="docs" size={11} />
          {doc}
        </span>
      )}
    </div>
  );
}
