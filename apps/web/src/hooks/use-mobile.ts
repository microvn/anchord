import { isCompact, useBreakpoint } from "@/lib/use-breakpoint";

// The shadcn Sidebar primitive asks this hook whether it should render as an off-canvas
// Sheet (mobile) vs an inline rail (desktop). anchord has ONE breakpoint source of truth
// (S-003 / AS-010 / C-003 — `use-breakpoint`), so we delegate to it instead of shadcn's
// default 768px matchMedia hook. "Compact" (tablet <900 + mobile) is exactly the tier set
// where the shell shows the drawer (AS-016), so the primitive's Sheet swap now lines up
// with the anchord responsive tiers and reacts to the same `resize` event the tests drive.
export function useIsMobile(): boolean {
  return isCompact(useBreakpoint());
}
