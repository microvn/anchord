// Integration tier (guarded by RUN_INTEGRATION): the doc download surface
// GET /api/docs/:slug/download must serve the FAITHFUL raw source by kind through the REAL app +
// REAL resolveAccess gate, on real Postgres — and refuse a caller without at least viewer access
// under either axis (viewer-overflow-menu S-005).
//
//   - AS-015: a markdown doc → 200, text/markdown, filename .md, body == the RAW markdown source.
//   - AS-016: an html doc → 200, text/html, .html, body == the stored HTML source (verbatim, NOT
//             the /v block-id/bridge-injected variant); an image doc (data URL) → 200, image/png,
//             .png, body == the decoded original bytes.
//   - AS-017: the SAME download with NO admission cookie (no view access under either axis) → 404,
//             existence-hiding — no bytes served. A redeemed viewer-link cookie → 200.
//
// The app is built with the PRODUCTION resolveAccess wired with APP_SECRET, so the link-axis
// admission cookie is what actually authorizes the download end-to-end. Mirrors share-viewer-doc.itest.
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/download.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { shareLinks } from "../../src/db/schema";
import { createApp } from "../../src/app";
import { createDocRepo } from "../../src/publish/repo";
import { createCapabilityTokenRepo } from "../../src/sharing/share-repo";
import { mintCapabilityToken } from "../../src/sharing/share-token";
import { ADMISSION_COOKIE_NAME } from "../../src/sharing/capability-cookie";
import { createResolveAccess } from "../../src/sharing/resolve-access";
import { createResolveDocRole, createIsDocOwner } from "../../src/sharing/resolve-doc-role-repo";
import { withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;
const SECRET = "itest-secret-at-least-16-chars";

// a 1x1 transparent PNG
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe.skipIf(!RUN)("S-005: GET /api/docs/:slug/download serves raw source by kind, gated (real Postgres)", () => {
  let h: MigratedDb;
  let app: ReturnType<typeof createApp>;
  const md = { slug: `dl-md-${process.pid}`, token: "", content: "# Refund API\n\n- one\n- two\n" };
  const html = { slug: `dl-html-${process.pid}`, token: "", content: "<h1>Report</h1><p>body</p>" };
  const img = { slug: `dl-img-${process.pid}`, token: "", content: `data:image/png;base64,${PNG_B64}` };

  beforeAll(async () => {
    h = await withMigratedDb();
    const repo = createDocRepo(h.db);

    const mkdoc = async (d: typeof md, title: string, kind: "markdown" | "html" | "image") => {
      const row = await repo.createDocWithV1({
        slug: d.slug,
        title,
        kind,
        content: d.content,
        contentHash: `hash-${d.slug}`,
      });
      d.token = mintCapabilityToken();
      // shared anyone_with_link at VIEWER — viewer is the minimum that may download (C-007).
      await h.db.insert(shareLinks).values({ docId: row.id, linkRole: "viewer", capabilityToken: d.token });
    };
    await mkdoc(md, "Refund API spec", "markdown");
    await mkdoc(html, "Strategy Backtest Report", "html");
    await mkdoc(img, "Architecture Diagram", "image");

    const resolveDocRole = createResolveDocRole(h.db, {
      isOwner: createIsDocOwner(h.db),
      isWorkspaceMember: async () => false,
    });
    const resolveAccess = createResolveAccess(h.db, { resolveDocRole, secret: SECRET });
    const resolveViewerSession = async (): Promise<{ userId: string } | null> => null; // always anon.

    app = createApp({
      dbCheck: async () => {},
      shareRedeem: {
        resolveCapabilityToken: createCapabilityTokenRepo(h.db),
        secret: SECRET,
        secure: false,
      },
      docDownload: { resolveViewerSession, loaderDeps: { db: h.db, resolveAccess } },
    });
  });

  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  });

  function req(path: string, init: RequestInit = {}) {
    return new Request(`http://localhost${path}`, init);
  }

  async function redeem(token: string): Promise<string | undefined> {
    const res = await app.handle(req(`/s/${token}/redeem`, { method: "POST" }));
    const setCookie = res.headers.get("set-cookie");
    return setCookie ? setCookie.split(";")[0]!.split("=").slice(1).join("=") : undefined;
  }

  function download(slug: string, cookie: string | undefined) {
    return app.handle(
      req(`/api/docs/${slug}/download`, {
        headers: cookie ? { cookie: `${ADMISSION_COOKIE_NAME}=${cookie}` } : {},
      }),
    );
  }

  test("AS-015: a markdown doc downloads as raw .md (the source, content-typed + attachment-named)", async () => {
    const cookie = await redeem(md.token);
    const res = await download(md.slug, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("content-disposition")).toContain("refund-api-spec.md");
    expect(await res.text()).toBe(md.content); // raw markdown, NOT rendered HTML
  });

  test("AS-016: an html doc downloads as verbatim .html source (no block-id/bridge injection)", async () => {
    const cookie = await redeem(html.token);
    const res = await download(html.slug, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-disposition")).toContain("strategy-backtest-report.html");
    const body = await res.text();
    expect(body).toBe(html.content);
    expect(body).not.toContain("data-block-id"); // pristine source, not the /v injected variant
  });

  test("AS-016: an image doc downloads as the decoded original image bytes with its real type", async () => {
    const cookie = await redeem(img.token);
    const res = await download(img.slug, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toContain("architecture-diagram.png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG magic
  });

  test("AS-017: download with NO view access (no admission cookie) → 404, no bytes", async () => {
    const res = await download(md.slug, undefined);
    expect(res.status).toBe(404);
  });

  test("AS-017: a redeemed viewer-link cookie authorizes the download (gate respects the link axis)", async () => {
    const cookie = await redeem(md.token);
    expect(cookie).toBeTruthy();
    const res = await download(md.slug, cookie);
    expect(res.status).toBe(200);
  });
});
