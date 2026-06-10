import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "./zod-resolver";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";
import { signIn, sendVerificationEmail, getSession, useSession } from "../../lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AuthShell,
  AuthCenter,
  authTitleClass,
  authSubClass,
  authLabelClass,
  authInputClass,
  authSubmitClass,
  authFootClass,
} from "./auth-shell";
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
  // AS-002: after a successful sign-in we wait for the better-auth session to COMMIT before
  // redirecting. The race we fix: navigate("/") fired the instant signIn.email resolved, but
  // the session store hadn't updated yet, so the AuthGuard read no session and bounced back to
  // /signin. We refetch the session (getSession, below) and drive the redirect off an effect
  // watching the SAME reactive session the guard reads — so the redirect only lands once the
  // guard would admit it (deterministic, no setTimeout).
  const [signedIn, setSignedIn] = useState(false);
  const { data: session } = useSession();

  useEffect(() => {
    if (signedIn && session) {
      navigate("/", { replace: true });
    }
  }, [signedIn, session, navigate]);
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
    // Force the better-auth session store to refresh from the just-set cookie, THEN flag
    // signedIn. The effect above redirects once useSession reflects the session — the same
    // store the AuthGuard reads, so there's no window where the guard sees no session.
    await getSession();
    setSignedIn(true);
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
      <AuthCenter>
        <h1
          className="font-serif text-[26px] font-medium tracking-tight text-ink"
          data-testid="verify-first"
        >
          Verify your email first
        </h1>
        <p className="mt-2.5 text-sm leading-relaxed text-muted">
          You need to verify <span className="font-medium text-ink">{unverifiedEmail}</span> before
          you can sign in. Check your inbox for the link.
        </p>
        <div className="mt-6 flex justify-center gap-[9px]">
          <Button
            type="button"
            variant="secondary"
            data-testid="verify-first-resend"
            onClick={() => void onResend()}
          >
            Resend verification email
          </Button>
        </div>
        {resent && (
          <p className="mt-3 text-sm text-muted" data-testid="verify-first-resent">
            Verification email sent.
          </p>
        )}
        <p className="mt-6 text-sm text-muted">
          <button
            type="button"
            onClick={() => setUnverifiedEmail(null)}
            className="font-semibold text-accent-ink hover:underline"
          >
            Back to sign in
          </button>
        </p>
      </AuthCenter>
    );
  }

  return (
    <AuthShell>
      <h1 className={authTitleClass}>Sign in</h1>
      <p className={authSubClass}>Welcome back. Sign in to your workspace.</p>

      <div className="mt-[26px] flex flex-col gap-3.5">
        {/* AS-008: render the OAuth failure banner when ?error=… is present. */}
        <OAuthErrorBanner code={oauthError} />

        {/* AS-007: OAuth row renders above the form (only enabled providers, with the divider). */}
        <OAuthButtons />

        <form className="flex flex-col gap-3.5" onSubmit={handleSubmit(onSubmit)} noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email" className={authLabelClass}>
              Email
            </Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              className={authInputClass}
              {...register("email")}
            />
            {errors.email && (
              <p className="text-xs text-error" role="alert">
                {errors.email.message}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password" className={authLabelClass}>
              Password
            </Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              className={authInputClass}
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

          <Button type="submit" size="lg" disabled={isSubmitting} className={authSubmitClass}>
            {isSubmitting ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </div>

      <p className={authFootClass}>
        Don't have an account?{" "}
        <Link to="/signup" className="font-semibold text-accent-ink hover:underline">
          Sign up
        </Link>
      </p>
    </AuthShell>
  );
}
