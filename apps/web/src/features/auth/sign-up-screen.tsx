import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "./zod-resolver";
import { Link } from "react-router-dom";
import { z } from "zod";
import { signUp } from "../../lib/auth-client";
import { VerifyEmailSent } from "./verify-email-sent";
import { OAuthButtons } from "./oauth-buttons";
import { AuthAside } from "./auth-aside";
import { Brandmark } from "../../components/icon";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";

// auth-ui S-001 SignUpScreen — email + password (≥8) → "check your inbox" (AS-001); an
// already-registered email stays on this screen with an "email already in use" error
// (AS-005). No token is stored client-side: better-auth manages the session as an httpOnly
// cookie, and with requireEmailVerification a fresh sign-up has NO session yet (C-003).
// OAuthButtons (only enabled providers) are reused here too.
// Visual: the Anchord-Design two-pane auth layout (form card + AuthAside), shadcn primitives.

// C-001/AS-001: password must be at least 8 characters (mirrors the backend
// minPasswordLength). Validate on the client so the user gets the rule before submit.
const schema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});
type Values = z.infer<typeof schema>;

export function SignUpScreen() {
  const [formError, setFormError] = useState<string | null>(null);
  // Once sign-up succeeds we flip to the "check your inbox" state (with resend), keeping the
  // email so VerifyEmailSent can resend to it. We never navigate into the app — there is no
  // session until the email is verified (C-003).
  const [sentTo, setSentTo] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  async function onSubmit(values: Values) {
    setFormError(null);
    const res = await signUp.email({
      email: values.email,
      password: values.password,
      name: values.email,
      // AS-003: better-auth verifies the email link SERVER-SIDE then redirects to
      // callbackURL resolved against the link's origin (the backend). Pass an ABSOLUTE URL
      // to the SPA's own verified-landing so the user lands on the app, not the backend's
      // raw API response. Origin-relative to window.location.origin → correct in dev (the
      // :5173 dev server is a trusted origin) and prod (same origin).
      callbackURL:
        typeof window !== "undefined"
          ? `${window.location.origin}/verify-email`
          : "/verify-email",
    });
    if (res?.error) {
      // AS-005: an already-registered email is refused; better-auth returns an error and we
      // stay on this screen. We surface a clear "email already in use" message for the known
      // duplicate code, else the server message / a safe fallback.
      const code = res.error.code ?? "";
      const message =
        code === "USER_ALREADY_EXISTS" || /exist|already|registered|use/i.test(res.error.message ?? "")
          ? "That email is already in use. Try signing in instead."
          : (res.error.message ?? "Sign up failed. Please try again.");
      setFormError(message);
      return;
    }
    // AS-001: account created, verification mail sent → show the "check your inbox" state.
    setSentTo(values.email);
  }

  if (sentTo) {
    return <VerifyEmailSent email={sentTo} />;
  }

  return (
    <main className="auth">
      <div className="auth-pane">
        <div className="auth-card">
          <div className="auth-brand">
            <Brandmark size={22} />
            <span className="anchord-brand-name">anchord</span>
          </div>
          <h1 className="auth-title">Create your account</h1>
          <p className="auth-sub">Set up your first workspace in seconds.</p>

          <div className="auth-form">
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
                <Input id="password" type="password" autoComplete="new-password" placeholder="Create a password" {...register("password")} />
                {errors.password && (
                  <p className="field-err" role="alert">
                    {errors.password.message}
                  </p>
                )}
              </div>

              {formError && (
                <p className="auth-error" role="alert">
                  {formError}
                </p>
              )}

              <Button type="submit" size="lg" disabled={isSubmitting} className="w-full">
                {isSubmitting ? "Creating account…" : "Create account"}
              </Button>
            </form>
          </div>

          <p className="auth-foot">
            Already have an account?{" "}
            <Link to="/signin" className="auth-link">
              Sign in
            </Link>
          </p>
        </div>
      </div>
      <AuthAside />
    </main>
  );
}
