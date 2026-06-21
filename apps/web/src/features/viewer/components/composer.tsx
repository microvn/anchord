import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { autoSizeTextarea, DEFAULT_MIN_ROWS } from "@/features/viewer/lib/auto-size-textarea";

// Comment textarea auto-grows with its content (shared helper: at least 3 rows, growing to 10, then
// scrolling). The reply input reuses the same helper — see thread-card.tsx.

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
// S-007 (guest commenting, AS-017): when the read side surfaces a guest session (`guest`), the
// composer shows NO name field and NO email field. The guest's identity is the SESSION name owned by
// `useGuestIdentity` and shown in the top-bar `GuestIdentityChip` (AS-016); it is passed in here as
// `guestName` and rides up with the comment on send (the composer no longer owns or re-rolls the
// name). Send is gated on a non-empty body (and, for a guest, the session name — which the hook
// guarantees non-empty). The FE only CONSUMES the guest flag — whether a guest can comment is decided
// by the anyone-with-link link role, owned by sharing-permissions, not here.

// Guest session display name (AS-016): an `adjective-animal-suffix` handle — e.g. "swift-otter-k7m2".
// NO "Anonymous" prefix (dropped 2026-06-21). The random base36 suffix keeps two guests on one doc
// from colliding: ~50 adjectives × ~40 animals × 36^4 suffixes ≈ 4 billion combos, so a same-doc
// collision is effectively impossible for the handful of reviewers a v0 doc sees.
const GUEST_ADJECTIVES = [
  "swift", "brave", "quiet", "bold", "calm", "keen", "lucid", "merry", "nimble", "plucky",
  "rapid", "sly", "spry", "wry", "zesty", "amber", "azure", "coral", "ivory", "jade",
  "rust", "teal", "umber", "olive", "slate", "lunar", "solar", "misty", "frosty", "sunny",
  "dusky", "vivid", "gentle", "sharp", "sturdy", "wily", "agile", "breezy", "cozy", "fleet",
  "grand", "hardy", "jolly", "lush", "mellow", "noble", "perky", "sage", "trusty", "witty",
] as const;
const GUEST_ANIMALS = [
  "otter", "heron", "lynx", "marten", "petrel", "dugong", "ibex", "tapir", "civet", "vole",
  "gecko", "raven", "finch", "stoat", "shrew", "badger", "osprey", "marmot", "ferret", "kestrel",
  "wombat", "quokka", "narwhal", "puffin", "macaw", "lemur", "panther", "bison", "falcon", "heron",
  "weasel", "mongoose", "caracal", "serval", "okapi", "tapir", "pangolin", "axolotl", "capybara", "meerkat",
] as const;
const SUFFIX_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Max stored/displayed guest-name length (C-008.T3: length-limited). */
export const GUEST_NAME_MAX = 40;

function randomSuffix(len = 4): string {
  let s = "";
  for (let i = 0; i < len; i++) s += SUFFIX_ALPHABET[Math.floor(Math.random() * SUFFIX_ALPHABET.length)];
  return s;
}

/** A random low-collision session display name for a guest (AS-016): `adjective-animal-suffix`. */
export function randomGuestName(): string {
  const adj = GUEST_ADJECTIVES[Math.floor(Math.random() * GUEST_ADJECTIVES.length)]!;
  const animal = GUEST_ANIMALS[Math.floor(Math.random() * GUEST_ANIMALS.length)]!;
  return `${adj}-${animal}-${randomSuffix()}`;
}

/** Rename → re-roll to a DIFFERENT random name (AS-016; no fixed pool to cycle). */
export function nextGuestName(current: string): string {
  let next = randomGuestName();
  for (let i = 0; i < 5 && next === current; i++) next = randomGuestName();
  return next;
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
  guestName,
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
  /** S-007: this is a guest session (consumed from the read side). The composer shows NO name/email
   *  field (AS-017); the SESSION name rides up on send. Absent/false → a logged-in member: body-only. */
  guest?: boolean;
  /** S-007 (AS-016/017): the session-stable guest display name (from useGuestIdentity / the top-bar
   *  chip). Rides up with the comment on send when `guest` is true. Ignored for a member. */
  guestName?: string;
  /** S-007 (AS-017): a guest send carries the session name up alongside the body. No email. */
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
  // S-007 (AS-017): the composer no longer owns the guest name — it is the SESSION name from the
  // top-bar chip (useGuestIdentity), passed in as `guestName` and guaranteed non-empty for a guest.
  // Send is gated on a non-empty body (and, for a guest, the session name); no in-composer name input.
  const guestNameOk = !guest || (guestName ?? "").trim().length > 0;
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
    // S-007 (AS-017): a guest carries the SESSION name (sanitized-safe at the source); a member sends
    // body-only. The session name is guaranteed non-empty by the gate above.
    if (guest) {
      onSend(body.trim(), { guestName: sanitizeGuestName(guestName ?? "") });
    } else {
      onSend(body.trim());
    }
  };

  return (
    <div
      data-testid="composer"
      className="rounded-md border border-accent bg-paper p-[11px] ring-[3px] ring-accent-soft"
    >
      {/* S-007 (AS-017): NO guest name/email field here — the guest's identity is the session name
          from the top-bar GuestIdentityChip (useGuestIdentity), which rides up on send. */}

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
        rows={DEFAULT_MIN_ROWS}
        className="block w-full resize-none overflow-hidden rounded-[6px] border border-line bg-surface p-2 text-[12.5px] leading-[1.5] text-ink outline-none focus:border-accent"
      />

      <div className="mt-2 flex items-center justify-between gap-2">
        {/* Hint: the neutral plaintext hint — NOT "Markdown supported" (C-008: bodies are plaintext
            in v0). S-007: a guest's session name is supplied by the header chip, so there is no more
            "name required" state in the composer. */}
        <span data-testid="composer-hint" className="text-[11px] text-subtle">
          Plain text only
        </span>
        <button
          type="button"
          data-testid="composer-send"
          disabled={!canSend}
          onClick={submit}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-[6px] bg-accent px-3 py-1 text-[12.5px] font-semibold text-on-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {/* Shift+Enter send hint (the key path is wired on the textarea above) — decorative, the
              accessible label stays "Send". */}
          <span className="inline-flex items-center gap-0.5 opacity-80" aria-hidden="true">
            <Icon name="shift" size={13} />
            <Icon name="cornerDownLeft" size={13} />
          </span>
          {pending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
