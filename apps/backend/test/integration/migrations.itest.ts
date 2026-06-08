// Integration tier (guarded by RUN_INTEGRATION): the runtime migrator applies the
// committed drizzle/ migrations cleanly to a FRESH Postgres, the expected tables +
// columns exist, and re-running the migrator is idempotent (no error, no dup work).
//
// This verifies what the unit suite cannot: that the SQL drizzle-kit generated
// actually applies against a real server (self-host C-001 boot path).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql as raw } from "drizzle-orm";
import { runMigrator, withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;

describe.skipIf(!RUN)("migrations (real Postgres)", () => {
  let h: MigratedDb;

  beforeAll(async () => {
    h = await withMigratedDb();
  });

  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  });

  test("expected tables exist after migration", async () => {
    const rows = await h.db.execute<{ table_name: string }>(
      raw`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    const names = rows.map((r) => r.table_name);
    for (const t of ["account", "doc_versions", "docs", "session", "user", "verification"]) {
      expect(names).toContain(t);
    }
  });

  test("doc_versions has the published_by column (migration 0001)", async () => {
    const rows = await h.db.execute<{ column_name: string }>(
      raw`select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'doc_versions'`,
    );
    const cols = rows.map((r) => r.column_name);
    expect(cols).toContain("published_by");
    expect(cols).toContain("content_hash");
    expect(cols).toContain("version");
  });

  test("better-auth tables carry their key columns (migration 0002)", async () => {
    const userCols = (
      await h.db.execute<{ column_name: string }>(
        raw`select column_name from information_schema.columns
            where table_schema = 'public' and table_name = 'user'`,
      )
    ).map((r) => r.column_name);
    expect(userCols).toContain("emailVerified");

    const sessionCols = (
      await h.db.execute<{ column_name: string }>(
        raw`select column_name from information_schema.columns
            where table_schema = 'public' and table_name = 'session'`,
      )
    ).map((r) => r.column_name);
    expect(sessionCols).toContain("token");
    expect(sessionCols).toContain("userId");
  });

  test("re-running the migrator is idempotent", async () => {
    // Second apply against the already-migrated DB must be a no-op, not an error.
    await runMigrator(h.databaseUrl);
    // And a third, for good measure — the journal should short-circuit each time.
    await runMigrator(h.databaseUrl);
    // Sanity: the schema is still intact and queryable.
    const rows = await h.db.execute<{ n: number }>(raw`select 1 as n`);
    expect(rows[0]?.n).toBe(1);
  });
});
