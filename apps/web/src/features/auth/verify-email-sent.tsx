import { useState } from "react";
import { Link } from "react-router-dom";
import { sendVerificationEmail } from "../../lib/auth-client";
import { Icon } from "../../components/icon";
import { Button } from "../../components/ui/button";

// auth-ui S-001 VerifyEmailSent (AS-001) — the post-sign-up "check your inbox" state.
// Shows the address we sent to and a "resend" affordance that re-triggers the verification
// mail via better-auth. No session exists yet (requireEmailVerification), so there is
// nothing to navigate into — the user goes to their inbox.
// Visual: the Anchord-Design centered "VerifySent" panel (mail badge + actions).

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
    <main className="auth-center">
      <div className="auth-panel">
        <div className="badge-icon">
          <Icon name="mail" size={24} />
        </div>
        <h1 data-testid="verify-sent">Check your inbox</h1>
        <p className="pmsg">
          We sent a verification link to <span className="strong">{email}</span>. Click it to
          activate your account — the link expires in 30 minutes.
        </p>

        {error && (
          <p role="alert" className="pnote" style={{ color: "var(--red)" }}>
            {error}
          </p>
        )}
        {resent && (
          <p className="pnote" data-testid="verify-resent">
            Verification email sent again.
          </p>
        )}

        <div className="pactions">
          <Button type="button" variant="secondary" data-testid="verify-resend" disabled={resending} onClick={() => void onResend()}>
            {resending ? "Resending…" : "Resend email"}
          </Button>
          <Button asChild variant="ghost">
            <Link to="/signin">Back to sign in</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
