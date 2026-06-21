import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Skeleton } from "@/components/skeleton";
import { NoAccessView } from "./no-access-view";
import { LinkPasswordGate } from "./link-password-gate";
import { ViewerScreen } from "./viewer-screen";
import { redeemCapabilityLink, RedeemError } from "@/features/viewer/services/client";

// CapabilityRedeemScreen (capability-share-link S-002 + S-006): the PUBLIC `/s/:token` route
// (outside AuthGuard). An anonymous visitor opens the capability link; this screen REDEEMS the
// token — `POST /s/:token/redeem` sets the admission cookie and returns the readable slug — then
// renders the in-app viewer BY THAT SLUG without navigating, so the address bar keeps showing
// `/s/<token>` and the readable slug never appears in the URL (C-009/AS-004).
//
// AS-005 (existence-hiding): an unknown token → 404 → not-found. An expired / view-limit-exhausted
// link (S-006/AS-014/AS-016) → 410 → the SAME not-found surface (no doc/title leaked).
//
// S-006/AS-017/AS-018 (password): a password-protected link returns 401 LINK_PASSWORD_REQUIRED →
// this screen shows the LinkPasswordGate instead of the viewer. A submitted password re-runs the
// redeem; a correct one mints the (password-cleared) admission cookie and renders the doc WITHOUT
// re-prompting for the rest of the session (the cookie marker — follow-up reads ride it). A wrong
// password (401 INCORRECT) re-prompts with an inline error; once throttled (429) the gate backs off.

export function CapabilityRedeemScreen() {
  const { token = "" } = useParams<{ token: string }>();
  const [state, setState] = useState<
    | { phase: "redeeming" }
    | { phase: "ready"; slug: string }
    | { phase: "not-found" }
    // S-006: the password challenge. `submitting` is true while a redeem attempt is in flight;
    // `error` is set after a wrong password; `rateLimited` after the server throttles (429).
    | { phase: "password"; submitting: boolean; error?: string; rateLimited: boolean }
  >({ phase: "redeeming" });

  /** Run one redeem attempt (optionally with a password) and route the outcome. */
  const attempt = useCallback(
    (password: string | undefined, cancelledRef?: { current: boolean }) => {
      redeemCapabilityLink(token, password)
        .then((res) => {
          if (!cancelledRef?.current) setState({ phase: "ready", slug: res.slug });
        })
        .catch((err) => {
          if (cancelledRef?.current) return;
          if (err instanceof RedeemError && err.isPasswordChallenge) {
            // S-006/AS-017/AS-018: prompt (or re-prompt) for the password.
            setState({
              phase: "password",
              submitting: false,
              rateLimited: err.code === "LINK_PASSWORD_RATE_LIMITED",
              error:
                err.code === "LINK_PASSWORD_INCORRECT"
                  ? "Incorrect password. Try again."
                  : undefined,
            });
            return;
          }
          // AS-005/AS-014/AS-016: unknown / expired / over-limit → not-found (no doc/title).
          setState({ phase: "not-found" });
        });
    },
    [token],
  );

  useEffect(() => {
    const cancelledRef = { current: false };
    setState({ phase: "redeeming" });
    attempt(undefined, cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
  }, [token, attempt]);

  // AS-017/AS-018: the gate submits a password → re-run the redeem; show a working state meanwhile.
  const handlePasswordSubmit = useCallback(
    (password: string) => {
      setState({ phase: "password", submitting: true, rateLimited: false });
      attempt(password);
    },
    [attempt],
  );

  if (state.phase === "password") {
    return (
      <LinkPasswordGate
        onSubmit={handlePasswordSubmit}
        submitting={state.submitting}
        error={state.error}
        rateLimited={state.rateLimited}
      />
    );
  }

  if (state.phase === "redeeming") {
    return (
      <div className="flex h-dvh items-center justify-center bg-paper px-4 text-ink">
        <div className="w-full max-w-[760px]">
          <Skeleton rows={4} delayMs={0} />
        </div>
      </div>
    );
  }

  if (state.phase === "not-found") {
    // AS-005: existence-hiding — a no-account visitor with a bad token sees the same not-found
    // surface as a no-access doc. NEVER the viewer, never a title.
    return (
      <div
        data-testid="capability-not-found"
        className="flex h-dvh items-center justify-center bg-paper px-4 text-ink"
      >
        <NoAccessView variant="no-access" />
      </div>
    );
  }

  // AS-004 / C-009: render the viewer BY SLUG, but keep the URL the token. `returnTo` is the token
  // url so any sign-in CTA returns here (never `/d/:slug`), so the slug never reaches the address bar.
  return <ViewerScreen slug={state.slug} returnTo={`/s/${token}`} />;
}
