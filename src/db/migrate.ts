import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { loadConfig } from "../config/env";

// Runtime migrator — applies committed SQL from ./drizzle at boot (self-host C-001).
// Uses drizzle-orm (runtime dep), not drizzle-kit (dev-only), so prod images stay lean.
const cfg = loadConfig();
const sql = postgres(cfg.DATABASE_URL, { max: 1 });
await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
await sql.end();
console.log("migrations applied");
