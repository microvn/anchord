import { describe, it, expect } from "bun:test";
import { isReservedApiPath } from "./spa";

// C-007 — reserved API paths keep their own response; everything else GET falls to the SPA shell.
describe("isReservedApiPath", () => {
  it("reserves the real backend surfaces", () => {
    for (const p of ["/api", "/api/auth/get-session", "/v/123", "/health", "/mcp"]) {
      expect(isReservedApiPath(p)).toBe(true);
    }
  });

  it("reserves the capability API sub-paths (redeem/resolve)", () => {
    expect(isReservedApiPath("/s/E0VsbKwCkAcszgvU7m4Jfg/redeem")).toBe(true);
    expect(isReservedApiPath("/s/E0VsbKwCkAcszgvU7m4Jfg/resolve")).toBe(true);
  });

  it("does NOT reserve the bare /s/:token redeem PAGE — it must serve the SPA", () => {
    // Regression: a blanket "/s/" prefix 404'd this page (the share deep-link).
    expect(isReservedApiPath("/s/E0VsbKwCkAcszgvU7m4Jfg")).toBe(false);
  });

  it("does not reserve ordinary SPA routes", () => {
    for (const p of ["/", "/signin", "/d/vfa-418-full-account-signup-2d6qez", "/settings"]) {
      expect(isReservedApiPath(p)).toBe(false);
    }
  });
});
