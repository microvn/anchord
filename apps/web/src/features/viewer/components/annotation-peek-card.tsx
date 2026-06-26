import type { ViewerAnnotation, AnnotationComment } from "@/features/viewer/services/client";
import { Icon } from "@/components/icon";
import { labelDisplay } from "@/features/viewer/lib/label-presets";
import { avatarColor } from "@/features/viewer/components/thread-card";

// AnnotationPeekCard (S-001): the READ-ONLY hover peek — a condensed summary of one annotation,
// anchored above its marker (S-001 UI Notes). It renders ONLY from the already-loaded annotation
// data (no API, SC-001). It is the condensed sibling of ThreadCard: avatar + author + relative time
// an optional type chip (redline / label), the quoted phrase (clamped ~2 lines),
// the root comment body (clamped ~2 lines), and a remaining-reply count ("3 replies"). It carries
// NO action bar (Reply / Resolve / Accept) — acting on the thread is the click-to-pin card's job
// (S-002). The peek is presentation only; it never mutates.
//
// C-003: the quoted phrase and the comment body are UNTRUSTED strings. They render as PLAINTEXT via
// React children (auto-escaped) — NEVER dangerouslySetInnerHTML, never markdown. This holds even on
// the HTML-doc case (S-003) where the card renders outside the sandbox: the content comes from the
// trusted, already-loaded annotation data, never from anything relayed.

const PEEK_WIDTH = 300;

// A short RELATIVE label from a comment timestamp ("now" / "5m" / "4h" / "2d") — the same compact
// chip ThreadCard uses. A value that isn't a real date (fixtures like "2h") passes through unchanged.
function timeLabel(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const sec = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (sec < 45) return "now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function commentAuthor(c: AnnotationComment): string {
  return c.authorName || c.guestName || "Guest";
}

export function AnnotationPeekCard({ annotation }: { annotation: ViewerAnnotation }) {
  // Tolerate an absent thread the same way ThreadCard does (destructuring undefined throws).
  const [root, ...replies] = annotation.comments ?? [];

  // The quote. For a multi_range anchor join the per-segment snippets so the peek reflects the whole
  // selection, not just block one (mirrors ThreadCard's quote derivation).
  const segs = annotation.anchor.segments;
  const quote =
    segs && segs.length > 1 ? segs.map((s) => s.textSnippet).join(" ") : annotation.anchor.textSnippet;

  // The type chip (conditional): a redline → "Delete"; a label → its preset chip. A plain comment
  // renders no chip. Mirrors ThreadCard's chip vocabulary, condensed.
  const isRedline = annotation.type === "suggestion" && annotation.suggestion?.kind === "delete";
  const labelPreset = labelDisplay(annotation.label);

  const rootName = root ? commentAuthor(root) : null;
  const replyCount = replies.length;

  return (
    <div
      data-testid="annotation-peek-card"
      // .thread vocabulary, condensed: paper, 1px line, r-md, small padding, a soft shadow so it
      // reads as a floating tooltip over the doc. ~300px wide (UI Notes).
      className="rounded-md border border-line bg-paper p-[10px] text-left shadow-lg"
      style={{ width: PEEK_WIDTH, maxWidth: "92vw" }}
    >
      {/* HEADER — avatar · author · time. No status marker (removed — the type chip + thread convey
          enough at a glance; lifecycle status lives in the pinned card / rail). */}
      <div className="flex items-center gap-2">
        {rootName && (
          <span
            aria-hidden
            className="flex h-[20px] w-[20px] flex-none items-center justify-center rounded-full font-mono text-[8.5px] font-semibold tracking-[0.02em] text-white"
            style={{ background: avatarColor(rootName) }}
          >
            {initials(rootName)}
          </span>
        )}
        {rootName && <span className="truncate text-[12.5px] font-semibold text-ink">{rootName}</span>}
        {root && <span className="font-mono text-[10px] text-subtle">{timeLabel(root.createdAt)}</span>}
      </div>

      {/* TYPE CHIP (conditional) — redline Delete, or a label preset chip. */}
      {(isRedline || labelPreset) && (
        <div className="mt-[6px] flex">
          {labelPreset ? (
            <span
              data-testid="peek-type-chip"
              className="inline-flex max-w-full items-center gap-1.5 rounded-[4px] px-1.5 py-0.5 text-[11px] font-semibold"
              style={{ color: labelPreset.color, background: `${labelPreset.color}1f` }}
            >
              {labelPreset.emoji ? (
                <span aria-hidden>{labelPreset.emoji}</span>
              ) : (
                <Icon name={labelPreset.icon} size={11} />
              )}
              <span>{labelPreset.text}</span>
            </span>
          ) : (
            <span
              data-testid="peek-type-chip"
              className="inline-flex items-center gap-1.5 rounded-[4px] bg-error/15 px-1.5 py-0.5 text-[11px] font-semibold text-error"
            >
              <Icon name="eraser" size={11} />
              <span>Delete</span>
            </span>
          )}
        </div>
      )}

      {/* QUOTE — clamped to ~2 lines. Inert plaintext via React children (C-003). */}
      <div
        data-testid="peek-quote"
        className="mt-[6px] line-clamp-2 border-l-2 border-accent py-px pl-[8px] text-[11.5px] italic leading-[1.4] text-muted"
      >
        &ldquo;{quote}&rdquo;
      </div>

      {/* ROOT COMMENT — clamped to ~2 lines. Inert plaintext via React children (C-003). */}
      {root && (
        <div data-testid="peek-body" className="mt-[6px] line-clamp-2 text-[12px] leading-[1.45] text-ink">
          {root.body}
        </div>
      )}

      {/* REMAINING-REPLY COUNT — only when there are replies. NO action bar (read-only). */}
      {replyCount > 0 && (
        <div data-testid="peek-reply-count" className="mt-[8px] text-[11px] font-medium text-subtle">
          {replyCount} {replyCount === 1 ? "reply" : "replies"}
        </div>
      )}
    </div>
  );
}
