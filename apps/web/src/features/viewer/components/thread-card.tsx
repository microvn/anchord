import { useEffect, useRef, useState } from "react";
import type { ViewerAnnotation, AnnotationComment } from "@/features/viewer/services/client";
import { Icon } from "@/components/icon";
import { labelDisplay } from "@/features/viewer/lib/label-presets";
import { REDLINE_ROOT_BODY } from "@/features/viewer/hooks/use-compose";

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

// S-004 (UI Notes — the label line): a SIGNAL annotation carries a label-preset id; the rail renders
// a preset-coloured row (icon + display text, e.g. "Looks good" / "Out of scope"). The display
// metadata comes from the SHARED LABEL_PRESETS constant (`@/features/viewer/lib/label-presets`) — the
// SAME source the LabelPicker reads (C-004: one v0 fixed set, no per-workspace table). An
// unknown/foreign id (defence-in-depth — the server already validates ∈ preset set, AS-014) renders
// no label line rather than leaking a raw id. The label text renders inert via React children (C-006).

// annotation-actions-ui S-002 (C-002/C-003): the 2-family action-bar decision, isolated as a PURE
// helper so it can be unit-tested directly AND reused by the render. It collapses accept/reject/
// resolve/reopen down to AT MOST two primary actions, chosen by family + permission + own:
//
//   • Remark (no suggestion)            → Resolve (unresolved) / Reopen (resolved) — commenter+.
//   • Proposal I authored (isOwn)       → treated as a remark for ME → Resolve/Reopen, NEVER
//                                          Accept/Reject (no self-approve, C-003) — even as owner.
//   • Proposal, owner, pending          → Accept + Reject (no Resolve).
//   • Proposal, owner, decided          → Reopen (the universal undo; no Accept/Reject).
//   • Proposal, owner, stale            → nothing (a drifted redline can't be accepted; no decide
//                                          row; the existing stale badge still surfaces).
//   • Proposal, non-owner               → nothing (reply only).
//
// Every flag is a CLIENT HINT — the backend re-authorizes every close by session role + creator
// identity (C-002). The render ANDs these with the matching callback presence (onResolve / onDecide),
// so a viewer (no onResolve) still gets no Resolve even when the family would offer one.
export function actionBarSlots(input: {
  /** the annotation carries a `suggestion` payload (redline/replace) → a Proposal; else a Remark. */
  isProposal: boolean;
  /** the suggestion lifecycle (pending | accepted | rejected | stale); ignored for a remark. */
  sugStatus?: "pending" | "accepted" | "rejected" | "stale";
  /** the current user is the doc owner (effectiveRole === "owner"). */
  isOwner: boolean;
  /** the annotation's durable authorId equals the current user (own — the no-self-approve key). */
  isOwn: boolean;
  /** the thread currently reads as resolved (server status or an optimistic toggle). */
  resolved: boolean;
}): { showResolve: boolean; showReopen: boolean; showDecide: boolean } {
  const { isProposal, sugStatus, isOwner, isOwn, resolved } = input;
  const remarkSlots = {
    showResolve: !resolved,
    showReopen: resolved,
    showDecide: false,
  };
  // A Remark — or a Proposal I authored (treated as a remark for me, C-003: no self-approve).
  if (!isProposal || isOwn) return remarkSlots;
  // A Proposal I did NOT author. Only the owner gets a close action; a non-owner gets none (reply only).
  if (!isOwner) return { showResolve: false, showReopen: false, showDecide: false };
  // Owner on someone else's proposal: pending → Accept/Reject; decided → Reopen; stale → nothing.
  if (sugStatus === "pending") return { showResolve: false, showReopen: false, showDecide: true };
  if (sugStatus === "accepted" || sugStatus === "rejected")
    return { showResolve: false, showReopen: true, showDecide: false };
  // stale (or an absent status) → no close action — a drifted redline cannot be accepted (AS-007).
  return { showResolve: false, showReopen: false, showDecide: false };
}

