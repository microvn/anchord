import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Skeleton } from "@/components/skeleton";
import { NoAccessView } from "./no-access-view";
import { ViewerScreen } from "./viewer-screen";
import { redeemCapabilityLink, RedeemError } from "@/features/viewer/services/client";

// CapabilityRedeemScreen (capability-share-link S-002): the PUBLIC `/s/:token` route (outside
// AuthGuard). An anonymous visitor opens the capability link; this screen REDEEMS the token —
// `POST /s/:token/redeem` sets the admission cookie and returns the readable slug — then renders
// the in-app viewer BY THAT SLUG without navigating, so the address bar keeps showing `/s/<token>`
// and the readable slug never appears in the URL (C-009/AS-004).
//
// AS-005 (existence-hiding): an unknown/expired token → 404 from redeem → a not-found state, NEVER
// any doc content or title. Not-found and no-access are the same surface (matching the viewer).

export function CapabilityRedeemScreen() {
  const { token = "" } = useParams<{ token: string }>();
  const [state, setState] = useState<
    { phase: "redeeming" } | { phase: "ready"; slug: string } | { phase: "not-found" }
  >({ phase: "redeeming" });

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "redeeming" });
    redeemCapabilityLink(token)
      .then((res) => {
        if (!cancelled) setState({ phase: "ready", slug: res.slug });
      })
      .catch((err) => {
        // AS-005: an unknown token (404) — or any redeem failure — is a not-found state. No doc/title.
        if (!cancelled) {
          void (err instanceof RedeemError); // status carried for future telemetry; not branched here.
          setState({ phase: "not-found" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

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
