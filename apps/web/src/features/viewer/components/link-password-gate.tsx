import { useState, type FormEvent } from "react";
import { Icon } from "@/components/icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// LinkPasswordGate (capability-share-link S-006 / AS-017 / AS-018) — the password challenge a
// visitor sees when the capability link they opened is password-protected. It is shown IN PLACE
// of the viewer until a correct password is accepted; after that the redeem succeeds, the
// admission cookie carries the password-cleared marker, and the doc renders WITHOUT this gate
// re-appearing for the rest of the session (AS-017 — the parent stops rendering the gate).
//
// AS-018: a wrong password is reported inline and the visitor can retry; once the server has
// throttled the attempts (HTTP 429) the parent passes `rateLimited`, and the gate disables submit
// and explains the back-off. This component does NOT itself talk to the network — the parent
// (CapabilityRedeemScreen) owns the redeem call and feeds the outcome back as props, so the gate
// stays a pure controlled form (testable in isolation, no fetch mock needed).
//
// Chrome recedes (DESIGN.md): a centered low-chrome panel, the single teal accent on the submit
// button only. Responsive — a max-width centered column that holds at 360/768/1024/1440.

export function LinkPasswordGate({
  /** Invoked with the entered password when the visitor submits (parent runs the redeem). */
  onSubmit,
  /** True while the parent's redeem is in flight — disables the form + shows a working state. */
  submitting = false,
  /** Set after a wrong password (AS-018) — shows the inline error and keeps the field focused. */
  error,
  /** Set once the server throttles repeated wrong tries (HTTP 429, AS-018) — disables submit. */
  rateLimited = false,
}: {
  onSubmit: (password: string) => void;
  submitting?: boolean;
  error?: string;
  rateLimited?: boolean;
}) {
  const [password, setPassword] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting || rateLimited || password.length === 0) return;
    onSubmit(password);
  }

  return (
    <div className="flex h-dvh items-center justify-center bg-paper px-4 text-ink">
      <form
        data-testid="link-password-gate"
        onSubmit={handleSubmit}
        className="mx-auto flex w-full max-w-sm flex-col items-center gap-3 text-center"
      >
        <span
          aria-hidden="true"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-elev text-muted"
        >
          <Icon name="shield" size={20} />
        </span>
        <p className="font-serif text-base text-ink">This link is password-protected</p>
        <p className="text-sm text-muted">Enter the password to open the document.</p>

        <label htmlFor="link-password" className="sr-only">
          Password
        </label>
        <Input
          id="link-password"
          data-testid="link-password-input"
          type="password"
          autoFocus
          autoComplete="off"
          value={password}
          disabled={submitting || rateLimited}
          aria-invalid={error != null}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1"
        />

        {rateLimited ? (
          <p data-testid="link-password-rate-limited" role="alert" className="text-sm text-destructive">
            Too many attempts. Please wait a moment and try again.
          </p>
        ) : error ? (
          <p data-testid="link-password-error" role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <Button
          type="submit"
          data-testid="link-password-submit"
          className="mt-1 w-full"
          disabled={submitting || rateLimited || password.length === 0}
        >
          {submitting ? "Checking…" : "Open document"}
        </Button>
      </form>
    </div>
  );
}