// annotation-actions-ui S-005 (C-007): a rail item keeps a FIXED shape regardless of content length.
// The quoted span is the main offender — a 10-line quote would stretch the card unbounded. So the
// quote is CAPPED to ≈3 lines when collapsed, with an Expand control that opens the FULL quote in a
// scrollable, read-only area (a bounded max-height + overflow-auto — the surrounding layout never
// stretches). A short quote (≤ the cap) needs no control and no clamp.
//
// Overflow detection (AS-017): a CONTENT-LENGTH heuristic, NOT a measured/layout overflow check.
// bun/jsdom has no real layout (scrollHeight/clientHeight are 0), so a measured check is both
// untestable here and a render-time effect; a deterministic char/newline threshold is the testable,
// SSR-safe choice. A quote is "long" when it has ≥ QUOTE_CAP_LINES explicit newlines OR exceeds
// QUOTE_CAP_CHARS characters (≈ what 3 rail-width lines hold). Whitespace-only / empty → never long
// (no control, no crash).
export const QUOTE_CAP_LINES = 3;
export const QUOTE_CAP_CHARS = 160;

export function quoteOverflows(quote: string): boolean {
  const text = quote ?? "";
  if (text.trim().length === 0) return false; // empty / whitespace → nothing to expand
  const newlines = (text.match(/\n/g) ?? []).length;
  return newlines >= QUOTE_CAP_LINES || text.length > QUOTE_CAP_CHARS;
}

