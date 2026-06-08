import { GENERIC_MESSAGE } from "../lib/api-error";

// S-002 / AS-007: the ONE retryable error surface every screen reuses. A screen whose data
// request fails renders this instead of crashing or going blank — a message plus a Retry
// control that re-runs the query (the caller passes the query's `refetch`). web-core owns it
// so feature screens don't each hand-roll an error box. Dark-operator tokens, teal accent.
export function ErrorState({
  message,
  onRetry,
  retrying = false,
}: {
  message?: string | null;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  // No message → a generic fallback so the surface is never blank (edge case).
  const text = message && message.trim() ? message : GENERIC_MESSAGE;

  return (
    <div
      role="alert"
      className="mx-auto flex max-w-sm flex-col items-center gap-3 px-4 py-10 text-center"
    >
      <p className="text-sm text-error">{text}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="min-h-[40px] rounded-md border border-line bg-surface px-4 text-sm font-medium text-ink hover:border-accent disabled:opacity-60"
        >
          {retrying ? "Retrying…" : "Retry"}
        </button>
      )}
    </div>
  );
}
