import { test, expect } from "bun:test";
import { createApp } from "./app";

function get(app: ReturnType<typeof createApp>, path: string) {
  return app.handle(new Request(`http://localhost${path}`));
}

test("AS-001: /health returns ok when the database is reachable", async () => {
  const app = createApp({ dbCheck: async () => {} });
  const res = await get(app, "/health");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status).toBe("ok");
});

test("AS-002: /health reports degraded when the database is unreachable", async () => {
  const app = createApp({
    dbCheck: async () => {
      throw new Error("connection refused");
    },
  });
  const res = await get(app, "/health");
  const body = await res.json();
  expect(body.status).toBe("degraded");
  expect(body.db_ok).toBe(false);
});

test("AS-007 / C-004: app makes no outbound telemetry/analytics call on a normal request", async () => {
  // No-telemetry invariant (C-004): a request handled by the app must not reach
  // out to any network destination. We assert by failing the test if fetch fires.
  const realFetch = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = (async () => {
    outbound++;
    return new Response("");
  }) as unknown as typeof fetch;
  try {
    const app = createApp({ dbCheck: async () => {} });
    await get(app, "/health");
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(outbound).toBe(0);
});
