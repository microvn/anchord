// auth-ui S-002 OAuthErrorBanner (AS-008) — shown on the sign-in screen when better-auth
// redirected back to it after a DENIED or FAILED OAuth callback. better-auth appends an
// `?error=…` query param to the per-flow errorCallbackURL; the sign-in screen reads it and
// renders this banner. No session is created on that path (the error redirect carries no
// cookie) — this is purely the visible-error half of C-002.

/** Map a better-auth oauth error code/param to a readable, non-leaky message. */
export function oauthErrorMessage(code: string | null): string {
  if (!code) return "";
  switch (code) {
    case "access_denied":
      return "You cancelled the sign-in. No account was connected.";
    default:
      return "Sign-in with that provider failed. Please try again.";
  }
}

export function OAuthErrorBanner({ code }: { code: string | null }) {
  if (!code) return null;
  return (
    <p role="alert" data-testid="oauth-error" className="mb-4 rounded-md bg-error/10 px-3 py-2 text-sm text-error">
      {oauthErrorMessage(code)}
    </p>
  );
}
