import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";

export type AppDeps = {
  /** Liveness probe for the database. Resolves if reachable, throws if not. */
  dbCheck: () => Promise<void>;
  corsOrigin?: string | string[] | boolean;
};

/**
 * Build the anchord HTTP app. Dependencies are injected so the app is testable
 * without a real database or network (no telemetry — nothing reaches out except
 * what a handler is explicitly asked to do).
 */
export function createApp(deps: AppDeps) {
  return new Elysia()
    .use(cors({ origin: deps.corsOrigin ?? true }))
    .get("/health", async ({ set }) => {
      let db_ok = false;
      try {
        await deps.dbCheck();
        db_ok = true;
      } catch {
        db_ok = false;
      }
      set.status = 200; // always 200; status field tells liveness vs degraded
      return { status: db_ok ? "ok" : "degraded", db_ok, version: "0.0.0" };
    });
}

export type App = ReturnType<typeof createApp>;
