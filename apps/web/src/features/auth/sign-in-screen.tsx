import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "./zod-resolver";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";
import { signIn, sendVerificationEmail, getSession, useSession } from "../../lib/auth-client";
import { OAuthButtons } from "./oauth-buttons";
import { OAuthErrorBanner } from "./oauth-error-banner";
import { AuthAside } from "./auth-aside";
import { Brandmark, Icon } from "../../components/icon";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";

// SignInScreen — web-core built the email+password sign-in; auth-ui EXTENDS it with:
//  - the verify-first state of AS-002 / C-001 (a sign-in attempt on an UNVERIFIED account
//    is refused with a DISTINCT "verify your email first" message + resend, never a generic
//    wrong-password error),
//  - the OAuthButtons (only enabled providers — AS-007),
//  - the OAuthErrorBanner driven by ?error=… set when better-auth redirected back after a
//    denied/failed OAuth callback (AS-008).
// Visual: the Anchord-Design two-pane auth layout (form card + AuthAside brand pane). The
// primitives are shadcn (Button/Input/Label, themed teal); the layout/visual is the design CSS.
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
      <main className="auth-center">
        <div className="auth-panel">
          <div className="badge-icon">
            <Icon name="mail" size={24} />
          </div>
          <h1 data-testid="verify-first">Verify your email first</h1>
          <p className="pmsg">
            You need to verify <span className="strong">{unverifiedEmail}</span> before you can
            sign in. Check your inbox for the link.
          </p>
          <div className="pactions">
            <Button type="button" variant="secondary" data-testid="verify-first-resend" onClick={() => void onResend()}>
              Resend verification email
            </Button>
            <Button type="button" variant="ghost" onClick={() => setUnverifiedEmail(null)}>
              Back to sign in
            </Button>
          </div>
          {resent && (
            <p className="pnote" data-testid="verify-first-resent">
              Verification email sent.
            </p>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="auth">
      <div className="auth-pane">
        <div className="auth-card">
          <div className="auth-brand">
            <Brandmark size={22} />
            <span className="anchord-brand-name">anchord</span>
          </div>
          <h1 className="auth-title">Sign in</h1>
          <p className="auth-sub">Welcome back. Sign in to your workspace.</p>

          <div className="auth-form">
            {/* AS-008: render the OAuth failure banner when ?error=… is present. */}
            <OAuthErrorBanner code={oauthError} />
            {/* AS-006/AS-007: provider buttons (only enabled ones). Renders nothing if none. */}
            <OAuthButtons />

            <form className="auth-fields" onSubmit={handleSubmit(onSubmit)} noValidate>
              <div className="auth-field">
                <Label htmlFor="email" className="field-label">
                  Email
                </Label>
                <Input id="email" type="email" autoComplete="email" placeholder="name@company.com" {...register("email")} />
                {errors.email && (
                  <p className="field-err" role="alert">
                    {errors.email.message}
                  </p>
                )}
              </div>

              <div className="auth-field">
                <Label htmlFor="password" className="field-label">
                  Password
                </Label>
                <Input id="password" type="password" autoComplete="current-password" placeholder="••••••••" {...register("password")} />
                {errors.password && (
                  <p className="field-err" role="alert">
                    {errors.password.message}
                  </p>
                )}
              </div>

              {formError && (
                <p className="auth-error" role="alert" data-testid="signin-error">
                  {formError}
                </p>
              )}

              <Button type="submit" size="lg" disabled={isSubmitting} className="w-full">
                {isSubmitting ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          </div>

          <p className="auth-foot">
            Don&rsquo;t have an account?{" "}
            <Link to="/signup" className="auth-link">
              Sign up
            </Link>
          </p>
        </div>
      </div>
      <AuthAside />
    </main>
  );
}
