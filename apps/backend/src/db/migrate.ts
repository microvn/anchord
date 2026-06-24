import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { loadConfig } from "../config/env";

// Runtime migrator — applies committed SQL from ./drizzle at boot (self-host C-001).
// Uses drizzle-orm (runtime dep), not drizzle-kit (dev-only), so prod images stay lean.
const cfg = loadConfig();
// Postgres NOTICE chatter (e.g. "schema drizzle already exists, skipping") is harmless
// idempotent re-run noise the migrator's own CREATE ... IF NOT EXISTS emits on every boot.
// Swallowed by default; set DEBUG_SQL=1 to surface them when diagnosing migrations.
// This only filters NOTICE-level messages — ERRORs still reject and fail the boot (C-001).
const debugSql = Boolean(process.env.DEBUG_SQL);
const sql = postgres(cfg.DATABASE_URL, {
  max: 1,
  onnotice: debugSql ? undefined : () => {},
});
await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
await sql.end();
console.log("migrations applied");
