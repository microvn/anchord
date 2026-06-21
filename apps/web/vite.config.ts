import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// C-004: the built app loads from the SAME ORIGIN as the API and reaches it through
// the typed client. In dev, Vite proxies /api (auth + the rest) and /mcp to the
// backend on :3000 — so the session cookie is same-origin and Eden/better-auth hit a
// real backend. In production the backend serves the built static app (no proxy needed).
//
// The committed default backend port is :3000. A local 3007 override is the human's to
// manage (e.g. via a vite.config.local or env) — do NOT hardcode it here.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/api": { target: "http://localhost:3007", changeOrigin: true },
      "/mcp": { target: "http://localhost:3007", changeOrigin: true },
      // annotation-core-ui S-001 (GAP-003/G5): the HTML/image sandbox iframe uses a relative
      // src="/v/:id" — proxy it to the backend in dev so the iframe resolves same-origin
      // (matching prod, where the backend serves the app).
      //
      // doc-access-routing S-006: the bare server-rendered /d/:slug was removed, so the /d
      // proxy is GONE — Vite's default SPA fallback now serves /d/* (the in-app viewer route).
      //
      // Regex-anchored to `/v/` (NOT a bare "/v" prefix): a plain "/v" prefix also matched
      // SPA routes that merely START with "v" — notably `/verify-email`, which got proxied to
      // the backend and returned a 404 envelope instead of the SPA. Same swallow the /s rule
      // below already guards against. Only `/v/:id` (the iframe src) proxies now.
      "^/v/": { target: "http://localhost:3007", changeOrigin: true },
      // capability-share-link S-002: the redeem API is mounted at ROOT (/s/:token/redeem,
      // /s/:token/resolve) — envelope-exempt. Proxy ONLY those subpaths; the bare /s/:token
      // GET stays Vite's SPA fallback (the capability-redeem screen). Regex key (^) so the
      // SPA mount isn't swallowed.
      "^/s/[^/]+/(redeem|resolve)": { target: "http://localhost:3007", changeOrigin: true },
    },
  },
});
