import { useState } from "react";
import type { ViewerAnnotation, AnnotationComment } from "./client";

// ThreadCard (S-003): one annotation rendered as a rail thread — QuoteRef · avatar · author ·
// time · body · flat ReplyList · Resolved badge. Styled 1:1 with Anchord-Design viewer.css
// (.thread / .quote-ref / .cmt-* / .reply-list / .sg-badge) + tokens.css (.avatar). A resolved
// annotation is dimmed + badged (AS-010). An annotation the FE couldn't place (GAP-005) is flagged
// and has no scroll target. Clicking the card focuses + scrolls to its highlight (AS-009).
//
// S-003 reply (AS-006 / C-005): an inline Reply affordance (Reply button → textarea → Send). On
// send it calls the injected onReply(body) — the consumer wires addComment({ body, parentId }) with
// parentId = the annotation's first comment. The reply is appended to the SAME flat reply list as
// any existing replies — one level, NEVER nested deeper (C-005): a reply to a reply renders as a
// sibling of the others, not inside one. The card is a role="button" (not a real <button>) so the
// reply textarea/buttons can nest as valid interactive children; reply controls stopPropagation so
// they don't trigger the card's focus.
//
// C-008: the quote snippet + comment bodies + the typed reply are UNTRUSTED strings. They render as
// PLAINTEXT via React children (auto-escaped) — never dangerouslySetInnerHTML, never markdown.

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

// Per-author avatar palette — verbatim from Anchord-Design data.jsx (NOT the teal accent; these are
// identity colors, the prototype's canonical avatar set). White mono initials sit on top.
export const AVATAR_COLORS = [
  "#0b6b73",
  "#3a6ea5",
  "#7a5a9e",
  "#a85d3e",
  "#3f7a52",
  "#9a6700",
] as const;

/** Stable color for a name: hash (h = h*31 + charCode, unsigned) → palette index (Anchord-Design). */
export function avatarColor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

function commentAuthor(c: AnnotationComment): string {
  return c.authorName || c.guestName || "Guest";
}

/**
 * A short RELATIVE label from a comment timestamp ("now" / "5m" / "4h" / "2d") — matching the
 * prototype's compact time chip. The eden treaty client revives ISO timestamps into `Date` objects,
 * so this accepts a Date or an ISO string and never leaks raw ISO into the UI. A value that isn't a
 * real date (test fixtures like "2h", or an already-relative label) passes through unchanged.
 */
function timeLabel(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value); // not a date → already a label, keep it
  const sec = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (sec < 45) return "now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

// .avatar (tokens.css): colored disc, white mono initials. The thread overrides size + font-size
// inline (22px/9px for a root comment, 20px/8.5px for a reply).
function Avatar({ name, size = 22, fontSize = 9 }: { name: string; size?: number; fontSize?: number }) {
  return (
    <span
      aria-hidden
      className="flex flex-none items-center justify-center overflow-hidden rounded-full font-mono font-semibold tracking-[0.02em] text-white"
      style={{ width: size, height: size, fontSize, background: avatarColor(name) }}
    >
      {initials(name)}
    </span>
  );
}

// One comment's head (avatar · author · mono time). Shared by root + reply rows so the spacing +
// type scale stay identical to .cmt-head / .cmt-author / .cmt-time.
function CommentHead({
  c,
  avatarSize,
  avatarFont,
}: {
  c: AnnotationComment;
  avatarSize?: number;
  avatarFont?: number;
}) {
  const name = commentAuthor(c);
  return (
    <div className="flex items-center gap-2">
      <Avatar name={name} size={avatarSize} fontSize={avatarFont} />
      <span className="text-[12.5px] font-semibold text-ink">{name}</span>
      <span className="font-mono text-[10px] text-subtle">{timeLabel(c.createdAt)}</span>
    </div>
  );
}

