import { Icon } from "../../components/icon";
import type { ViewerAnnotation, AnnotationComment } from "./client";

// ThreadCard (S-003): one annotation rendered as a rail thread — QuoteRef · avatar · author ·
// time · body · flat ReplyList · Resolved badge. READ-ONLY here: no compose / reply / resolve
// affordances (those belong to the commenting spec). A resolved annotation is dimmed + badged
// (AS-010). An annotation the FE couldn't place (GAP-005) is flagged "couldn't place" and has no
// scroll target. Clicking the card focuses + scrolls to its highlight (AS-009).
//
// C-008-adjacent: the quote snippet + comment bodies are UNTRUSTED strings. They render as
// PLAINTEXT via React children (auto-escaped) — never dangerouslySetInnerHTML.

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function commentAuthor(c: AnnotationComment): string {
  return c.authorName || c.guestName || "Guest";
}

/** A short relative-ish label from an ISO timestamp; falls back to the raw string. */
function timeLabel(iso: string): string {
  return iso;
}

function Avatar({ name, size = 22 }: { name: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="flex flex-none items-center justify-center rounded-full bg-sunken text-[9px] font-semibold text-subtle"
      style={{ width: size, height: size }}
    >
      {initials(name)}
    </span>
  );
}

export function ThreadCard({
  annotation,
  focused,
  unplaceable,
  onFocus,
}: {
  annotation: ViewerAnnotation;
  focused: boolean;
  unplaceable: boolean;
  onFocus: (id: string) => void;
}) {
  const resolved = annotation.status === "resolved";
  const [root, ...replies] = annotation.comments;
  const quote = annotation.anchor.textSnippet;

  return (
    <button
      type="button"
      data-testid="thread-card"
      data-anno-thread={annotation.id}
      data-resolved={resolved ? "true" : undefined}
      aria-current={focused ? "true" : undefined}
      onClick={() => onFocus(annotation.id)}
      className={[
        "block w-full rounded-md border border-line bg-paper p-3 text-left transition-colors",
        focused ? "border-accent ring-1 ring-accent" : "hover:border-accent/40",
        resolved ? "opacity-60" : "",
      ].join(" ")}
    >
      <div className="mb-2 border-l-2 border-line pl-2 text-[12px] italic text-subtle">
        &ldquo;{quote}&rdquo;
      </div>

      {root && (
        <>
          <div className="mb-1 flex items-center gap-2">
            <Avatar name={commentAuthor(root)} />
            <span className="text-[12.5px] font-medium text-ink">{commentAuthor(root)}</span>
            <span className="text-[11px] text-subtle">{timeLabel(root.createdAt)}</span>
          </div>
          <div className="text-[13px] leading-snug text-ink">{root.body}</div>
        </>
      )}

      {(resolved || unplaceable) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {resolved && (
            <span
              data-testid="resolved-badge"
              className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-0.5 text-[10.5px] font-medium text-subtle"
            >
              <Icon name="check" size={11} /> Resolved
            </span>
          )}
          {unplaceable && (
            <span
              data-testid="couldnt-place-badge"
              className="inline-flex items-center gap-1 rounded-full bg-amber-bg px-2 py-0.5 text-[10.5px] font-medium text-amber"
            >
              <Icon name="alert" size={11} /> Couldn&rsquo;t place
            </span>
          )}
        </div>
      )}

      {replies.length > 0 && (
        <div data-testid="reply-list" className="mt-2 space-y-2 border-t border-line pt-2">
          {replies.map((r) => (
            <div key={r.id} data-testid="reply">
              <div className="mb-0.5 flex items-center gap-2">
                <Avatar name={commentAuthor(r)} size={20} />
                <span className="text-[12px] font-medium text-ink">{commentAuthor(r)}</span>
                <span className="text-[11px] text-subtle">{timeLabel(r.createdAt)}</span>
              </div>
              <div className="text-[12.5px] leading-snug text-ink">{r.body}</div>
            </div>
          ))}
        </div>
      )}
    </button>
  );
}

/** DetachedCard (S-004 DISPLAY only, AS-011): an isOrphaned annotation shown in the amber detached
 *  section — quote + body, NO highlight in the doc. Re-attach / Dismiss ACTIONS are deferred. */
export function DetachedCard({ annotation }: { annotation: ViewerAnnotation }) {
  const root = annotation.comments[0];
  return (
    <div
      data-testid="detached-card"
      data-anno-detached={annotation.id}
      className="rounded-md border border-amber/40 bg-amber-bg p-3"
    >
      <div className="mb-2 border-l-2 border-amber/50 pl-2 text-[12px] italic text-amber">
        &ldquo;{annotation.anchor.textSnippet}&rdquo;
      </div>
      {root && (
        <>
          <div className="mb-1 flex items-center gap-2">
            <Avatar name={commentAuthor(root)} />
            <span className="text-[12.5px] font-medium text-ink">{commentAuthor(root)}</span>
            <span className="text-[11px] text-subtle">{timeLabel(root.createdAt)}</span>
          </div>
          <div className="text-[13px] leading-snug text-ink">{root.body}</div>
        </>
      )}
    </div>
  );
}
