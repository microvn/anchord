import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { sendVerificationEmail, verifyEmail } from "@/lib/api/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/icon";
import { AuthCenter } from "./auth-shell";

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
// (mocked) are what we assert. Visual: Anchord-Design VerifyLanding (shield badge) and
// VerifyExpired (alert badge).

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
      <AuthCenter>
        <p className="text-sm text-muted" data-testid="verify-verifying">
          Verifying your email…
        </p>
      </AuthCenter>
    );
  }

  if (status === "verified") {
    return (
      <AuthCenter>
        <div className="mx-auto mb-5 grid size-[52px] place-items-center rounded-lg bg-accent-soft text-accent-ink">
          <Icon name="shield" size={24} />
        </div>
        <h1
          className="font-serif text-[26px] font-medium tracking-tight text-ink"
          data-testid="verify-success"
        >
          Email verified
        </h1>
        <p className="mt-2.5 text-sm leading-relaxed text-muted">
          Your account is active. Welcome to anchord — you can sign in now.
        </p>
        <div className="mt-6 flex justify-center">
          <Button size="lg" data-testid="verify-proceed" asChild>
            <Link to="/signin">
              Continue
              <Icon name="arrowRight" size={16} />
            </Link>
          </Button>
        </div>
      </AuthCenter>
    );
  }

  // status === "invalid" — AS-004 recoverable error + resend.
  return (
    <AuthCenter>
      <div className="mx-auto mb-5 grid size-[52px] place-items-center rounded-lg bg-error/15 text-error">
        <Icon name="alert" size={24} />
      </div>
      <h1
        className="font-serif text-[26px] font-medium tracking-tight text-ink"
        data-testid="verify-invalid"
      >
        Link expired or invalid
      </h1>
      <p className="mt-2.5 text-sm leading-relaxed text-muted">
        This verification link is no longer valid. Enter your email to get a fresh one.
      </p>

      <div className="mx-auto mt-6 flex max-w-[300px] flex-col gap-3">
        <Input
          type="email"
          aria-label="Email"
          placeholder="you@example.com"
          value={resendEmail}
          onChange={(e) => setResendEmail(e.target.value)}
        />
        <Button
          type="button"
          size="lg"
          data-testid="verify-resend"
          disabled={resending || !resendEmail}
          onClick={() => void onResend()}
        >
          {resending ? "Sending…" : "Send a new link"}
        </Button>
        {resent && (
          <p className="text-sm text-muted" data-testid="verify-resent">
            Sent. Check your inbox.
          </p>
        )}
      </div>

      <p className="mt-6 text-sm text-muted">
        <Link to="/signin" className="font-semibold text-accent-ink hover:underline">
          Back to sign in
        </Link>
      </p>
    </AuthCenter>
  );
}
