import { test, expect } from "bun:test";
import { createApp } from "./app";
import type { ViewerDoc } from "./app";
import type { Viewer } from "./sharing/access";

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

// render-publish S-006 (C-009) — block-id markers are injected ON THE SERVE PATH.
// These prove the WIRING (the injector exists & is unit-tested in annotation/block-id.test.ts;
// here we prove createApp actually runs it on the /d and /v served content).

function appWithViewer(doc: ViewerDoc | null) {
  return createApp({
    dbCheck: async () => {},
    resolveViewerSession: async () => null, // anon viewer; the fake loaders ignore the gate
    loadViewer: async (_slug: string, _v: Viewer) => doc,
  });
}

function appWithContent(content: string, kind: ViewerDoc["kind"]) {
  return createApp({
    dbCheck: async () => {},
    resolveViewerSession: async () => null,
    loadContent: async (_id: string, _v: Viewer) => ({ content, kind }),
  });
}

test("AS-019 / C-009: /d markdown viewer page carries positional block-{tag}-{n} ids", async () => {
  // 3 paragraphs + 2 headings (AS-019 data) → each block stamped, per-tag counter.
  const md = "# Title\n\n## Subtitle\n\nFirst para\n\nSecond para\n\nThird para";
  const app = appWithViewer({
    versionId: "v-1",
    slug: "doc-md",
    title: "Doc",
    kind: "markdown",
    content: md,
  });
  const res = await get(app, "/d/doc-md");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('id="block-h1-1"');
  expect(html).toContain('id="block-h2-1"');
  expect(html).toContain('id="block-p-1"');
  expect(html).toContain('id="block-p-2"');
  expect(html).toContain('id="block-p-3"');
});

test("AS-019 / C-009: /v sandbox content carries positional block ids", async () => {
  const app = appWithContent("<h1>Untrusted</h1><p>a</p><p>b</p>", "html");
  const res = await get(app, "/v/v-1");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('id="block-h1-1"');
  expect(html).toContain('id="block-p-1"');
  expect(html).toContain('id="block-p-2"');
});

test("AS-020 / C-009: a served block with an existing id keeps it, gets data-block-id", async () => {
  // <h2 id="intro"> (AS-020 data) served via /v → id preserved, marker → data-block-id.
  const app = appWithContent('<h2 id="intro">Intro</h2><p>body</p>', "html");
  const res = await get(app, "/v/v-1");
  const html = await res.text();
  expect(html).toContain('id="intro"'); // author id preserved
  expect(html).toContain('data-block-id="block-h2-1"'); // marker added, not clobbered
  expect(html).not.toContain('<h2 id="block-h2-1"'); // never overwrote the author id
});

test("AS-021 / C-009: the same text in two served blocks resolves to distinct block ids", async () => {
  // "see below" in block 3 and block 9 (AS-021 data) → two different ids.
  const blocks = Array.from({ length: 9 }, (_, i) =>
    i === 2 || i === 8 ? "<p>see below</p>" : `<p>para ${i + 1}</p>`,
  ).join("");
  const app = appWithContent(blocks, "html");
  const res = await get(app, "/v/v-1");
  const html = await res.text();
  expect(html).toContain('<p id="block-p-3">see below</p>');
  expect(html).toContain('<p id="block-p-9">see below</p>');
});

test("AS-022 / C-009: malformed served content is injected best-effort without crashing", async () => {
  // unclosed <div> (AS-008/AS-022 data) → no throw, content still serves with markers.
  const app = appWithContent("<div><p>orphan paragraph<h1>still here", "html");
  const res = await get(app, "/v/v-1");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("orphan paragraph"); // content preserved
  expect(html).toContain("still here");
  expect(html).toContain('id="block-p-1"'); // best-effort markers applied
});

test("AS-022 / C-009: empty served content does not crash the route", async () => {
  const app = appWithContent("", "html");
  const res = await get(app, "/v/v-1");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("");
});
