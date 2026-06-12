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

// Viewer-specific layout mode (S-006 / AS-014). The 3-pane viewer body reflows OFF the single
// breakpoint hook (C-005), in two independent steps the prototype encodes (viewer-shell.jsx +
// viewer.css):
//   - the comments rail collapses to an overlay drawer + a CommentFab at <900 (prototype
//     `drawerMode: w < 900` === isCompact: tablet + mobile). In `drawerMode` the rail is NOT an
//     inline grid column; the CommentFab opens it as a drawer and tapping a highlight opens it.
//   - the TOC collapses to an overlay drawer earlier, at <1200 (prototype `tocDrawer: w < 1200`
//     === any tier below desktop), toggled by the top bar's outline button (already wired S-005).
// Pure (width → flags) so AS-014 can assert the mapping deterministically with no real layout.
export interface ViewerLayoutMode {
  /** rail + CommentFab go to drawer overlay (<900) — prototype `drawerMode`. */
  drawerMode: boolean;
  /** TOC goes to a drawer overlay (<1200) — prototype `tocDrawer`. */
  tocDrawer: boolean;
}

export function viewerLayoutModeForWidth(width: number): ViewerLayoutMode {
  const tier = tierForWidth(width);
  return {
    drawerMode: isCompact(tier), // <900: tablet + mobile
    tocDrawer: tier !== "desktop", // <1200: laptop + tablet + mobile
  };
}

export function useViewerLayoutMode(): ViewerLayoutMode {
  const tier = useBreakpoint();
  return {
    drawerMode: isCompact(tier),
    tocDrawer: tier !== "desktop",
  };
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

// Merged from the former mobile hook (web-structure S-002 / AS-016): the two
// hooks were overlapping viewport concerns, so the thin `useIsMobile` wrapper now lives with
// its single source of truth instead of in a separate file. The shadcn Sidebar primitive asks
// this whether to render as an off-canvas Sheet (compact) vs an inline rail (desktop/laptop).
// "Compact" (tablet + mobile) is exactly the tier set where the shell shows the drawer.
export function useIsMobile(): boolean {
  return isCompact(useBreakpoint());
}