// ReplyComposer: the inline reply affordance — a "Reply" link that opens a plaintext textarea +
// Send. Mirrors the S-001 Composer's plaintext-only / disabled-until-typed rules at reply scale.
// All controls stopPropagation so they don't bubble to the card's focus onClick.
function ReplyComposer({ onReply }: { onReply: (body: string) => unknown | Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const canSend = body.trim().length > 0 && !sending;
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  if (!open) {
    return (
      <button
        type="button"
        data-testid="reply-open"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className="mt-[9px] text-[12px] font-medium text-accent hover:text-accent-strong"
      >
        Reply
      </button>
    );
  }

  const send = () => {
    if (!canSend) return;
    const text = body.trim();
    setSending(true);
    void (async () => {
      try {
        await onReply(text);
        // AS-006: on success the reply shows flat — the consumer's refetch reconciles the real row.
        // Close + clear so the affordance returns to its resting state.
        setBody("");
        setOpen(false);
      } finally {
        setSending(false);
      }
    })();
  };

  return (
    <div data-testid="reply-composer" className="mt-[9px]" onClick={stop}>
      <textarea
        data-testid="reply-input"
        aria-label="Reply"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onClick={stop}
        placeholder="Reply"
        rows={2}
        className="block w-full resize-none rounded-[6px] border border-line bg-surface p-2 text-[12.5px] leading-[1.5] text-ink outline-none focus:border-accent"
      />
      <div className="mt-1.5 flex items-center justify-end gap-2">
        <button
          type="button"
          data-testid="reply-cancel"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(false);
            setBody("");
          }}
          className="rounded-[6px] px-2 py-1 text-[12px] text-subtle hover:text-ink"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="reply-send"
          disabled={!canSend}
          onClick={(e) => {
            e.stopPropagation();
            send();
          }}
          className="inline-flex items-center rounded-[6px] bg-accent px-2.5 py-1 text-[12px] font-semibold text-on-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}

export function ThreadCard({
  annotation,
  focused,
  unplaceable,
  onFocus,
  onReply,
}: {
  annotation: ViewerAnnotation;
  focused: boolean;
  unplaceable: boolean;
  onFocus: (id: string) => void;
  /** S-003: send a reply to THIS annotation. The consumer wires addComment({ body, parentId }) with
   *  parentId = the annotation's first comment. Absent → no reply affordance (read-only rail). */
  onReply?: (body: string) => unknown | Promise<unknown>;
}) {
  const resolved = annotation.status === "resolved";
  // Defensive: a thread with no/absent comments must never white-screen the whole viewer
  // (destructuring `undefined` throws "not iterable"). An empty thread renders quote-only.
  const [root, ...replies] = annotation.comments ?? [];
  const quote = annotation.anchor.textSnippet;

  // Optimistic replies the user sent this session, shown flat alongside server replies until a
  // refetch reconciles them (consistency with S-001's optimistic create, C-011). They live at the
  // SAME flat level — appended to the one reply list, never nested (C-005).
  const [optimisticReplies, setOptimisticReplies] = useState<AnnotationComment[]>([]);
  const allReplies = [...replies, ...optimisticReplies];

  const handleReply = onReply
    ? async (body: string) => {
        const result = await onReply(body);
        // A consumer that returns `false` signals a refused/failed write — don't show a ghost reply
        // (C-011-style). Any other return (true / void / a result) counts as accepted: AS-006 shows
        // the reply flat. parentId wiring (the annotation's first comment) is the consumer's job.
        if (result === false) return;
        setOptimisticReplies((prev) => [
          ...prev,
          {
            id: `optimistic-reply-${Date.now()}-${prev.length}`,
            parentId: root?.id ?? null,
            authorName: "You",
            body, // inert plaintext via React children (C-008)
            createdAt: new Date().toISOString(),
          },
        ]);
      }
    : undefined;

  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="thread-card"
      data-anno-thread={annotation.id}
      data-resolved={resolved ? "true" : undefined}
      aria-current={focused ? "true" : undefined}
      onClick={() => onFocus(annotation.id)}
      onKeyDown={(e) => {
        // Only the card itself activates on Enter/Space — never a key bubbled up from a child
        // control (the reply textarea), or a Space would be swallowed mid-typing.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onFocus(annotation.id);
        }
      }}
      className={[
        // .thread: paper, 1px line, r-md, 11px padding. focus → accent border + 3px accent-soft ring.
        "block w-full cursor-pointer rounded-md border bg-paper p-[11px] text-left transition-[border-color,box-shadow]",
        focused ? "border-accent ring-[3px] ring-accent-soft" : "border-line hover:border-subtle",
        resolved ? "opacity-[0.72]" : "",
      ].join(" ")}
    >
      {/* .quote-ref: 2px accent left rule (green when resolved), italic muted 12px/1.45. */}
      <div
        className={[
          "mb-[9px] border-l-2 py-px pl-[9px] text-[12px] italic leading-[1.45] text-muted",
          resolved ? "border-success" : "border-accent",
        ].join(" ")}
      >
        &ldquo;{quote}&rdquo;
      </div>

      {root && (
        <>
          <CommentHead c={root} />
          {/* .cmt-body: t-small 12.5px / 1.5, 6px above. */}
          <div className="mt-[6px] text-[12.5px] leading-[1.5] text-ink">{root.body}</div>
        </>
      )}

      {(resolved || unplaceable) && (
        // .cmt-badges: 8px above, 6px gap. .sg-badge: mono 9px UPPERCASE pill, 4px radius.
        <div className="mt-2 flex flex-wrap gap-1.5">
          {resolved && (
            <span
              data-testid="resolved-badge"
              className="rounded-[4px] bg-success/15 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.06em] text-success"
            >
              Resolved
            </span>
          )}
          {unplaceable && (
            <span
              data-testid="couldnt-place-badge"
              className="rounded-[4px] bg-amber/15 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.06em] text-amber"
            >
              Couldn&rsquo;t place
            </span>
          )}
        </div>
      )}

      {allReplies.length > 0 && (
        // .reply-list: indented under a 1px left rule (NOT a top divider), 9px above, 9px gap.
        // C-005: every reply (server OR optimistic, reply-to-comment OR reply-to-reply) is a direct
        // child here — one flat level, never a nested reply-list.
        <div
          data-testid="reply-list"
          className="mt-[9px] flex flex-col gap-[9px] border-l border-line pl-[11px]"
        >
          {allReplies.map((r) => (
            <div key={r.id} data-testid="reply">
              <CommentHead c={r} avatarSize={20} avatarFont={8.5} />
              <div className="mt-1 text-[12.5px] leading-[1.5] text-ink">{r.body}</div>
            </div>
          ))}
        </div>
      )}

      {/* S-003 reply affordance — only when the consumer supplies onReply (comment-capable role). */}
      {handleReply && <ReplyComposer onReply={handleReply} />}
    </div>
  );
}

/** DetachedCard (S-004 DISPLAY only, AS-011): an isOrphaned annotation in the amber detached
 *  section — quote + body, NO highlight. .thread.detached: amber border + amber quote rule. */
export function DetachedCard({ annotation }: { annotation: ViewerAnnotation }) {
  const root = (annotation.comments ?? [])[0]; // tolerate an absent thread (see ThreadCard)
  return (
    <div
      data-testid="detached-card"
      data-anno-detached={annotation.id}
      className="rounded-md border border-amber/40 bg-amber-bg/60 p-[11px]"
    >
      <div className="mb-[9px] border-l-2 border-amber py-px pl-[9px] text-[12px] italic leading-[1.45] text-muted">
        &ldquo;{annotation.anchor.textSnippet}&rdquo;
      </div>
      {root && (
        <>
          <CommentHead c={root} />
          <div className="mt-[6px] text-[12.5px] leading-[1.5] text-ink">{root.body}</div>
        </>
      )}
    </div>
  );
}
