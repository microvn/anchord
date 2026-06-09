import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "./zod-resolver";
import { Link } from "react-router-dom";
import { z } from "zod";
import { signUp } from "../../lib/auth-client";
import { VerifyEmailSent } from "./verify-email-sent";
import { OAuthButtons } from "./oauth-buttons";

// auth-ui S-001 SignUpScreen — email + password (≥8) → "check your inbox" (AS-001); an
// already-registered email stays on this screen with an "email already in use" error
// (AS-005). No token is stored client-side: better-auth manages the session as an httpOnly
// cookie, and with requireEmailVerification a fresh sign-up has NO session yet (C-003).
// OAuthButtons (only enabled providers) are reused here too.

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
    <main className="min-h-full grid place-items-center px-4 py-12">
      <div className="w-full max-w-sm">
        <h1 className="font-serif text-3xl tracking-tight text-ink">anchord</h1>
        <p className="mt-1 text-sm text-muted">Create your account.</p>

        <form className="mt-8 flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)} noValidate>
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
              autoComplete="new-password"
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
            <p className="text-sm text-error" role="alert">
              {formError}
            </p>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="min-h-[40px] rounded-md bg-accent px-4 font-medium text-on-accent hover:bg-accent-strong disabled:opacity-60"
          >
            {isSubmitting ? "Creating account…" : "Create account"}
          </button>
        </form>

        <OAuthButtons />

        <p className="mt-6 text-center text-sm text-muted">
          Already have an account?{" "}
          <Link to="/signin" className="text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
