import { formatDistanceToNow } from "date-fns";
import { Icon } from "@/components/icon";
import { ActivityChips } from "@/features/activity/components/activity-chips";
import type { ActivityEventRow, ActivityType } from "@/features/activity/types";

// One feed row (workspace-activity S-001 — the `ActivityRow` presentational piece): a type
// node-icon + the actor avatar + the event sentence + a relative time, with the type-specific
// ActivityChips footer. PRESENTATIONAL — takes the row + an onOpen callback as props, NOT bound to
// any fetch (so the personal "Your actions" feed reuses it, export contract).
//
// All actor/summary/target text is PLAIN TEXT — React escapes it; never dangerouslySetInnerHTML
// (F-12 / guest-name defence-in-depth).

// Per-type node icon + tone (ported from Anchord-Design/activity-data.jsx ACTIVITY_TYPES). S-001
// emits comment/reply/resolve; all twelve are mapped so later stories' rows render unchanged.
const TYPE_META: Record<ActivityType, { icon: string; tone: string }> = {
  comment: { icon: "inbox", tone: "text-accent" },
  reply: { icon: "inbox", tone: "text-muted" },
  resolve: { icon: "check", tone: "text-success" },
  publish: { icon: "arrowRight", tone: "text-accent" },
  restore: { icon: "refresh", tone: "text-amber" },
  share: { icon: "share", tone: "text-accent" },
  invite: { icon: "mail", tone: "text-muted" },
  member: { icon: "members", tone: "text-success" },
  member_removed: { icon: "members", tone: "text-amber" },
  workspace_renamed: { icon: "pencil", tone: "text-muted" },
  project: { icon: "folder", tone: "text-muted" },
  detached: { icon: "alert", tone: "text-amber" },
};

/** Up-to-two-letter initials for the actor avatar; "System" shows a diamond glyph instead. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function ActorAvatar({ name }: { name: string }) {
  const isSystem = name === "System";
  return (
    <span
      aria-hidden="true"
      className="grid size-5 flex-none place-items-center rounded-full bg-elev text-[9px] font-semibold text-muted"
    >
      {isSystem ? "◆" : initials(name)}
    </span>
  );
}

/** The event sentence: "<actor> <summary> <target>". All plain text (escaped). */
function ActivitySentence({ event }: { event: ActivityEventRow }) {
  const namesTarget = event.target && event.type !== "publish" && event.type !== "restore";
  return (
    <span className="text-[13px] leading-snug text-ink">
      <b className="font-medium">{event.actorName}</b>
      {event.summary ? ` ${event.summary}` : ""}
      {namesTarget ? (
        <>
          {" "}
          <span className="text-muted">{event.target}</span>
        </>
      ) : null}
    </span>
  );
}

function relativeTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return formatDistanceToNow(date, { addSuffix: true });
}

export function ActivityRow({
  event,
  onOpen,
}: {
  event: ActivityEventRow;
  onOpen?: (event: ActivityEventRow) => void;
}) {
  const meta = TYPE_META[event.type] ?? TYPE_META.comment;
  const clickable = typeof onOpen === "function";
  return (
    <div
      data-testid="activity-row"
      data-activity-type={event.type}
      className={`flex gap-3 rounded-[9px] border border-line bg-surface px-3 py-2.5 ${
        clickable ? "cursor-pointer transition-colors hover:border-accent/40" : ""
      }`}
      {...(clickable
        ? {
            role: "button" as const,
            tabIndex: 0,
            onClick: () => onOpen!(event),
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen!(event);
              }
            },
          }
        : {})}
    >
      <span className={`mt-0.5 flex-none ${meta.tone}`}>
        <Icon name={meta.icon} size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <ActorAvatar name={event.actorName} />
          <div className="min-w-0 flex-1">
            <ActivitySentence event={event} />
          </div>
          <span className="flex-none text-[11px] text-subtle" title={new Date(event.createdAt).toLocaleString()}>
            {relativeTime(event.createdAt)}
          </span>
        </div>
        <ActivityChips event={event} />
      </div>
    </div>
  );
}
