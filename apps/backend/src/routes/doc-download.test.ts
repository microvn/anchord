import { test, expect, describe } from "bun:test";
import { Elysia } from "elysia";
import { docDownloadRoutes } from "./viewer-doc";
import { DocDeletedError } from "../http/errors";
import type { ViewerDocPayload } from "../render/viewer-loaders";

// viewer-overflow-menu S-005 — UNIT tests for the raw download route GET /api/docs/:slug/download.
// They drive the real route with an injected `loadViewerDoc` stub, proving the route shapes the
// file Response by kind (content-type + attachment filename + body) and that the existence-hiding
// refusal (loader → null) is a 404 with NO bytes. The REAL two-axis access gate (resolveAccess on
// workspace/generic + link/people) is exercised end-to-end in download.itest.ts (real Postgres).

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function payload(over: Partial<ViewerDocPayload>): ViewerDocPayload {
  return {
    versionId: "v1",
    title: "Doc",
    kind: "markdown",
    version: 1,
    status: "published",
    generalAccess: "anyone_with_link",
    workspaceRole: null,
    linkRole: "viewer",
    effectiveRole: "viewer",
    workspaceId: null,
    content: "x",
    ...over,
  } as ViewerDocPayload;
}

function appWith(loadViewerDoc: (slug: string) => Promise<ViewerDocPayload | null>) {
  return new Elysia().use(
    docDownloadRoutes({
      resolveViewerSession: async () => null,
      loadViewerDoc: (slug) => loadViewerDoc(slug),
    }),
  );
}

function get(app: ReturnType<typeof appWith>, slug: string) {
  return app.handle(new Request(`http://localhost/api/docs/${slug}/download`));
}

describe("docDownloadRoutes S-005", () => {
  test("AS-015: a markdown doc → 200 text/markdown, .md filename, raw source body", async () => {
    const src = "# Refund API\n\n- a\n";
    const app = appWith(async () => payload({ title: "Refund API spec", kind: "markdown", content: src }));
    const res = await get(app, "refund-api-spec");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("content-disposition")).toContain("refund-api-spec.md");
    expect(await res.text()).toBe(src);
  });

  test("AS-016: an html doc → text/html, .html filename, verbatim source body", async () => {
    const src = "<h1>Report</h1>";
    const app = appWith(async () => payload({ title: "Strategy Report", kind: "html", content: src }));
    const res = await get(app, "strategy-report");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-disposition")).toContain("strategy-report.html");
    expect(await res.text()).toBe(src);
  });

  test("AS-016: an image doc (data URL) → image/png, .png filename, decoded bytes", async () => {
    const app = appWith(async () =>
      payload({ title: "Architecture Diagram", kind: "image", content: `data:image/png;base64,${PNG_B64}` }),
    );
    const res = await get(app, "architecture-diagram");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toContain("architecture-diagram.png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test("AS-017: a no-access / missing doc (loader → null) → 404, no bytes", async () => {
    const app = appWith(async () => null);
    const res = await get(app, "nope");
    expect(res.status).toBe(404);
  });

  test("AS-017: a soft-deleted doc the caller could see → 410 (deleted notice, not the bytes)", async () => {
    const app = appWith(async () => {
      throw new DocDeletedError();
    });
    const res = await get(app, "gone");
    expect(res.status).toBe(410);
  });
});
