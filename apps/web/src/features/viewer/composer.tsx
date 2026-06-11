import { useState } from "react";
import { Icon } from "../../components/icon";

// Composer (S-001): the in-rail compose box that appears once the user picks Comment on a
// selection. Mirrors the prototype `viewer.jsx` Composer: a PendingQuoteRef (the selected quote,
// rendered inert + cancelable), a plaintext textarea, and a Send button disabled until there's a
// body. Mounts at the TOP of the rail so the new thread reads top-down with the composer.
//
// C-008: the pending quote AND the typed body are UNTRUSTED strings rendered at the app origin —
// they go through React children (auto-escaped), never dangerouslySetInnerHTML, never interpreted
// as markdown. Comment bodies are PLAINTEXT in v0, so there is NO "Markdown supported" hint — a
// neutral hint is shown instead.

export function Composer({
  quote,
  pending,
  onSend,
  onCancel,
}: {
  /** the selected text, rendered inert (PendingQuoteRef). */
  quote: string;
  /** true while the create write is in flight — disables Send (optimistic UI is in the rail). */
  pending?: boolean;
  onSend: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const canSend = body.trim().length > 0 && !pending;

  return (
    <div
      data-testid="composer"
      className="rounded-md border border-accent bg-paper p-[11px] ring-[3px] ring-accent-soft"
    >
      {/* PendingQuoteRef — inert, cancelable. Same .quote-ref look as a thread's quote. */}
      <div className="mb-[9px] flex items-start gap-1.5">
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
          className="flex-none rounded-[5px] p-0.5 text-subtle hover:bg-sunken hover:text-ink"
        >
          <Icon name="x" size={13} />
        </button>
      </div>

      <textarea
        data-testid="composer-input"
        aria-label="Comment"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Add a comment"
        rows={3}
        className="block w-full resize-none rounded-[6px] border border-line bg-surface p-2 text-[12.5px] leading-[1.5] text-ink outline-none focus:border-accent"
      />

      <div className="mt-2 flex items-center justify-between gap-2">
        {/* Neutral hint — NOT "Markdown supported" (C-008: bodies are plaintext in v0). */}
        <span data-testid="composer-hint" className="text-[11px] text-subtle">
          Plain text only
        </span>
        <button
          type="button"
          data-testid="composer-send"
          disabled={!canSend}
          onClick={() => {
            if (!canSend) return;
            onSend(body.trim());
          }}
          className="inline-flex items-center rounded-[6px] bg-accent px-3 py-1 text-[12.5px] font-semibold text-on-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
