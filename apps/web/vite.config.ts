import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// C-004: the built app loads from the SAME ORIGIN as the API and reaches it through
// the typed client. In dev, Vite proxies /api (auth + the rest) and /mcp to the
// backend on :3000 — so the session cookie is same-origin and Eden/better-auth hit a
// real backend. In production the backend serves the built static app (no proxy needed).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
      "/mcp": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
});
