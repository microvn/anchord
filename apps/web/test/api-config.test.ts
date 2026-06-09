import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// C-004 (config-level): the built app loads from the SAME ORIGIN as the API and reaches
// it through the typed client. In dev that means Vite proxies /api (+ /mcp) to the
// backend; the Eden client must send the session cookie (credentials: "include"). The
// true browser→backend round-trip is [→E2E] (Playwright), deferred — this asserts the
// wiring that makes it possible.
const root = fileURLToPath(new URL("..", import.meta.url));

describe("web-core S-001 — C-004 same-origin typed client", () => {
  it("C-004: the Vite dev config proxies /api to the backend", () => {
    const vite = readFileSync(`${root}vite.config.ts`, "utf8");
    expect(vite).toContain('"/api"');
    expect(vite).toMatch(/proxy/);
    // Proxies /api to the local backend. Port-agnostic: the dev backend port is config
    // (it moved 3000→3007 to match the running dev/E2E server), so assert the localhost
    // target, not a hardcoded port that drifts.
    expect(vite).toMatch(/target:\s*["']http:\/\/localhost:\d+["']/);
  });

  it("C-004: the Eden typed client is created with credentials 'include' (sends the session cookie)", () => {
    const api = readFileSync(`${root}src/lib/api.ts`, "utf8");
    expect(api).toContain('treaty<App>');
    expect(api).toMatch(/credentials:\s*["']include["']/);
    expect(api).toContain('import type { App }');
  });
});
