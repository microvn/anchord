import { loadConfig } from "./config/env";
import { createDb } from "./db/client";
import { createApp } from "./app";
import { createAuth } from "./auth/auth";

const cfg = loadConfig(); // refuses to start on invalid/missing config (S-002, incl. SMTP C-008)
const { db, dbCheck } = createDb(cfg.DATABASE_URL);

// S-001: better-auth bound to the real Postgres DB; APP_SECRET signs the session cookie.
// S-002: pass through OAuth creds — each provider is configured only when env supplied both.
const auth = createAuth(db, {
  secret: cfg.APP_SECRET,
  baseURL: `http://localhost:${cfg.PORT}`,
  oauth: cfg.oauth,
});

const app = createApp({
  dbCheck,
  corsOrigin: cfg.CORS_ORIGIN === "*" ? true : cfg.CORS_ORIGIN.split(","),
  authHandler: auth.handler,
}).listen(cfg.PORT);

console.log(`anchord on http://localhost:${cfg.PORT} (${cfg.NODE_ENV})`);
export type App = typeof app;
