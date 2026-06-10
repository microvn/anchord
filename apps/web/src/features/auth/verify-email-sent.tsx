import { useState } from "react";
import { Link } from "react-router-dom";
import { sendVerificationEmail } from "../../lib/auth-client";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/icon";
import { AuthCenter } from "./auth-shell";

// auth-ui S-001 VerifyEmailSent (AS-001) — the post-sign-up "check your inbox" state.
// Shows the address we sent to and a "resend" affordance that re-triggers the verification
// mail via better-auth. No session exists yet (requireEmailVerification), so there is
// nothing to navigate into — the user goes to their inbox.
//
// Visual: Anchord-Design VerifySent — a centered panel with a teal mail badge-icon.

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
    <AuthCenter>
      <div className="mx-auto mb-5 grid size-[52px] place-items-center rounded-lg bg-accent-soft text-accent-ink">
        <Icon name="mail" size={24} />
      </div>
      <h1
        className="font-serif text-[26px] font-medium tracking-tight text-ink"
        data-testid="verify-sent"
      >
        Check your email
      </h1>
      <p className="mt-2.5 text-sm leading-relaxed text-muted">
        We sent a verification link to <span className="font-medium text-ink">{email}</span>. Click
        it to activate your account — the link expires in 30 minutes.
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

      <div className="mt-6 flex justify-center gap-[9px]">
        <Button
          type="button"
          variant="secondary"
          data-testid="verify-resend"
          disabled={resending}
          onClick={() => void onResend()}
        >
          {resending ? "Resending…" : "Resend email"}
        </Button>
        <Button type="button" variant="ghost" asChild>
          <Link to="/signin">Back to sign in</Link>
        </Button>
      </div>
    </AuthCenter>
  );
}
