import { describe, it, expect } from "bun:test";
import { tierForWidth, isCompact, type Breakpoint } from "@/hooks/use-breakpoint";

// AS-010 logic: the ONE breakpoint source. Drive it by width (deterministic — no real
// layout) and assert the DESIGN.md §Responsive tiers at the canonical widths 1440/768/360,
// plus the boundary values where a tier flips.
describe("web-core S-003 — breakpoint tiers (AS-010)", () => {
  it("AS-010: width 1440 resolves to the desktop tier", () => {
    expect(tierForWidth(1440)).toBe("desktop");
  });

  it("AS-010: width 768 resolves to the tablet tier", () => {
    expect(tierForWidth(768)).toBe("tablet");
  });

  it("AS-010: width 360 resolves to the mobile tier", () => {
    expect(tierForWidth(360)).toBe("mobile");
  });

  it("AS-010: the laptop tier covers the 900–1199 band", () => {
    expect(tierForWidth(1024)).toBe("laptop");
  });

  it("AS-010: boundary widths flip tiers exactly at 1200/900/600 (DESIGN.md §Responsive)", () => {
    expect(tierForWidth(1200)).toBe("desktop");
    expect(tierForWidth(1199)).toBe("laptop");
    expect(tierForWidth(900)).toBe("laptop");
    expect(tierForWidth(899)).toBe("tablet");
    expect(tierForWidth(600)).toBe("tablet");
    expect(tierForWidth(599)).toBe("mobile");
  });

  it("AS-010: tablet and mobile are compact (drawer tiers); desktop and laptop are not", () => {
    const compact: Breakpoint[] = ["tablet", "mobile"];
    const inline: Breakpoint[] = ["desktop", "laptop"];
    for (const t of compact) expect(isCompact(t)).toBe(true);
    for (const t of inline) expect(isCompact(t)).toBe(false);
  });
});
