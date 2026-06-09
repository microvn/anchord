import { useState } from "react";
import { Link } from "react-router-dom";
import { sendVerificationEmail } from "../../lib/auth-client";

// auth-ui S-001 VerifyEmailSent (AS-001) — the post-sign-up "check your inbox" state.
// Shows the address we sent to and a "resend" affordance that re-triggers the verification
// mail via better-auth. No session exists yet (requireEmailVerification), so there is
// nothing to navigate into — the user goes to their inbox.

export function VerifyEmailSent({ email }: { email: string }) {
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onResend() {
    setResending(true);
    setError(null);
    setResent(false);
    const res = await sendVerificationEmail({ email, callbackURL: "/signin" });
    setResending(false);
    if (res?.error) {
      setError(res.error.message ?? "Could not resend. Please try again.");
      return;
    }
    setResent(true);
  }

  return (
    <main className="min-h-full grid place-items-center px-4 py-12">
      <div className="w-full max-w-sm text-center">
        <h1 className="font-serif text-2xl tracking-tight text-ink" data-testid="verify-sent">
          Check your inbox
        </h1>
        <p className="mt-2 text-sm text-muted">
          We sent a verification link to <span className="text-ink">{email}</span>. Open it to
          finish setting up your account.
        </p>

        {error && (
          <p role="alert" className="mt-3 text-sm text-error">
            {error}
          </p>
        )}
        {resent && (
          <p className="mt-3 text-sm text-muted" data-testid="verify-resent">
            Verification email sent again.
          </p>
        )}

        <button
          type="button"
          data-testid="verify-resend"
          disabled={resending}
          onClick={() => void onResend()}
          className="mt-6 min-h-[40px] rounded-md border border-line bg-surface px-4 text-sm text-ink hover:border-accent disabled:opacity-60"
        >
          {resending ? "Resending…" : "Resend verification email"}
        </button>

        <p className="mt-6 text-sm text-muted">
          <Link to="/signin" className="text-accent hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
