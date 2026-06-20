import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon";

// Comment textarea auto-grows with its content: at least MIN_ROWS tall (a comfortable starting box,
// matching the old fixed height), growing up to MAX_ROWS, then scrolling. Heights are derived from
// the element's own computed line-height/padding/border so it stays correct under the design tokens
// (and box-sizing: border-box — scrollHeight is the padding-box, so the border is added back).
const MIN_ROWS = 3;
const MAX_ROWS = 10;
function autoSizeTextarea(el: HTMLTextAreaElement): void {
  const cs = getComputedStyle(el);
  const line = parseFloat(cs.lineHeight) || 18;
  const vPad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const vBorder = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  const min = line * MIN_ROWS + vPad + vBorder;
  const max = line * MAX_ROWS + vPad + vBorder;
  el.style.height = "auto"; // reset first so scrollHeight reflects content (lets it SHRINK too)
  const next = Math.min(Math.max(el.scrollHeight + vBorder, min), max);
  el.style.height = `${next}px`;
  // Only show the scrollbar once content exceeds MAX_ROWS — below that the box grows, no scroll.
  el.style.overflowY = el.scrollHeight + vBorder > max ? "auto" : "hidden";
}

// Composer (S-001 + S-005): the in-rail compose box that appears once the user picks Comment on a
// selection. Mirrors the prototype `viewer.jsx` Composer: a PendingQuoteRef (the selected quote,
// rendered inert + cancelable), a plaintext textarea, and a Send button disabled until there's a
// body. Mounts at the TOP of the rail so the new thread reads top-down with the composer.
//
// C-008: the pending quote AND the typed body are UNTRUSTED strings rendered at the app origin —
// they go through React children (auto-escaped), never dangerouslySetInnerHTML, never interpreted
// as markdown. Comment bodies are PLAINTEXT in v0, so there is NO "Markdown supported" hint — a
// neutral hint is shown instead.
//
// S-005 (guest commenting): when the read side surfaces a guest session (`guest`), the composer
// shows a GuestNameField — a random "Anonymous <Animal>" name assigned for the session (AS-009)
// with a Rename control and an editable name input (length/charset-limited, C-008.T3). No email
// field (AS-017). Send is gated on a non-empty guest name (AS-011/C-007); the name rides to
// addComment alongside the body (AS-010). The FE only CONSUMES the guest flag — whether a guest can
// comment is decided by the anyone-with-link role, owned by sharing-permissions, not here.

// GUEST_NAMES — the "Anonymous <Animal>" pool (prototype `viewer-data.jsx`). One is assigned per
// session on open (AS-009); Rename cycles to the next.
export const GUEST_NAMES = [
  "Anonymous Dugong",
  "Anonymous Heron",
  "Anonymous Lynx",
  "Anonymous Marten",
  "Anonymous Otter",
  "Anonymous Petrel",
] as const;

/** Max stored/displayed guest-name length (C-008.T3: length-limited). */
export const GUEST_NAME_MAX = 40;

/** A random session display name for a guest (AS-009). */
export function randomGuestName(): string {
  return GUEST_NAMES[Math.floor(Math.random() * GUEST_NAMES.length)]!;
}

/** Rename → the NEXT name in the pool (deterministic cycle, like the prototype's Rename). */
export function nextGuestName(current: string): string {
  const i = GUEST_NAMES.indexOf(current as (typeof GUEST_NAMES)[number]);
  return GUEST_NAMES[(i + 1) % GUEST_NAMES.length]!;
}

/**
 * Input-time guest-name guard: strip angle brackets + control chars and clamp to GUEST_NAME_MAX,
 * but do NOT trim (so a user can type interior/trailing spaces while editing — "Anonymous Lynx").
 * The store/display value is still `sanitizeGuestName` (trimmed) when the comment is sent.
 */
function sanitizeGuestNameInput(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[<>\x00-\x1f\x7f]/g, "")
    .slice(0, GUEST_NAME_MAX);
}

