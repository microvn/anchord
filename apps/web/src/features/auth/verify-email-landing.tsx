import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { sendVerificationEmail, verifyEmail } from "../../lib/auth-client";

// auth-ui S-001 VerifyEmailLanding (AS-003/AS-004) — the route the verification link opens
// (`/verify-email?token=…`). On mount it consumes the token via better-auth's verifyEmail.
//   - valid token   → "verified" success, with a link to proceed to sign in / the app (AS-003)
//   - expired/bad    → a recoverable "expired or invalid" state with a resend, NOT a crash (AS-004)
//
// The live mail round-trip is [→E2E]; here the verifyEmail call is the unit-tested seam
// (mocked) and the state machine (verifying → verified | invalid) is what we assert.

type Status = "verifying" | "verified" | "invalid";

export function VerifyEmailLanding() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const [status, setStatus] = useState<Status>("verifying");
  // Resend state for the AS-004 recovery path.
  const [resendEmail, setResendEmail] = useState("");
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  // Guard against React 18/19 StrictMode double-invoke firing verifyEmail twice.
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    let cancelled = false;
    async function run() {
      // AS-004: a link with no token at all is invalid (recoverable), never a crash.
      // NOTE (spec signal): better-auth verifies the email link SERVER-SIDE and 302s to
      // callbackURL WITHOUT a token, so in the real flow this landing is reached
      // token-less as a SUCCESS. That contradicts AS-004's "no token → invalid". Left as
      // spec-defined for now; see the report's spec-signal note.
      if (!token) {
        if (!cancelled) setStatus("invalid");
        return;
      }
      try {
        const res = await verifyEmail({ query: { token } });
        if (cancelled) return;
        // AS-003 vs AS-004: any error (expired / tampered) → recoverable invalid state.
        setStatus(res?.error ? "invalid" : "verified");
      } catch {
        // A thrown failure must still land on the recoverable state, not a crash (AS-004).
        if (!cancelled) setStatus("invalid");
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function onResend() {
    if (!resendEmail) return;
    setResending(true);
    setResent(false);
    const res = await sendVerificationEmail({ email: resendEmail, callbackURL: "/signin" });
    setResending(false);
    if (!res?.error) setResent(true);
  }

  if (status === "verifying") {
    return (
      <main className="min-h-full grid place-items-center px-4 py-12">
        <p className="text-sm text-muted" data-testid="verify-verifying">
          Verifying your email…
        </p>
      </main>
    );
  }

  if (status === "verified") {
    return (
      <main className="min-h-full grid place-items-center px-4 py-12">
        <div className="w-full max-w-sm text-center">
          <h1 className="font-serif text-2xl tracking-tight text-ink" data-testid="verify-success">
            Email verified
          </h1>
          <p className="mt-2 text-sm text-muted">Your account is ready. You can sign in now.</p>
          <Link
            to="/signin"
            data-testid="verify-proceed"
            className="mt-6 inline-flex min-h-[40px] items-center rounded-md bg-accent px-5 text-sm font-medium text-on-accent hover:bg-accent-strong"
          >
            Continue to sign in
          </Link>
        </div>
      </main>
    );
  }

  // status === "invalid" — AS-004 recoverable error + resend.
  return (
    <main className="min-h-full grid place-items-center px-4 py-12">
      <div className="w-full max-w-sm text-center">
        <h1 className="font-serif text-2xl tracking-tight text-ink" data-testid="verify-invalid">
          Link expired or invalid
        </h1>
        <p className="mt-2 text-sm text-muted">
          This verification link is no longer valid. Enter your email to get a fresh one.
        </p>

        <div className="mt-6 flex flex-col gap-3">
          <input
            type="email"
            aria-label="Email"
            placeholder="you@example.com"
            value={resendEmail}
            onChange={(e) => setResendEmail(e.target.value)}
            className="min-h-[40px] rounded-md border border-line bg-surface px-3 text-ink outline-none focus:border-accent"
          />
          <button
            type="button"
            data-testid="verify-resend"
            disabled={resending || !resendEmail}
            onClick={() => void onResend()}
            className="min-h-[40px] rounded-md bg-accent px-4 text-sm font-medium text-on-accent hover:bg-accent-strong disabled:opacity-60"
          >
            {resending ? "Sending…" : "Resend verification email"}
          </button>
          {resent && (
            <p className="text-sm text-muted" data-testid="verify-resent">
              Sent. Check your inbox.
            </p>
          )}
        </div>

        <p className="mt-6 text-sm text-muted">
          <Link to="/signin" className="text-accent hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
