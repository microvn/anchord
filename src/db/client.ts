import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/** Create a Drizzle client + a liveness probe over a postgres.js connection. */
export function createDb(databaseUrl: string, max = 10) {
  const sql = postgres(databaseUrl, { max });
  const db = drizzle(sql, { schema });
  const dbCheck = async () => {
    await sql`select 1`;
  };
  const close = async () => {
    await sql.end({ timeout: 5 });
  };
  return { db, sql, dbCheck, close };
}

export type DB = ReturnType<typeof createDb>["db"];
export { schema };
