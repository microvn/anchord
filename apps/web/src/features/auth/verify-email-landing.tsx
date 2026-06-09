import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { sendVerificationEmail, verifyEmail } from "../../lib/auth-client";

// auth-ui S-001 VerifyEmailLanding (AS-003/AS-004) — the route the verification link opens.
//
// In the configured better-auth flow the email link is verified SERVER-SIDE: better-auth
// 302s here to the callbackURL on SUCCESS (clean `/verify-email`, no token) and to
// `/verify-email?error=…` on FAILURE (expired/tampered). So the success/failure signal is
// the `error` param, NOT token presence. We also still honor a `token` in the URL for the
// alternate client-verify flow (verifyEmail consumes it).
//   - `?error=…`           → recoverable "expired or invalid" state with resend, no crash (AS-004)
//   - clean redirect / ok  → "verified" success, with a link to proceed to sign in (AS-003)
//
// The live mail round-trip is [→E2E]; here the param→state machine + the verifyEmail seam
// (mocked) are what we assert.

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
      // AS-004: better-auth redirects a failed (expired/tampered) verification here with an
      // `error` param → the recoverable invalid state, never a crash.
      if (params.get("error")) {
        if (!cancelled) setStatus("invalid");
        return;
      }
      // AS-003: the success redirect arrives token-less (the link was verified server-side
      // and produced no error) → verified.
      if (!token) {
        if (!cancelled) setStatus("verified");
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
