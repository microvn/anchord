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
      // src="/v/:id" + the bare /d/:slug server fallback — proxy both to the backend in dev so
      // the iframe resolves same-origin (matching prod, where the backend serves the app).
      "/v": { target: "http://localhost:3007", changeOrigin: true },
      "/d": { target: "http://localhost:3007", changeOrigin: true },
    },
  },
});
