import { useEffect, useState } from "react";

// S-003 / AS-010: the ONE breakpoint source for the chrome. DESIGN.md §Responsive defines
// four tiers; the whole shell reflows off this single hook (C-003: responsive behaviour is
// driven by one breakpoint hook, not ad-hoc per component). The pure `tierForWidth` is the
// testable core — deterministic, no DOM — so AS-010 can assert the tier at 1440/768/360
// without driving real layout.
export type Breakpoint = "desktop" | "laptop" | "tablet" | "mobile";

// DESIGN.md §Responsive boundaries:
//   ≥1200 desktop · 900–1199 laptop · 600–899 tablet · <600 mobile
export function tierForWidth(width: number): Breakpoint {
  if (width >= 1200) return "desktop";
  if (width >= 900) return "laptop";
  if (width >= 600) return "tablet";
  return "mobile";
}

// At tablet and mobile the persistent side region collapses to an off-canvas drawer/sheet
// toggled by a button (DESIGN.md §Responsive). Desktop/laptop keep the side region inline.
export function isCompact(tier: Breakpoint): boolean {
  return tier === "tablet" || tier === "mobile";
}

function readWidth(): number {
  return typeof window === "undefined" ? 1440 : window.innerWidth;
}

// The React binding: subscribe to viewport resizes and re-derive the tier through the same
// pure `tierForWidth`, so live behaviour and unit tests agree on the boundaries.
export function useBreakpoint(): Breakpoint {
  const [tier, setTier] = useState<Breakpoint>(() => tierForWidth(readWidth()));

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setTier(tierForWidth(window.innerWidth));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return tier;
}
