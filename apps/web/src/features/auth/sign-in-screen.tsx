import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "./zod-resolver";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";
import { signIn, sendVerificationEmail } from "../../lib/auth-client";
import { OAuthButtons } from "./oauth-buttons";
import { OAuthErrorBanner } from "./oauth-error-banner";

// SignInScreen — web-core built the email+password sign-in; auth-ui EXTENDS it with:
//  - the verify-first state of AS-002 / C-001 (a sign-in attempt on an UNVERIFIED account
//    is refused with a DISTINCT "verify your email first" message + resend, never a generic
//    wrong-password error),
//  - the OAuthButtons (only enabled providers — AS-007),
//  - the OAuthErrorBanner driven by ?error=… set when better-auth redirected back after a
//    denied/failed OAuth callback (AS-008).
const schema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Enter your password"),
});
type Values = z.infer<typeof schema>;

// better-auth's error code for "the account exists but its email isn't verified". We branch
// on this (or a message match as a fallback) to show the verify-first state, NOT a credential
// error (C-001).
const EMAIL_UNVERIFIED_CODE = "EMAIL_NOT_VERIFIED";

export function SignInScreen() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // AS-008: better-auth appended ?error=… when it returned from a failed OAuth callback.
  const oauthError = params.get("error");

  const [formError, setFormError] = useState<string | null>(null);
  // AS-002/C-001: when sign-in is refused because the email isn't verified, we show a distinct
  // verify-first state (with resend) keyed off the attempted email — never a credential error.
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  async function onSubmit(values: Values) {
    setFormError(null);
    setUnverifiedEmail(null);
    setResent(false);
    const res = await signIn.email({ email: values.email, password: values.password });
    if (res?.error) {
      const code = res.error.code ?? "";
      const msg = res.error.message ?? "";
      // C-001/AS-002: distinguish "not verified" from "wrong credentials". An unverified
      // account gets the verify-first state; everything else stays a credential error.
      if (code === EMAIL_UNVERIFIED_CODE || /verif/i.test(msg)) {
        setUnverifiedEmail(values.email);
        return;
      }
      setFormError(msg || "Sign in failed. Check your credentials.");
      return;
    }
    navigate("/", { replace: true });
  }

  async function onResend() {
    if (!unverifiedEmail) return;
    const res = await sendVerificationEmail({ email: unverifiedEmail, callbackURL: "/signin" });
    if (!res?.error) setResent(true);
  }

  // AS-002/C-001: the verify-first state. DISTINCT copy ("verify your email first"), not a
  // generic wrong-password error, with a way to resend.
  if (unverifiedEmail) {
    return (
      <main className="min-h-full grid place-items-center px-4 py-12">
        <div className="w-full max-w-sm text-center">
          <h1 className="font-serif text-2xl tracking-tight text-ink" data-testid="verify-first">
            Verify your email first
          </h1>
          <p className="mt-2 text-sm text-muted">
            You need to verify <span className="text-ink">{unverifiedEmail}</span> before you can
            sign in. Check your inbox for the link.
          </p>
          <button
            type="button"
            data-testid="verify-first-resend"
            onClick={() => void onResend()}
            className="mt-6 min-h-[40px] rounded-md border border-line bg-surface px-4 text-sm text-ink hover:border-accent"
          >
            Resend verification email
          </button>
          {resent && (
            <p className="mt-3 text-sm text-muted" data-testid="verify-first-resent">
              Verification email sent.
            </p>
          )}
          <p className="mt-6 text-sm text-muted">
            <button
              type="button"
              onClick={() => setUnverifiedEmail(null)}
              className="text-accent hover:underline"
            >
              Back to sign in
            </button>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-full grid place-items-center px-4 py-12">
      <div className="w-full max-w-sm">
        <h1 className="font-serif text-3xl tracking-tight text-ink">anchord</h1>
        <p className="mt-1 text-sm text-muted">Sign in to your workspace.</p>

        <div className="mt-8">
          {/* AS-008: render the OAuth failure banner when ?error=… is present. */}
          <OAuthErrorBanner code={oauthError} />

          <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)} noValidate>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="email" className="text-sm text-muted">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                className="min-h-[40px] rounded-md border border-line bg-surface px-3 text-ink outline-none focus:border-accent"
                {...register("email")}
              />
              {errors.email && (
                <p className="text-xs text-error" role="alert">
                  {errors.email.message}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="password" className="text-sm text-muted">
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                className="min-h-[40px] rounded-md border border-line bg-surface px-3 text-ink outline-none focus:border-accent"
                {...register("password")}
              />
              {errors.password && (
                <p className="text-xs text-error" role="alert">
                  {errors.password.message}
                </p>
              )}
            </div>

            {formError && (
              <p className="text-sm text-error" role="alert" data-testid="signin-error">
                {formError}
              </p>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="min-h-[40px] rounded-md bg-accent px-4 font-medium text-on-accent hover:bg-accent-strong disabled:opacity-60"
            >
              {isSubmitting ? "Signing in…" : "Sign in"}
            </button>
          </form>

          <OAuthButtons />

          <p className="mt-6 text-center text-sm text-muted">
            New to anchord?{" "}
            <Link to="/signup" className="text-accent hover:underline">
              Create an account
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
