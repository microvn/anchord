import { test, expect } from "bun:test";
import { createApp } from "./app";
import type { ViewerDoc } from "./app";
import type { Viewer } from "./sharing/access";
import { shareUrl } from "./sharing/share-state";
import { publishDoc } from "./publish/service";

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

function appWithContent(content: string, kind: ViewerDoc["kind"]) {
  return createApp({
    dbCheck: async () => {},
    resolveViewerSession: async () => null,
    loadContent: async (_id: string, _v: Viewer) => ({ content, kind }),
  });
}

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
  // GAP-004 + S-001: the /v serve path now always appends the in-iframe annotation bridge AND the
  // highlight stylesheet, so an empty doc serves the style + bridge script (not a literally-empty
  // body) — the route still must not crash. The doc-content portion is empty; only our injected
  // <style> + bridge <script> are present.
  const body = await res.text();
  expect(body).toContain("anchord-bridge"); // bridge injected even for empty content
  expect(body).toContain(".anno-mark"); // S-001: highlight stylesheet injected too
  // S-007/C-010: the storage shim is PREPENDED (runs before any doc script), so for empty content
  // the output now leads with the shim <script> (not the <style>) — nothing of a doc body precedes it.
  expect(body.startsWith("<script")).toBe(true);
  expect(body).toContain("memStorage"); // the injected shim leads; the doc-content portion was empty
});

// doc-access-routing S-006 — the share link opens the app; the bare server page is gone.
// The link string is unchanged (/d/:slug); the backend no longer serves its own HTML there.
// It resolves to the in-app SPA viewer (dev: Vite's default fallback once the /d proxy is
// removed; prod: the static-serving fallback, owned by the self-host spec).

test("AS-027: the copied share link is /d/:slug and the backend no longer serves it", async () => {
  // The Share box copies shareUrl(slug) — the link the manager opens. It is the /d/:slug
  // string that now resolves to the in-app viewer, not a bare server page.
  expect(shareUrl("payment-spec-v2")).toBe("/d/payment-spec-v2");
  expect(shareUrl("a b/c")).toBe("/d/a%20b%2Fc"); // special chars stay encoded

  // The backend has NO /d/:slug handler anymore — the server-render path is GONE. Even if a
  // caller passes the OLD loadViewer dep (cast through any — the field was removed from
  // AppDeps), createApp must NOT mount a /d server page: the SPA fallback owns the route.
  const app = createApp({
    dbCheck: async () => {},
    resolveViewerSession: async () => null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    loadViewer: async (_slug: string, _v: Viewer) => ({
      versionId: "v-1",
      slug: "payment-spec-v2",
      title: "Doc",
      kind: "markdown" as const,
      content: "# secret\n\nbody",
    }),
  } as unknown as Parameters<typeof createApp>[0]);
  const res = await app.handle(new Request("http://localhost/d/payment-spec-v2"));
  expect(res.status).toBe(404); // no server handler — RED while /d still served the shell
  const body = await res.text();
  expect(body).not.toContain("<!doctype html"); // no server-rendered viewer shell
  expect(body).not.toContain('<main class="doc-md">'); // no markdown server-render
});

test("AS-028: publish returns a /d/:slug app-viewer link and no /d server handler exists", async () => {
  // An author publishes; the returned link opens the in-app viewer (the /d/:slug string).
  const bytes = new TextEncoder().encode("<h1>Spec</h1>");
  const res = await publishDoc(
    { bytes, filename: "spec.html", editedTitle: "Release Spec" },
    {
      repo: { createDocWithV1: async () => ({ id: "doc-1" }) },
      slugGen: () => "release-spec",
    },
  );
  expect(res.url).toBe("/d/release-spec");

  // The backend exposes NO /d handler — even given the OLD loadViewer dep — while the /v
  // iframe content surface is preserved. Proves the dead viewerPage/server-shell path is gone.
  const app = createApp({
    dbCheck: async () => {},
    resolveViewerSession: async () => null,
    loadViewer: async (_slug: string, _v: Viewer) => ({
      versionId: "v-1",
      slug: "release-spec",
      title: "Doc",
      kind: "html" as const,
      content: "<h1>x</h1>",
    }),
    loadContent: async (_id: string, _v: Viewer) => ({ content: "<h1>x</h1>", kind: "html" as const }),
  } as unknown as Parameters<typeof createApp>[0]);
  const dRes = await app.handle(new Request(`http://localhost${res.url}`));
  expect(dRes.status).toBe(404); // no backend /d handler (RED while /d served the shell)
  // …while /v (the iframe content surface) is preserved.
  const vRes = await app.handle(new Request("http://localhost/v/v-1"));
  expect(vRes.status).toBe(200);
});