/**
 * Make a guest-entered name safe to STORE and DISPLAY (C-008.T3): trim, strip angle brackets +
 * control characters (charset-limited — an inert plaintext label, never HTML), and truncate to
 * GUEST_NAME_MAX (over-long names truncated, AS-012.T2). Rendering is still done via React children
 * (auto-escaped); this is defence-in-depth at the value layer, not the only inertness guarantee.
 */
export function sanitizeGuestName(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[<>\x00-\x1f\x7f]/g, "")
    .trim()
    .slice(0, GUEST_NAME_MAX);
}

export function Composer({
  quote,
  pending,
  guest,
  initialBody,
  onSend,
  onCancel,
  dragHandleProps,
  dragging,
}: {
  /** the selected text, rendered inert (PendingQuoteRef). */
  quote: string;
  /** S-003 (C-003): pre-fill the body when the composer opens from a typed action (Like → "Looks
   *  good"). The user may edit or clear it before send (editable). Absent/empty → a plain Comment
   *  opens with an empty body. */
  initialBody?: string;
  /** true while the create write is in flight — disables Send (optimistic UI is in the rail). */
  pending?: boolean;
  /** S-005: this is a guest session (consumed from the read side). Shows the GuestNameField + gates
   *  Send on a non-empty name. Absent/false → a logged-in member: body-only send, no name field. */
  guest?: boolean;
  /** S-005: a guest passes its self-entered name up alongside the body (AS-010). No email (AS-017). */
  onSend: (body: string, guestIdentity?: { guestName: string }) => void;
  onCancel: () => void;
  /** #2 (2026-06-12): when the composer is a draggable inline popover, these props turn the quote-ref
   *  HEADER row into the drag handle (pointerdown grab — Plannotator-style, Apache-2.0). Absent for a
   *  non-draggable mount. */
  dragHandleProps?: React.HTMLAttributes<HTMLDivElement> & { "data-testid"?: string };
  /** #2: true while a drag is in progress → the handle shows `cursor: grabbing` instead of `grab`. */
  dragging?: boolean;
}) {
  // S-003 (C-003): seed the body from `initialBody` so a Like opens pre-filled "Looks good"
  // (editable). A plain Comment passes no initialBody → empty. The seed runs once on mount (the
  // composer is remounted per pending selection), so an edit isn't clobbered by a re-render.
  const [body, setBody] = useState(initialBody ?? "");
  // S-005: a random session name is assigned once on open (AS-009); the user may edit or Rename it.
  const [guestName, setGuestName] = useState(() => randomGuestName());
  const guestNameOk = !guest || sanitizeGuestName(guestName).length > 0;
  const canSend = body.trim().length > 0 && guestNameOk && !pending;

  // Autofocus the comment textarea when the composer opens, with the caret at the END so a
  // prefilled body (Like → "Looks good") is ready to append to. The composer remounts per pending
  // selection, so this fires on each open.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);

  // Auto-size on mount (covers a prefilled body, e.g. a Like) and after every keystroke. Layout
  // effect so the height is set BEFORE paint — no flicker as the box grows/shrinks.
  useLayoutEffect(() => {
    if (textareaRef.current) autoSizeTextarea(textareaRef.current);
  }, [body]);

  // Send the comment (S-005: guest sends sanitized name only — no email, AS-017; member sends body
  // only). Shared by the Send button AND the Shift+Enter key path. No-ops while !canSend (mirrors the
  // disabled button) so an early Shift+Enter can't post an empty/in-flight comment.
  const submit = () => {
    if (!canSend) return;
    if (guest) {
      onSend(body.trim(), { guestName: sanitizeGuestName(guestName) });
    } else {
      onSend(body.trim());
    }
  };

  return (
    <div
      data-testid="composer"
      className="rounded-md border border-accent bg-paper p-[11px] ring-[3px] ring-accent-soft"
    >
      {/* S-005 GuestNameField (guest only): a `?` avatar disc, the editable session name, and a
          Rename control that cycles the random pool (AS-009). NO email field (AS-017) — guest
          identity is the name only. The name is length/charset-limited on input (C-008.T3) — the
          value layer never holds HTML/control chars. Matches the prototype `.guest-id` look. */}
      {guest && (
        <div data-testid="guest-id" className="mb-[9px]">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="flex h-6 w-6 flex-none items-center justify-center rounded-full border border-line bg-sunken text-[12px] text-subtle"
            >
              ?
            </span>
            <input
              data-testid="guest-name"
              aria-label="Your name"
              value={guestName}
              maxLength={GUEST_NAME_MAX}
              onChange={(e) => setGuestName(sanitizeGuestNameInput(e.target.value))}
              placeholder="Your name"
              className="min-w-0 flex-1 rounded-[5px] border border-line bg-surface px-2 py-1 text-[12px] font-semibold text-ink outline-none focus:border-accent"
            />
            <button
              type="button"
              data-testid="guest-rename"
              onClick={() => setGuestName(nextGuestName(guestName))}
              className="flex-none cursor-pointer text-[11px] font-semibold text-accent hover:text-accent-strong"
            >
              Rename
            </button>
          </div>
        </div>
      )}

      {/* PendingQuoteRef + drag handle (#2): the HEADER row carries the inert quote, a close ✕, and
          — when mounted as a draggable inline popover — the drag handle. Grab the header (NOT the
          textarea, NOT the close button) to move the card (Plannotator-style card, Apache-2.0).
          The close button stopsPropagation so a click on ✕ never starts a drag. */}
      <div
        {...dragHandleProps}
        className={`mb-[9px] flex items-start gap-1.5${
          dragHandleProps ? (dragging ? " cursor-grabbing select-none" : " cursor-grab select-none") : ""
        }`}
      >
        <div
          data-testid="pending-quote"
          className="flex-1 border-l-2 border-accent py-px pl-[9px] text-[12px] italic leading-[1.45] text-muted"
        >
          {/* inert plaintext via React children (C-008) — never HTML/markdown. */}
          &ldquo;{quote}&rdquo;
        </div>
        <button
          type="button"
          data-testid="composer-cancel"
          aria-label="Cancel"
          onClick={onCancel}
          onPointerDown={(e) => e.stopPropagation()}
          className="flex-none cursor-pointer rounded-[5px] p-0.5 text-subtle hover:bg-sunken hover:text-ink"
        >
          <Icon name="x" size={13} />
        </button>
      </div>

      <textarea
        ref={textareaRef}
        data-testid="composer-input"
        aria-label="Comment"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        // Key binding (request 2026-06-20): Shift+Enter POSTS the comment; a plain Enter inserts a
        // newline (the textarea default — left to fall through). Note this is the REVERSE of the
        // common Enter-to-send convention — intentional here so multi-line comments type naturally.
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Add a comment"
        rows={MIN_ROWS}
        className="block w-full resize-none overflow-hidden rounded-[6px] border border-line bg-surface p-2 text-[12.5px] leading-[1.5] text-ink outline-none focus:border-accent"
      />

      <div className="mt-2 flex items-center justify-between gap-2">
        {/* Hint: "Name required" when a guest has no name yet (AS-011/C-007); otherwise the neutral
            plaintext hint — NOT "Markdown supported" (C-008: bodies are plaintext in v0). */}
        <span data-testid="composer-hint" className="text-[11px] text-subtle">
          {guest && !guestNameOk ? "Name required to comment" : "Plain text only"}
        </span>
        <button
          type="button"
          data-testid="composer-send"
          disabled={!canSend}
          onClick={submit}
          className="inline-flex cursor-pointer items-center rounded-[6px] bg-accent px-3 py-1 text-[12.5px] font-semibold text-on-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