// QuotePreview: the quoted snippet (untrusted plaintext, C-008 — rendered via React children, NEVER
// dangerouslySetInnerHTML). A long quote (quoteOverflows) collapses to ≈3 lines (line-clamp) + an
// Expand control; expanding swaps to a bounded scroll area (max-height + overflow-auto), READ-ONLY
// (it's a quoted snippet, not editable). A short quote renders plain with no control. The expand /
// collapse control stopPropagation so it never triggers the card's focus onClick.
function QuotePreview({ quote, resolved }: { quote: string; resolved: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const overflows = quoteOverflows(quote);
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  const ruleColor = resolved ? "border-success" : "border-accent";

  return (
    <div data-testid="quote-preview" className="mb-[9px]">
      {/* .quote-ref: 2px accent left rule (green when resolved), italic muted 12px/1.45. Collapsed =
          clamp to QUOTE_CAP_LINES; expanded = a bounded, scrollable, read-only region (the layout
          never stretches unbounded — C-007). */}
      <div
        data-testid="quote-text"
        data-expanded={overflows && expanded ? "true" : undefined}
        data-clamped={overflows && !expanded ? "true" : undefined}
        className={[
          "border-l-2 py-px pl-[9px] text-[12px] italic leading-[1.45] text-muted",
          ruleColor,
          overflows && expanded
            ? "max-h-[9.5rem] overflow-auto whitespace-pre-wrap"
            : overflows
              ? "line-clamp-3"
              : "whitespace-pre-wrap",
        ].join(" ")}
      >
        &ldquo;{quote}&rdquo;
      </div>
      {overflows && (
        <button
          type="button"
          data-testid="quote-toggle"
          aria-expanded={expanded}
          onClick={(e) => {
            stop(e);
            setExpanded((o) => !o);
          }}
          className="mt-1 cursor-pointer rounded-[4px] px-[5px] py-[2px] text-[11px] font-semibold text-muted hover:bg-elev hover:text-ink"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

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

// S-005 (C-010): a comment is a GUEST comment when it carries a self-entered guestName and no
// account authorName — the name is a display label, not an identity. A member comment has an
// authorName. (A comment with neither falls back to the literal "Guest".)
function isGuestComment(c: AnnotationComment): boolean {
  return !c.authorName && Boolean(c.guestName);
}

// Max rendered guest-name length (C-008.T3 — over-long names truncated even if a stale/forged row
// slipped past the write-time sanitize). Mirrors composer.GUEST_NAME_MAX. React children already
// escape it (inert); this only bounds the LENGTH at the render layer.
const GUEST_NAME_RENDER_MAX = 40;

function commentAuthor(c: AnnotationComment): string {
  const name = c.authorName || c.guestName || "Guest";
  // Truncate an over-long (guest) name at render (defence-in-depth, C-008.T3 / AS-012.T2).
  return name.length > GUEST_NAME_RENDER_MAX ? `${name.slice(0, GUEST_NAME_RENDER_MAX)}…` : name;
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
      {/* C-010: a guest comment is visibly attributed as a guest — a neutral pill next to the
          self-entered name (a display label, not an identity, distinct from a workspace member). */}
      {isGuestComment(c) && (
        <span
          data-testid="guest-badge"
          className="rounded-[4px] bg-sunken px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.06em] text-subtle"
        >
          Guest
        </span>
      )}
      <span className="font-mono text-[10px] text-subtle">{timeLabel(c.createdAt)}</span>
    </div>
  );
}

// ReplyComposer: the OPEN inline reply form — a plaintext textarea + Cancel/Send. The collapsed
// "Reply" trigger lives in ThreadCard's action row (so the parent can drop the Resolve button out of
// the row while composing — the composer takes the full width, F3). Mirrors the S-001 Composer's
// plaintext-only / disabled-until-typed rules at reply scale. All controls stopPropagation so they
// don't bubble to the card's focus onClick. Tap targets are ≥40px / ≥44px on mobile (DESIGN.md).
function ReplyComposer({
  onReply,
  onClose,
}: {
  onReply: (body: string) => unknown | Promise<unknown>;
  onClose: () => void;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const canSend = body.trim().length > 0 && !sending;
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

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
        onClose();
      } finally {
        setSending(false);
      }
    })();
  };

  return (
    <div data-testid="reply-composer" className="mt-[9px] w-full" onClick={stop}>
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
            setBody("");
            onClose();
          }}
          className="cursor-pointer rounded-[6px] px-2 py-1 text-[12px] text-subtle hover:text-ink"
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
          className="inline-flex cursor-pointer items-center rounded-[6px] bg-accent px-2.5 py-1 text-[12px] font-semibold text-on-accent disabled:cursor-not-allowed disabled:opacity-50"
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
  currentUserId,
  isOwner = false,
  onReply,
  onResolve,
  onDecide,
  onDelete,
}: {
  annotation: ViewerAnnotation;
  focused: boolean;
  unplaceable: boolean;
  onFocus: (id: string) => void;
  /** annotation-actions-ui S-001 (C-001): the current session user id, for own-vs-others. An item is
   *  marked OWN only when the annotation's durable `authorId` is non-null AND equals this — mirroring
   *  the backend null-guard. A guest annotation (null `authorId`) matches no one; a signed-out viewer
   *  (null/undefined here) owns nothing. The OWN flag NEVER derives from the root-comment author. */
  currentUserId?: string | null;
  /** annotation-actions-ui S-002 (C-002): the current user is the doc OWNER (effectiveRole==="owner").
   *  Gates the proposal close family — only the owner gets Accept/Reject (pending) or Reopen (decided)
   *  on a proposal they did NOT author. A client HINT; the backend re-authorizes the close. A remark,
   *  or a proposal I authored (isOwn), ignores this and stays Resolve/Reopen (no self-approve, C-003).
   *  Defaults false (a non-owner / read-only rail). */
  isOwner?: boolean;
  /** S-003: send a reply to THIS annotation. The consumer wires addComment({ body, parentId }) with
   *  parentId = the annotation's first comment. Absent → no reply affordance (read-only rail). */
  onReply?: (body: string) => unknown | Promise<unknown>;
  /** S-004: resolve / reopen THIS annotation. The consumer wires setResolution({ resolved }).
   *  Gated on comment permission (C-006/C-004), NOT authorship — resolving is not author-only
   *  (AS-008). Resolves to `false` on a refused/failed write so the card rolls back its optimistic
   *  toggle (the toggle reflects the SERVER result). Absent → no Resolve control (viewer, C-004). */
  onResolve?: (resolved: boolean) => Promise<boolean>;
  /** S-002 (AS-005/006/C-002): OWNER-only accept/reject of a pending redline. The consumer wires
   *  decideSuggestion({ decision }); deciding auto-resolves the thread (the backend flips status, the
   *  consumer reconciles it). Absent → no Accept/Reject row (non-owner, or not a redline). A drifted
   *  (stale) redline cannot be accepted (AS-007), so the row is not offered when stale. */
  onDecide?: (decision: "accept" | "reject") => Promise<boolean>;
  /** annotation-actions-ui S-003 (C-004): delete THIS annotation. The consumer wires the optimistic
   *  remove + undo-toast + restore orchestration (viewer-screen's useAnnotations); the card only
   *  surfaces the overflow Delete affordance + calls this. It is shown ONLY when `canDelete = isOwn
   *  || isOwner` AND this callback is supplied — the author (delete-own) or the doc owner (moderate);
   *  a viewer/guest/non-owner-non-author gets no Delete (the consumer also omits the callback for a
   *  read-only role). A CLIENT HINT — the backend re-authorizes the delete (annotation-actions S-004).
   *  Resolves to the call result (truthy on accepted) the same way onResolve/onDecide do. */
  onDelete?: () => unknown | Promise<unknown>;
}) {
  // The resolved state the CARD shows. It starts from the server status, but a local optimistic
  // override (AS-007) drives it the moment the user toggles, before the refetch reconciles. When the
  // server status catches up (a fresh annotation prop), drop the override so the server is the truth.
  const serverResolved = annotation.status === "resolved";
  const [optimisticResolved, setOptimisticResolved] = useState<boolean | null>(null);
  const lastServerResolved = useRef(serverResolved);
  useEffect(() => {
    if (serverResolved !== lastServerResolved.current) {
      lastServerResolved.current = serverResolved;
      setOptimisticResolved(null); // server reconciled — its status wins
    }
  }, [serverResolved]);
  const resolved = optimisticResolved ?? serverResolved;
  // Defensive: a thread with no/absent comments must never white-screen the whole viewer
  // (destructuring `undefined` throws "not iterable"). An empty thread renders quote-only.
  const [root, ...replies] = annotation.comments ?? [];
  // The rail quote. For a multi_range (cross-block) anchor the top-level textSnippet is only the FIRST
  // segment's text (e.g. a table's "Rule" header cell) — the full selection spans every segment. Join
  // the per-segment snippets so the quote reflects what was actually selected, not just block one.
  const segs = annotation.anchor.segments;
  const quote =
    segs && segs.length > 1
      ? segs.map((s) => s.textSnippet).join(" ")
      : annotation.anchor.textSnippet;

  // annotation-actions-ui S-001 (C-001): own-vs-others from the DURABLE creator id. An item is the
  // current user's own only when its `authorId` is non-null AND equals the session user id — the
  // exact server null-guard (a null `authorId` is a guest, which matches no signed-in user, and a
  // signed-out viewer has no id, so owns nothing). This is the keystone the later no-self-approve
  // gate (S-002) + delete-own (S-003) build on, so it keys on `authorId` ONLY — never the root
  // comment's author (which can differ, e.g. a reply moved to the front or a renamed display name).
  const isOwn = annotation.authorId != null && annotation.authorId === currentUserId;

  // annotation-actions-ui S-003 (C-004): the Delete affordance gate. Delete is offered ONLY to the
  // annotation's AUTHOR (isOwn — delete-own) OR the doc OWNER (isOwner — moderate-delete); a viewer,
  // a guest, and a non-owner non-author see none. It also requires the consumer to have wired
  // onDelete (a read-only viewer role supplies no callback). A CLIENT HINT — the backend
  // re-authorizes by session role + the durable creator identity (annotation-actions S-004).
  const canDelete = Boolean(onDelete) && (isOwn || isOwner);

  // S-002 (C-002): a redline is a delete-kind suggestion. The DELETE badge + the owner Accept/Reject
  // row + the stale state derive from the served type + suggestion payload + suggestionStatus.
  const isRedline =
    annotation.type === "suggestion" && annotation.suggestion?.kind === "delete";
  // S-004 (AS-012 / UI Notes): a signal annotation's label line (icon + text, e.g. "Out of scope").
  // Looked up from the SHARED preset set — an unknown id renders nothing (the server validates ∈
  // preset set, AS-014; this is defence-in-depth so a forged id never leaks a raw string).
  const labelPreset = labelDisplay(annotation.label);
  // The root comment body is AUTO-PREFILLED from the type/label text (C-003): a Like/Label body =
  // the preset display text, a redline body = the redline default. The label line (icon + preset
  // text) and the DELETE badge ALREADY convey that, so rendering the identical body again is just
  // noise ("Out of scope" chip + "Out of scope" body). Suppress the body when it's the unedited
  // boilerplate; show it only when the author actually wrote something (a real note, or a comment).
  const bodyIsBoilerplate =
    Boolean(root) &&
    ((labelPreset != null && root!.body.trim() === labelPreset.text) ||
      (annotation.type === "suggestion" && root!.body.trim() === REDLINE_ROOT_BODY));
  const sugStatus = annotation.suggestionStatus;
  const isStale = isRedline && sugStatus === "stale";
  // S-002 (C-002): a Proposal is ANY annotation carrying a suggestion payload (redline = delete-kind);
  // everything else (comment / like / label) is a Remark. The family + permission + own decide the bar.
  const isProposal = Boolean(annotation.suggestion);
  // S-002 (C-002/C-003): the centralized 2-family decision — at most two primary actions. The render
  // ANDs each slot with its callback presence (onResolve / onDecide), so a viewer (no onResolve) still
  // gets no Resolve even when the family would offer one (the affordance is a hint, not the authority).
  const slots = actionBarSlots({ isProposal, sugStatus, isOwner, isOwn, resolved });

  // annotation-actions-ui S-002 (AS-020 / C-003): WITHHOLD the owner-decide affordance until the
  // session has resolved (the current user id is known). The no-self-approve gate keys on `isOwn`,
  // which is false while `currentUserId` is null — so during the brief sign-in load window a
  // signed-in owner's OWN pending proposal would otherwise flash Accept/Reject before `isOwn`
  // corrects it to Resolve. An owner is ALWAYS signed in, so `currentUserId == null` in the card
  // means "session not resolved yet" → don't show decide. A signed-out viewer is never owner (no
  // decide anyway), so this only suppresses the owner-pending flash. The pure `actionBarSlots`
  // logic is untouched; the guard is applied at the render boundary only.
  const sessionResolved = currentUserId != null;
  const showDecide = slots.showDecide && sessionResolved;

  // Optimistic replies the user sent this session, shown flat alongside server replies until a
  // refetch reconciles them (consistency with S-001's optimistic create, C-011). They live at the
  // SAME flat level — appended to the one reply list, never nested (C-005).
  const [optimisticReplies, setOptimisticReplies] = useState<AnnotationComment[]>([]);

  // Reconcile-on-success (mirrors S-001's create reconcile): when the consumer's refetch lands, the
  // server thread grows by the real reply. Drop that many optimistic temps from the front so the
  // reply doesn't render twice (optimistic + real). We track the server reply count we've already
  // absorbed; a fresh increase clears the matching number of temps. With NO refetch (the pure
  // component path / a consumer that never re-supplies the annotation) the count never grows, so the
  // optimistic reply stays — AS-006's flat reply still shows.
  const serverReplyCount = replies.length;
  const absorbed = useRef(serverReplyCount);
  useEffect(() => {
    if (serverReplyCount > absorbed.current) {
      const grew = serverReplyCount - absorbed.current;
      absorbed.current = serverReplyCount;
      setOptimisticReplies((prev) => prev.slice(grew));
    }
  }, [serverReplyCount]);

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

  // S-004 (AS-007/C-006): toggle the resolved status. Optimistically flip the card (badge + dim)
  // immediately, then call the consumer's setResolution. On a refused/failed write (resolves false)
  // roll the optimistic flip back — the toggle must reflect the SERVER result, never a forged one.
  const [toggling, setToggling] = useState(false);
  // F3: the reply composer's open state lives on the CARD (not inside ReplyComposer) so the action
  // row can drop the Resolve button while composing — the composer then takes the full width instead
  // of sharing the row with Resolve (which used to pin awkwardly to the textarea's top-right corner).
  const [replyOpen, setReplyOpen] = useState(false);
  // S-003 (C-004): the overflow menu's open state + a delete-in-flight guard (so a double-click
  // can't fire two deletes). The menu only ever mounts when canDelete is true.
  const [menuOpen, setMenuOpen] = useState(false);
  const [deletingMenu, setDeletingMenu] = useState(false);
  const handleDelete =
    onDelete && canDelete
      ? (e: { stopPropagation: () => void }) => {
          e.stopPropagation(); // never trigger the card's focus onClick
          if (deletingMenu) return;
          setMenuOpen(false);
          setDeletingMenu(true);
          // The consumer (viewer-screen) owns the optimistic remove + undo toast + restore. The card
          // just invokes it; this card will typically unmount on the optimistic remove, so resetting
          // the in-flight flag in a finally is best-effort (a refused delete re-adds + re-renders it).
          void (async () => {
            try {
              await onDelete();
            } finally {
              setDeletingMenu(false);
            }
          })();
        }
      : undefined;
  // S-002 (AS-005/006/C-002): owner accepts/rejects a redline. Optimistically resolve the thread
  // (deciding auto-resolves it, dimmed) the moment the owner clicks, then call the consumer's
  // onDecide. On a refused/failed/stale decide (resolves false) roll the optimistic resolve back —
  // the card reflects the SERVER result, never an unconfirmed decision.
  const [deciding, setDeciding] = useState(false);
  const handleDecide = onDecide
    ? (decision: "accept" | "reject") => (e: { stopPropagation: () => void }) => {
        e.stopPropagation(); // never trigger the card's focus onClick
        if (deciding) return;
        setOptimisticResolved(true); // deciding auto-resolves (C-002) — dim immediately
        setDeciding(true);
        void (async () => {
          try {
            const ok = await onDecide(decision);
            if (!ok) setOptimisticResolved(null); // refused/stale → fall back to the server status
          } catch {
            setOptimisticResolved(null);
          } finally {
            setDeciding(false);
          }
        })();
      }
    : undefined;

  const handleResolveToggle = onResolve
    ? (e: { stopPropagation: () => void }) => {
        e.stopPropagation(); // never trigger the card's focus onClick
        if (toggling) return;
        const next = !resolved;
        setOptimisticResolved(next);
        setToggling(true);
        void (async () => {
          try {
            const ok = await onResolve(next);
            if (!ok) setOptimisticResolved(!next); // rollback to the prior state
          } catch {
            setOptimisticResolved(!next);
          } finally {
            setToggling(false);
          }
        })();
      }
    : undefined;

  // Locked-design layout: ONE status pill on the header right, never stacked. Precedence (render at
  // most one): pending → accepted → rejected → stale → resolved (a RESOLVED REMARK only — a decided
  // proposal shows its OUTCOME pill, NOT also Resolved). `couldnt-place` is an orthogonal placement
  // warning that may render alongside the status pill (it isn't a lifecycle outcome).
  // A RESOLVED REMARK shows the Resolved pill; a PROPOSAL never does — a proposal's single status is
  // its lifecycle pill (Pending/Accepted/Rejected/Stale), and a decided proposal conveys "closed" via
  // the dim, not a stacked Resolved chip. So this is gated on `!isProposal`.
  const showResolvedRemarkBadge = resolved && !isProposal;
  const showResolveToggle = Boolean(handleResolveToggle) && (slots.showResolve || slots.showReopen);
  // C-001: the rail ALWAYS shows the REAL author name + avatar — own and others identically, NO "You"
  // relabel and no visible own marker. Own-vs-others stays INTERNAL (the `isOwn` flag above + the
  // non-visible `data-own` hook), driving only the no-self-approve + delete-own gates.
  const rootName = root ? commentAuthor(root) : null;

  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="thread-card"
      data-anno-thread={annotation.id}
      data-own={isOwn ? "true" : undefined}
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
        // `relative` so the overflow menu (C-004) can anchor within the header-right cluster.
        "relative block w-full cursor-pointer rounded-md border bg-paper p-[11px] text-left transition-[border-color,box-shadow]",
        focused ? "border-accent ring-[3px] ring-accent-soft" : "border-line hover:border-subtle",
        resolved ? "opacity-[0.72]" : "",
      ].join(" ")}
    >
      {/* 1. HEADER ROW — avatar · author · time on the LEFT; the single status pill + the overflow ⋯
          on the RIGHT. The author name + avatar are ALWAYS the REAL root-comment author — own and
          others identically, NO "You" relabel / no visible own marker (C-001). Own-vs-others is
          INTERNAL (the data-own hook). With no root comment the header omits author/time. */}
      <div data-testid="thread-header" className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {root && <Avatar name={commentAuthor(root)} />}
          {rootName != null && (
            <span className="truncate text-[12.5px] font-semibold text-ink">{rootName}</span>
          )}
          {/* C-010: a guest comment is visibly attributed as a guest (a display label, not identity). */}
          {root && isGuestComment(root) && (
            <span
              data-testid="guest-badge"
              className="rounded-[4px] bg-sunken px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.06em] text-subtle"
            >
              Guest
            </span>
          )}
          {root && <span className="font-mono text-[10px] text-subtle">{timeLabel(root.createdAt)}</span>}
        </div>

        <div className="flex flex-none items-center gap-1.5">
          {/* The SINGLE status pill (render at most ONE — the precedence above). DESIGN.md hues:
              Pending/Stale neutral, Accepted/Resolved success, Rejected error. */}
          {isProposal && sugStatus === "pending" && (
            <span
              data-testid="redline-pending-badge"
              className="rounded-[4px] bg-sunken px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.06em] text-subtle"
            >
              Pending
            </span>
          )}
          {sugStatus === "accepted" && (
            <span
              data-testid="redline-accepted-badge"
              className="rounded-[4px] bg-success/15 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.06em] text-success"
            >
              Accepted
            </span>
          )}
          {sugStatus === "rejected" && (
            <span
              data-testid="redline-rejected-badge"
              className="rounded-[4px] bg-error/15 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.06em] text-error"
            >
              Rejected
            </span>
          )}
          {isStale && (
            <span
              data-testid="redline-stale-badge"
              className="rounded-[4px] bg-sunken px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.06em] text-muted"
            >
              Stale
            </span>
          )}
          {/* A RESOLVED REMARK keeps its Resolved pill; a decided PROPOSAL does NOT (its outcome pill
              above is the single status — the dim conveys it's closed). */}
          {showResolvedRemarkBadge && (
            <span
              data-testid="resolved-badge"
              className="rounded-[4px] bg-success/15 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.06em] text-success"
            >
              Resolved
            </span>
          )}
          {/* Orthogonal placement warning — may render alongside the status pill. */}
          {unplaceable && (
            <span
              data-testid="couldnt-place-badge"
              className="rounded-[4px] bg-amber/15 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.06em] text-amber"
            >
              Couldn&rsquo;t place
            </span>
          )}

          {/* S-003 (C-004): the OVERFLOW MENU — a "⋯" that houses Delete. Mounted ONLY when canDelete
              (author delete-own OR doc-owner moderate) AND onDelete is wired; a viewer / guest /
              non-owner-non-author never reaches here. The backend re-authorizes the delete. */}
          {canDelete && handleDelete && (
            <div className="relative">
              <button
                type="button"
                data-testid="overflow-trigger"
                aria-label="More actions"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen((o) => !o);
                }}
                className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-[6px] text-subtle hover:bg-elev hover:text-ink"
              >
                <Icon name="more" size={15} />
              </button>
              {menuOpen && (
                <>
                  {/* An invisible click-catcher so an outside click closes the menu. */}
                  <button
                    type="button"
                    aria-hidden
                    tabIndex={-1}
                    data-testid="overflow-scrim"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuOpen(false);
                    }}
                    className="fixed inset-0 z-40 cursor-default"
                  />
                  <div
                    role="menu"
                    data-testid="overflow-menu"
                    onClick={(e) => e.stopPropagation()}
                    className="absolute right-0 top-[28px] z-50 min-w-[120px] rounded-[8px] border border-line bg-paper py-1 shadow-lg"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="overflow-delete"
                      disabled={deletingMenu}
                      onClick={handleDelete}
                      className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12.5px] font-medium text-error hover:bg-elev disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Icon name="trash" size={13} />
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 2. TYPE-CHIP ROW (own line): a LABEL preset chip, OR the redline "⌫ Delete" red chip. A plain
          comment renders no chip row. A long/extensible label wraps within its own line. */}
      {(labelPreset || isRedline) && (
        <div data-testid="type-chip-row" className="mt-[6px] flex">
          {labelPreset ? (
            <div
              data-testid="label-line"
              data-label={annotation.label}
              className="inline-flex max-w-full items-center gap-1.5 whitespace-normal break-words rounded-[4px] px-1.5 py-0.5 text-[11.5px] font-semibold"
              style={{ color: labelPreset.color, background: `${labelPreset.color}1f` }}
            >
              {labelPreset.emoji ? (
                <span aria-hidden>{labelPreset.emoji}</span>
              ) : (
                <Icon name={labelPreset.icon} size={12} />
              )}
              <span>{labelPreset.text}</span>
            </div>
          ) : (
            // S-002 (AS-004): a redline's DELETE type chip — red-tinted, on its own line.
            <div
              data-testid="type-badge-delete"
              className="inline-flex max-w-full items-center gap-1.5 rounded-[4px] bg-error/15 px-1.5 py-0.5 text-[11.5px] font-semibold text-error"
            >
              <Icon name="trash" size={12} />
              <span>Delete</span>
            </div>
          )}
        </div>
      )}

      {/* 3. QUOTE — capped to ≈3 lines with an expand control (C-007); read-only. */}
      <div className="mt-[6px]">
        <QuotePreview quote={quote} resolved={resolved} />
      </div>

      {/* 4. NOTE — the root body, only when it's a real note (not the auto-prefilled boilerplate the
          label chip / DELETE chip already conveys). */}
      {root && !bodyIsBoilerplate && (
        <div className="text-[12.5px] leading-[1.5] text-ink">{root.body}</div>
      )}

      {/* 5. REPLY LIST — flat, one level (C-005), under a 1px left rule. */}
      {allReplies.length > 0 && (
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

      {/* 6. DIVIDER + 2-SLOT ACTION BAR — Reply on the LEFT, the close action on the RIGHT. While the
          reply composer is open it OWNS the bar full-width (F3). The RIGHT slot is the owner Accept/
          Reject (a pending proposal) XOR the Resolve/Reopen toggle (a remark / decided proposal); a
          non-owner / stale proposal shows neither → Reply only. Handlers unchanged — only placement. */}
      {(handleReply || showDecide || showResolveToggle) && (
        <div className="mt-[9px] border-t border-line pt-[9px]">
          {replyOpen && handleReply ? (
            <ReplyComposer onReply={handleReply} onClose={() => setReplyOpen(false)} />
          ) : (
            <div className="flex items-center justify-between gap-1.5">
              <div className="flex items-center gap-1.5">
                {handleReply && (
                  <button
                    type="button"
                    data-testid="reply-open"
                    onClick={(e) => {
                      e.stopPropagation();
                      setReplyOpen(true);
                    }}
                    className="cursor-pointer rounded-[4px] px-[5px] py-[3px] text-[11.5px] font-semibold text-muted hover:bg-elev hover:text-ink"
                  >
                    Reply
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                {showDecide && handleDecide ? (
                  <div data-testid="redline-decide" className="flex items-center gap-1.5">
                    <button
                      type="button"
                      data-testid="redline-reject"
                      disabled={deciding}
                      onClick={handleDecide("reject")}
                      className="cursor-pointer rounded-[4px] px-[5px] py-[3px] text-[11.5px] font-semibold text-error hover:bg-elev disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      data-testid="redline-accept"
                      disabled={deciding}
                      onClick={handleDecide("accept")}
                      className="cursor-pointer rounded-[4px] px-[5px] py-[3px] text-[11.5px] font-semibold text-success hover:bg-elev disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Accept
                    </button>
                  </div>
                ) : (
                  showResolveToggle &&
                  handleResolveToggle && (
                    <button
                      type="button"
                      data-testid="resolve-toggle"
                      disabled={toggling}
                      onClick={handleResolveToggle}
                      className="cursor-pointer rounded-[4px] px-[5px] py-[3px] text-[11.5px] font-semibold text-success hover:bg-elev disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {resolved ? "Reopen" : "Resolve"}
                    </button>
                  )
                )}
              </div>
            </div>
          )}
        </div>
      )}
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
