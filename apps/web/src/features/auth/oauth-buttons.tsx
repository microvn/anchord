import { useEffect, useState } from "react";
import { signIn } from "../../lib/auth-client";
import { fetchAuthProviders } from "./client";
import { unwrapEnvelope } from "../workspaces/use-bootstrap";
import { Icon } from "../../components/icon";

// auth-ui S-002 OAuthButtons (AS-006/AS-007) — renders a "Continue with …" button for ONLY
// the OAuth providers the operator enabled (ENV creds present), read from the GAP-002
// /api/auth-providers endpoint. A provider without creds is absent from that list → no
// button (AS-007). Clicking a button starts the better-auth social flow (AS-006); on a
// denied/failed callback better-auth redirects to `errorCallbackURL` (here /signin?error=…)
// so the sign-in screen renders OAuthErrorBanner (AS-008). The live OAuth round-trip is
// [→E2E]; the unit-tested logic is "which buttons render" + "click calls signIn.social".
//
// Visual: the Anchord-Design auth layout (oauth-row + provider glyph). The chrome is the
// design's; the behavior/wiring is unchanged.

export type OAuthProvider = "github" | "google";

const PROVIDER_LABEL: Record<OAuthProvider, string> = {
  github: "Continue with GitHub",
  google: "Continue with Google",
};

/** Where better-auth returns to on a denied/failed OAuth callback (AS-008). */
const OAUTH_ERROR_RETURN = "/signin?error=oauth";
/** Where a SUCCESSFUL OAuth callback lands (the app root → workspace resolver). */
const OAUTH_SUCCESS_RETURN = "/";

export function OAuthButtons() {
  const [providers, setProviders] = useState<OAuthProvider[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const res = unwrapEnvelope<{ providers: OAuthProvider[] }>(await fetchAuthProviders());
      if (cancelled) return;
      // No creds / read failed → no buttons (AS-007): only enabled providers ever render.
      setProviders(res.data?.providers ?? []);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // AS-007: with no enabled provider, render nothing (not even a divider) — the email+pw
  // form stands alone.
  if (providers.length === 0) return null;

  return (
    <div className="mt-6">
      <div className="oauth-row">
        {providers.map((p) => (
          <OAuthButton key={p} provider={p} />
        ))}
      </div>
      <div className="auth-divider" aria-hidden="true">
        or continue with email
      </div>
    </div>
  );
}

/** A single "Continue with <provider>" button. Click → start the better-auth social flow. */
export function OAuthButton({ provider }: { provider: OAuthProvider }) {
  function onClick() {
    // AS-006/AS-008: start the grant; on success better-auth returns to callbackURL with a
    // session, on denial/failure it returns to errorCallbackURL (?error=…). The redirect is
    // owned by better-auth; this component only kicks it off.
    void signIn.social({
      provider,
      callbackURL: OAUTH_SUCCESS_RETURN,
      errorCallbackURL: OAUTH_ERROR_RETURN,
    });
  }
  return (
    <button type="button" data-testid={`oauth-${provider}`} onClick={onClick} className="oauth-btn">
      <Icon name={provider} size={16} fill />
      {PROVIDER_LABEL[provider]}
    </button>
  );
}
