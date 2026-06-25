// Integration tier (guarded by RUN_INTEGRATION): the capability-link admission cookie must
// authorize the SPA viewer's FIRST read — GET /api/docs/:slug (the doc content) — through the
// REAL app + the REAL resolveAccess gate, on real Postgres. This is the exact seam the
// S-002 C-006 fix MISSED: redeem mints the cookie and the comment/annotations endpoints honor
// it, but the doc-read route (routes/viewer-doc.ts docViewerRoutes) built the anon Viewer
// WITHOUT the admission cookie, so an anon visitor redeemed fine but then got 404 on the doc.
//
//   - C-006: an anon GET /api/docs/:slug carrying a VALID admission cookie (minted by redeem
//     for THIS doc + current token) serves the doc (200 + payload).
//   - S-003: the SAME request with NO cookie → 404 (existence-hiding; anon-without-cookie denied).
//   - AS-020 / C-007.a: a cookie minted for doc A presented on doc B → 404 (cross-doc replay).
//
// The app is built with the PRODUCTION resolveAccess wired with APP_SECRET (NOT a stub), so the
// cookie is what actually authorizes the read end-to-end. Models share-redeem.itest.ts.
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/share-viewer-doc.itest.ts

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

describe.skipIf(!RUN)("C-006: admission cookie authorizes the viewer doc-read (real Postgres, real resolveAccess)", () => {
  let h: MigratedDb;
  let app: ReturnType<typeof createApp>;
  let tokenA = "";
  let tokenB = "";
  let slugA = "";
  let slugB = "";
  let docIdA = "";
  let docIdB = "";

  beforeAll(async () => {
    h = await withMigratedDb();

    // Doc A: anyone_with_link, a markdown doc behind a VIEWER capability link — viewer is enough
    // to READ, and it isolates the grant to the cookie (no membership, no slug write fallback).
    slugA = `vdoc-a-${process.pid}`;
    const a = await createDocRepo(h.db).createDocWithV1({
      slug: slugA,
      title: "Secret Refund Spec",
      kind: "markdown",
      content: "# Hello\n\nworld",
      contentHash: "vhash-a",
    });
    docIdA = a.id;
    // Doc B: a different anyone_with_link viewer-link doc — to prove cross-doc replay is refused.
    slugB = `vdoc-b-${process.pid}`;
    const b = await createDocRepo(h.db).createDocWithV1({
      slug: slugB,
      title: "Other Doc",
      kind: "markdown",
      content: "# Other\n\nbody",
      contentHash: "vhash-b",
    });
    docIdB = b.id;

    tokenA = mintCapabilityToken();
    tokenB = mintCapabilityToken();
    await h.db.insert(shareLinks).values({ docId: docIdA, linkRole: "viewer", capabilityToken: tokenA });
    await h.db.insert(shareLinks).values({ docId: docIdB, linkRole: "viewer", capabilityToken: tokenB });

    const resolveDocRole = createResolveDocRole(h.db, {
      isOwner: createIsDocOwner(h.db),
      isWorkspaceMember: async () => false,
    });
    // PRODUCTION gate wired with the SECRET so the anon branch validates the admission cookie.
    const resolveAccess = createResolveAccess(h.db, { resolveDocRole, secret: SECRET });
    const resolveViewerSession = async (): Promise<{ userId: string } | null> => null; // always anon.

    app = createApp({
      dbCheck: async () => {},
      shareRedeem: {
        resolveCapabilityToken: createCapabilityTokenRepo(h.db),
        secret: SECRET,
        secure: false,
      },
      docViewer: { resolveViewerSession, loaderDeps: { db: h.db, resolveAccess } },
    });
  });

  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  });

  function req(path: string, init: RequestInit = {}) {
    return new Request(`http://localhost${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
  }

  /** Redeem a token via the real route and return the admission cookie value. */
  async function redeem(token: string): Promise<string | undefined> {
    const res = await app.handle(req(`/s/${token}/redeem`, { method: "POST" }));
    const setCookie = res.headers.get("set-cookie");
    return setCookie ? setCookie.split(";")[0]!.split("=").slice(1).join("=") : undefined;
  }

  function readDoc(slug: string, cookie: string | undefined) {
    return app.handle(
      req(`/api/docs/${slug}`, {
        headers: cookie ? { cookie: `${ADMISSION_COOKIE_NAME}=${cookie}` } : {},
      }),
    );
  }

  test("C-006: admission cookie authorizes GET /api/docs/:slug (anon doc-read)", async () => {
    const cookie = await redeem(tokenA);
    expect(cookie).toBeTruthy();

    const res = await readDoc(slugA, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { doc: { title: string }; content: unknown } };
    expect(body.data.doc.title).toBe("Secret Refund Spec");
    expect(typeof body.data.content).toBe("string"); // markdown → sanitized HTML inline.
  });

  test("C-006: GET /api/docs/:slug with NO admission cookie → 404 (anon-without-cookie denied, S-003)", async () => {
    const res = await readDoc(slugA, undefined);
    expect(res.status).toBe(404);
  });

  test("C-006 / AS-020: a doc-A admission cookie does NOT authorize GET /api/docs/:slug for doc B (cross-doc)", async () => {
    const cookieA = await redeem(tokenA);
    expect(cookieA).toBeTruthy();
    const res = await readDoc(slugB, cookieA);
    expect(res.status).toBe(404);
  });
});
