import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/features/auth/lib/zod-resolver";
import { Link } from "react-router-dom";
import { signUp } from "@/lib/api/auth-client";
import { signUpSchema, type SignUpValues } from "@/features/auth/schema/sign-up";
import { usePageMeta } from "@/hooks/use-page-meta";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AuthShell,
  authTitleClass,
  authSubClass,
  authLabelClass,
  authInputClass,
  authSubmitClass,
  authFootClass,
} from "./auth-shell";
import { VerifyEmailSent } from "./verify-email-sent";
import { OAuthButtons } from "./oauth-buttons";

// auth-ui S-001 SignUpScreen — email + password (≥8) → "check your inbox" (AS-001); an
// already-registered email stays on this screen with an "email already in use" error
// (AS-005). No token is stored client-side: better-auth manages the session as an httpOnly
// cookie, and with requireEmailVerification a fresh sign-up has NO session yet (C-003).
// OAuthButtons (only enabled providers) are reused here too.

export function SignUpScreen() {
  usePageMeta("Sign up");
  const [formError, setFormError] = useState<string | null>(null);
  // Once sign-up succeeds we flip to the "check your inbox" state (with resend), keeping the
  // email so VerifyEmailSent can resend to it. We never navigate into the app — there is no
  // session until the email is verified (C-003).
  const [sentTo, setSentTo] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignUpValues>({ resolver: zodResolver(signUpSchema) });

  async function onSubmit(values: SignUpValues) {
    setFormError(null);
    const res = await signUp.email({
      email: values.email,
      password: values.password,
      name: values.name,
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
        code === "USER_ALREADY_EXISTS" ||
        /exist|already|registered|use/i.test(res.error.message ?? "")
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
    <AuthShell>
      <h1 className={authTitleClass}>Create your account</h1>
      <p className={authSubClass}>Set up your first workspace in seconds.</p>

      <div className="mt-[26px] flex flex-col gap-3.5">
        <OAuthButtons />

        <form className="flex flex-col gap-3.5" onSubmit={handleSubmit(onSubmit)} noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name" className={authLabelClass}>
              Name
            </Label>
            <Input
              id="name"
              type="text"
              autoComplete="name"
              placeholder="Your name"
              className={authInputClass}
              {...register("name")}
            />
            {errors.name && (
              <p className="text-xs text-error" role="alert">
                {errors.name.message}
              </p>
            )}
          </div>

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
              autoComplete="new-password"
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
            <p className="text-sm text-error" role="alert">
              {formError}
            </p>
          )}

          <Button type="submit" size="lg" disabled={isSubmitting} className={authSubmitClass}>
            {isSubmitting ? "Creating account…" : "Create account"}
          </Button>
        </form>
      </div>

      <p className={authFootClass}>
        Already have an account?{" "}
        <Link to="/signin" className="font-semibold text-accent-ink hover:underline">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
