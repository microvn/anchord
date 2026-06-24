import { Icon } from "@/components/icon";
import { initials, avatarColor } from "@/lib/initials";
import { headlineParts, iconFor, relativeTime } from "@/features/notifications/lib/format";
import type { NotificationItem } from "@/features/notifications/types";

// your-activity-inbox S-001 — one inbox row (Anchord-Design `.me-row`): a type node-icon + actor
// avatar, the headline sentence, a workspace chip + doc chip, the relative time, and an unread dot.
// Opens the detail on click (the detail itself lands in S-003). Reuses the bell's pure formatters
// (headlineParts/iconFor/relativeTime) so the inbox reads consistently with the bell.

export function InboxRow({
  item,
  onOpen,
}: {
  item: NotificationItem;
  onOpen?: (item: NotificationItem) => void;
}) {
  const unread = !item.read;
  const head = headlineParts(item);
  const actor = item.actorName ?? null;

  return (
    <button
      type="button"
      data-testid={`inbox-row-${item.id}`}
      data-unread={unread || undefined}
      onClick={() => onOpen?.(item)}
      className="grid w-full grid-cols-[8px_34px_1fr] items-start gap-3 border-b border-line px-2 py-3 text-left transition-colors last:border-b-0 hover:bg-elev data-[unread]:bg-accent-soft/30"
    >
      {/* Unread dot (col 1) — teal when unread, transparent otherwise. */}
      <span
        aria-hidden="true"
        className={
          "mt-1.5 size-[7px] justify-self-center rounded-full " +
          (unread ? "bg-accent" : "bg-transparent")
        }
      />

      {/* Type node-icon + actor avatar (col 2). */}
      <span className="relative grid size-[34px] place-items-center rounded-full bg-accent-soft text-accent-ink">
        <Icon name={iconFor(item.type)} size={16} />
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
          <span className="min-w-0 text-sm leading-relaxed text-muted">
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

        {item.snippet && (
          <div className="mt-1 truncate text-[13px] text-muted">“{item.snippet}”</div>
        )}

        <InboxRowChips item={item} />
      </div>
    </button>
  );
}

// The chip row under the sentence (Anchord-Design `.me-foot`): the owning workspace chip (AS-003)
// then the doc chip. Each renders only when its field is present (NULL-safe enrichment).
function InboxRowChips({ item }: { item: NotificationItem }) {
  const ws = item.workspaceName ?? null;
  const doc = item.docTitle ?? null;
  if (!ws && !doc) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {ws && (
        <span
          data-testid={`inbox-chip-workspace-${item.id}`}
          className="inline-flex items-center gap-1.5 rounded-md border border-line bg-elev px-1.5 py-0.5 font-mono text-[10px] text-accent-ink"
        >
          <Icon name="dashboard" size={11} />
          {ws}
        </span>
      )}
      {doc && (
        <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-elev px-1.5 py-0.5 font-mono text-[10px] text-ink">
          <Icon name="docs" size={11} />
          {doc}
        </span>
      )}
    </div>
  );
}
