import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isReservedApiPath, serveSpa, SPA_CSP } from "./spa";

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

// Regression: H-6 defense-in-depth — the SPA app origin renders markdown docs inline, so its
// responses MUST carry a strict CSP (no remote img/connect hosts) + no-referrer.
describe("serveSpa security headers (H-6)", () => {
  const root = mkdtempSync(join(tmpdir(), "anchord-spa-"));
  writeFileSync(join(root, "index.html"), "<!doctype html><div id=root></div>");
  writeFileSync(join(root, "app.js"), "console.log(1)");

  it("sets a strict CSP + no-referrer on the SPA shell fallback", async () => {
    const res = await serveSpa(root, "/some/client/route");
    expect(res.headers.get("content-security-policy")).toBe(SPA_CSP);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    // img-src must NOT permit a remote host (the beacon vector).
    expect(SPA_CSP).toContain("img-src 'self' data:");
    expect(SPA_CSP).not.toContain("http://");
    expect(SPA_CSP).not.toContain("https://");
  });

  it("sets the same security headers on a served static asset", async () => {
    const res = await serveSpa(root, "/app.js");
    expect(res.headers.get("content-security-policy")).toBe(SPA_CSP);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});
