import { formatDistanceToNow } from "date-fns";
import { Icon } from "@/components/icon";
import { ActivityChips } from "@/features/activity/components/activity-chips";
import { avatarColor, initials } from "@/lib/initials";
import type { ActivityEventRow, ActivityRowMeta, ActivityType } from "@/features/activity/types";

// One feed row (workspace-activity S-001 — the `ActivityRow` presentational piece): a type
// node-icon + the actor avatar + the event sentence + a relative time, with the type-specific
// ActivityChips footer. PRESENTATIONAL — takes the row + an onOpen callback as props, NOT bound to
// any fetch (so the personal "Your actions" feed reuses it, export contract).
//
// All actor/summary/target text is PLAIN TEXT — React escapes it; never dangerouslySetInnerHTML
// (F-12 / guest-name defence-in-depth).

// Per-type node icon + tone (ported from Anchord-Design/activity-data.jsx ACTIVITY_TYPES +
// activity.css .act-node tones). S-001 emits comment/reply/resolve; all twelve are mapped so
// later stories' rows render unchanged. `tone` keys the node-circle colour, not a text colour.
type NodeTone = "accent" | "green" | "amber" | "muted";
const TYPE_META: Record<ActivityType, { icon: string; tone: NodeTone }> = {
  comment: { icon: "inbox", tone: "accent" },
  reply: { icon: "inbox", tone: "muted" },
  resolve: { icon: "check", tone: "green" },
  publish: { icon: "arrowRight", tone: "accent" },
  restore: { icon: "refresh", tone: "amber" },
  share: { icon: "share", tone: "accent" },
  invite: { icon: "mail", tone: "muted" },
  member: { icon: "members", tone: "green" },
  member_removed: { icon: "members", tone: "amber" },
  workspace_renamed: { icon: "pencil", tone: "muted" },
  project: { icon: "folder", tone: "muted" },
  detached: { icon: "alert", tone: "amber" },
};

// .act-node tone → circle classes (background + icon colour), mirroring activity.css.
const NODE_TONE: Record<NodeTone, string> = {
  accent: "bg-accent-soft text-accent-ink",
  green: "bg-success/15 text-success",
  amber: "bg-amber-bg text-amber",
  muted: "border border-line bg-surface text-subtle",
};

/** The actor avatar (activity.css `.avatar` / prototype `actorAvatar`): a colour-hashed disc with
 *  white initials. "System" is a subtle-grey disc with a diamond glyph; a guest "Anonymous …" name
 *  shows a neutral "?" disc (no per-name colour) like the prototype. */
function ActorAvatar({ name }: { name: string }) {
  const isSystem = name === "System";
  const isGuest = name.startsWith("Anonymous");
  const neutral = isSystem || isGuest;
  return (
    <span
      aria-hidden="true"
      className="grid size-[19px] flex-none place-items-center rounded-full text-[8.5px] font-semibold text-white"
      style={{ background: neutral ? "var(--subtle)" : avatarColor(name) }}
    >
      {isSystem ? "◆" : isGuest ? "?" : initials(name)}
    </span>
  );
}

/** The event sentence: "<actor> <summary> <target> in <doc>". All plain text (escaped).
 *  Emphasis mirrors activity.css: the base reads MUTED, the actor pops in ink (semibold),
 *  the target AND document pop in accent-ink (semibold) — so actor + document stand out against
 *  the action verb. (.act-sentence / b / .tgt) The "in <doc>" clause appears only when the doc is a
 *  distinct object from the target (not for publish/restore, where target already names the version). */
function ActivitySentence({ event }: { event: ActivityEventRow }) {
  const showInDoc =
    event.docTitle &&
    event.docTitle !== event.target &&
    event.type !== "publish" &&
    event.type !== "restore";
  return (
    <span className="text-[13px] leading-snug text-muted">
      <b className="font-semibold text-ink">{event.actorName}</b>
      {event.summary ? ` ${event.summary} ` : " "}
      {event.target ? <span className="font-semibold text-accent-ink">{event.target}</span> : null}
      {showInDoc ? (
        <>
          {" in "}
          <span className="font-semibold text-accent-ink">{event.docTitle}</span>
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
  const rowMeta = (event.meta ?? {}) as ActivityRowMeta;
  const clickable = typeof onOpen === "function";
  // .act-row: a 32px node column + the content card. The node sits ON the timeline spine
  // (drawn by the list container), so it carries z-10 + an opaque background to mask the line.
  return (
    <div
      data-testid="activity-row"
      data-activity-type={event.type}
      className={`group relative grid grid-cols-[32px_1fr] gap-3 ${clickable ? "cursor-pointer" : ""} [&:not(:last-child)]:after:absolute [&:not(:last-child)]:after:left-[15px] [&:not(:last-child)]:after:top-4 [&:not(:last-child)]:after:-bottom-2 [&:not(:last-child)]:after:w-0.5 [&:not(:last-child)]:after:bg-line [&:not(:last-child)]:after:content-['']`}
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
      <span
        className={`relative z-10 grid size-8 flex-none place-items-center rounded-full ${NODE_TONE[meta.tone]}`}
      >
        <Icon name={meta.icon} size={15} />
      </span>
      <div className="min-w-0 rounded-[9px] border border-line bg-surface px-3 py-2.5 transition-[border-color,box-shadow] group-hover:border-subtle group-hover:shadow-md">
        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
          <ActorAvatar name={event.actorName} />
          <ActivitySentence event={event} />
          <span
            className="ml-auto flex-none font-mono text-[10.5px] text-subtle"
            title={new Date(event.createdAt).toLocaleString()}
          >
            {relativeTime(event.createdAt)}
          </span>
        </div>
        {/* .act-quote: the annotated text this event anchors to (italic, accent left-border). */}
        {rowMeta.quote ? (
          <div className="mt-[7px] line-clamp-1 border-l-2 border-accent pl-[9px] text-[12px] italic leading-snug text-muted">
            “{rowMeta.quote}”
          </div>
        ) : null}
        {/* .act-preview: the event body/description, clamped to two lines. */}
        {rowMeta.body ? (
          <div className="mt-[7px] line-clamp-2 text-[13px] leading-relaxed text-ink">{rowMeta.body}</div>
        ) : null}
        <ActivityChips event={event} />
      </div>
    </div>
  );
}
