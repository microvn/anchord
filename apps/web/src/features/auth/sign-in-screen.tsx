import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate } from "react-router-dom";
import { z } from "zod";
import { signIn } from "../../lib/auth-client";

// S-001 SignInScreen — email+password only this slice (OAuth/magic-link deferred, GAP-001).
const schema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Enter your password"),
});
type Values = z.infer<typeof schema>;

export function SignInScreen() {
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  async function onSubmit(values: Values) {
    setFormError(null);
    // better-auth establishes the session as an httpOnly cookie on success — we store
    // NO token client-side (C-001). On failure we stay on this screen with an inline
    // error (AS-003); on success we navigate into the protected app (AS-002).
    const res = await signIn.email({
      email: values.email,
      password: values.password,
    });
    if (res?.error) {
      setFormError(res.error.message ?? "Sign in failed. Check your credentials.");
      return;
    }
    navigate("/", { replace: true });
  }

  return (
    <main className="min-h-full grid place-items-center px-4 py-12">
      <div className="w-full max-w-sm">
        <h1 className="font-serif text-3xl tracking-tight text-ink">anchord</h1>
        <p className="mt-1 text-sm text-muted">Sign in to your workspace.</p>

        <form
          className="mt-8 flex flex-col gap-4"
          onSubmit={handleSubmit(onSubmit)}
          noValidate
        >
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
            <p className="text-sm text-error" role="alert">
              {formError}
            </p>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="min-h-[40px] rounded-md bg-accent px-4 font-medium text-paper hover:bg-accent-strong disabled:opacity-60"
          >
            {isSubmitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </main>
  );
}
