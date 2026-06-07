import { loadConfig } from "./config/env";
import { createDb } from "./db/client";
import { createApp } from "./app";

const cfg = loadConfig(); // refuses to start on invalid/missing config (S-002)
const { dbCheck } = createDb(cfg.DATABASE_URL);

const app = createApp({
  dbCheck,
  corsOrigin: cfg.CORS_ORIGIN === "*" ? true : cfg.CORS_ORIGIN.split(","),
}).listen(cfg.PORT);

console.log(`anchord on http://localhost:${cfg.PORT} (${cfg.NODE_ENV})`);
export type App = typeof app;
