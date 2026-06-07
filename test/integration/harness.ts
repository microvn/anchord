// Integration-test harness: boots a throwaway postgres:17-alpine container on a
// random free host port, runs the runtime migrator against it, and tears it down.
//
// This is the missing tier the unit suite deliberately deferred: the version
// append transaction (multi-writer row-lock correctness — versioning-diff C-002),
// the publish create-doc-with-v1 transaction, and the live better-auth session
// flow all need a REAL Postgres to verify. They cannot run in the fast `bun test`
// (no Docker assumed there), so every integration test is guarded by
// RUN_INTEGRATION (see *.itest.ts) and only this harness talks to Docker.
//
// Docker is driven through Bun.spawn (no `docker` npm dep). Container names are
// unique via a monotonic counter + the chosen host port + the process pid, so
// parallel test files never collide and a crash leaves an identifiable corpse.

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "../../src/db/schema";

const IMAGE = "postgres:17-alpine";
const PG_PASSWORD = "anchord_itest";
const PG_DB = "anchord_itest";
const READY_TIMEOUT_MS = 30_000;

let containerCounter = 0;

/** Run a docker command, capturing stdout/stderr. Throws on non-zero exit. */
async function docker(args: string[]): Promise<string> {
  const proc = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`docker ${args.join(" ")} failed (exit ${exitCode}):\n${stderr || stdout}`);
  }
  return stdout.trim();
}

/** docker variant that returns success/failure instead of throwing (for polling). */
async function dockerOk(args: string[]): Promise<boolean> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "ignore", stderr: "ignore" });
  return (await proc.exited) === 0;
}

/** Find a free TCP port by binding to :0 and reading the assigned port back. */
async function freePort(): Promise<number> {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open() {}, close() {} },
  });
  const port = server.port;
  server.stop(true);
  return port;
}

export interface EphemeralPostgres {
  databaseUrl: string;
  containerId: string;
  containerName: string;
  /** Force-remove the container (idempotent — safe to call twice). */
  stop(): Promise<void>;
}

/**
 * Boot a throwaway Postgres container on a random free host port, wait until it
 * accepts connections (pg_isready, then a real `select 1`), and return its URL +
 * a stop() that `docker rm -f`s it.
 */
export async function startEphemeralPostgres(): Promise<EphemeralPostgres> {
  const port = await freePort();
  const name = `anchord-itest-${process.pid}-${port}-${++containerCounter}`;

  const containerId = await docker([
    "run",
    "-d",
    "--rm", // auto-remove on stop, so a missed stop() still cleans up on container exit
    "--name",
    name,
    "-e",
    `POSTGRES_PASSWORD=${PG_PASSWORD}`,
    "-e",
    `POSTGRES_DB=${PG_DB}`,
    "-p",
    `127.0.0.1:${port}:5432`,
    IMAGE,
  ]);

  const databaseUrl = `postgres://postgres:${PG_PASSWORD}@127.0.0.1:${port}/${PG_DB}`;

  const stop = async () => {
    // `docker rm -f` is idempotent enough; with --rm the container may already be gone.
    await dockerOk(["rm", "-f", containerId]);
  };

  try {
    await waitForReady(name, databaseUrl);
  } catch (err) {
    await stop();
    throw err;
  }

  return { databaseUrl, containerId, containerName: name, stop };
}

/** Poll pg_isready inside the container, then confirm a real connection works. */
async function waitForReady(containerName: string, databaseUrl: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  // Phase 1: pg_isready (cheap, in-container, no client connection churn).
  while (Date.now() < deadline) {
    const ready = await dockerOk([
      "exec",
      containerName,
      "pg_isready",
      "-U",
      "postgres",
      "-d",
      PG_DB,
    ]);
    if (ready) break;
    await Bun.sleep(300);
  }
  // Phase 2: a real connection — pg_isready can report ready a beat before the
  // listener accepts auth'd TCP from the host port mapping.
  let lastErr: unknown;
  while (Date.now() < deadline) {
    const sql = postgres(databaseUrl, { max: 1, connect_timeout: 5, onnotice: () => {} });
    try {
      await sql`select 1`;
      await sql.end();
      return;
    } catch (e) {
      lastErr = e;
      await sql.end().catch(() => {});
      await Bun.sleep(300);
    }
  }
  throw new Error(
    `Postgres in ${containerName} did not become ready within ${READY_TIMEOUT_MS}ms: ${String(lastErr)}`,
  );
}

export interface MigratedDb {
  databaseUrl: string;
  db: ReturnType<typeof drizzle<typeof schema>>;
  sql: ReturnType<typeof postgres>;
  /** Close the DB connection pool (does NOT stop the container). */
  close(): Promise<void>;
  /** Force-remove the container. */
  stop(): Promise<void>;
  containerName: string;
}

/**
 * Start an ephemeral Postgres and apply the committed `drizzle/` migrations with the
 * SAME runtime migrator the app boots with (drizzle-orm/postgres-js/migrator).
 * Returns a connected Drizzle handle. The caller must `close()` + `stop()` (do both
 * in afterAll; close first, then stop).
 */
export async function withMigratedDb(): Promise<MigratedDb> {
  const pg = await startEphemeralPostgres();

  // Apply migrations on a dedicated single connection (the migrator's own pattern).
  const migrationSql = postgres(pg.databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(migrationSql), { migrationsFolder: "./drizzle" });
  } finally {
    await migrationSql.end();
  }

  const sql = postgres(pg.databaseUrl, { max: 10, onnotice: () => {} });
  const db = drizzle(sql, { schema });

  return {
    databaseUrl: pg.databaseUrl,
    db,
    sql,
    containerName: pg.containerName,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
    stop: pg.stop,
  };
}

/** Run the runtime migrator against an arbitrary database URL (for idempotency tests). */
export async function runMigrator(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  } finally {
    await sql.end();
  }
}
