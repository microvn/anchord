// Integration tier (guarded by RUN_INTEGRATION): the capability-link admission cookie must
// authorize the SANDBOX CONTENT read — GET /v/:id — through the REAL app + the REAL
// resolveAccess gate, on real Postgres. This is the LAST C-006 seam that missed the cookie:
// HTML/image docs serve their actual content via the sandboxed iframe route /v/:id (markdown
// renders inline in the doc-read payload, so markdown never hits /v). The /v/:id route built
// the anon Viewer WITHOUT the admission cookie, so an anon capability visitor got the shell +
// annotations (those honor the cookie now) but the iframe content request 404'd.
//
//   - C-006: an anon GET /v/:id carrying a VALID admission cookie (minted by redeem for THIS
//     doc + current token) serves the content (200 + body).
//   - S-003: the SAME request with NO cookie → 404 (anon-without-cookie denied).
//   - AS-020 / C-007.a: a cookie minted for doc A presented on doc B's version → 404 (cross-doc).
//
// The doc under test is an HTML doc (markdown doesn't use /v/:id). The app is built with the
// PRODUCTION resolveAccess + loadContent wired with APP_SECRET (NOT a stub), so the cookie is
// what actually authorizes the content read end-to-end. Models share-viewer-doc.itest.ts.
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/share-viewer-content.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { docs, docVersions, shareLinks } from "../../src/db/schema";
import { createApp } from "../../src/app";
import { createDocRepo } from "../../src/publish/repo";
import { createCapabilityTokenRepo } from "../../src/sharing/share-repo";
import { mintCapabilityToken } from "../../src/sharing/share-token";
import { ADMISSION_COOKIE_NAME } from "../../src/sharing/capability-cookie";
import { createResolveAccess } from "../../src/sharing/resolve-access";
import { createResolveDocRole, createIsDocOwner } from "../../src/sharing/resolve-doc-role-repo";
import { createLoadContent } from "../../src/render/viewer-loaders";
import { withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;
const SECRET = "itest-secret-at-least-16-chars";

describe.skipIf(!RUN)("C-006: admission cookie authorizes GET /v/:id (anon HTML/image content read)", () => {
  let h: MigratedDb;
  let app: ReturnType<typeof createApp>;
  let tokenA = "";
  let tokenB = "";
  let versionIdA = "";
  let versionIdB = "";

  beforeAll(async () => {
    h = await withMigratedDb();

    // Doc A: anyone_with_link HTML doc behind a VIEWER capability link. HTML content is served
    // ONLY through /v/:id (the sandbox surface) — never inline — so this is the exact /v seam.
    const slugA = `vcontent-a-${process.pid}`;
    const a = await createDocRepo(h.db).createDocWithV1({
      slug: slugA,
      title: "Secret HTML Spec",
      kind: "html",
      content: "<h1>Hello from the sandbox</h1>",
      contentHash: "vchash-a",
    });
    const docIdA = a.id;
    // Doc B: a different anyone_with_link HTML doc — to prove cross-doc replay is refused.
    const slugB = `vcontent-b-${process.pid}`;
    const b = await createDocRepo(h.db).createDocWithV1({
      slug: slugB,
      title: "Other HTML",
      kind: "html",
      content: "<h1>Other body</h1>",
      contentHash: "vchash-b",
    });
    const docIdB = b.id;

    // Grab each doc's v1 version id — that is the /v/:id addressee.
    [{ id: versionIdA }] = await h.db
      .select({ id: docVersions.id })
      .from(docVersions)
      .where(eq(docVersions.docId, docIdA));
    [{ id: versionIdB }] = await h.db
      .select({ id: docVersions.id })
      .from(docVersions)
      .where(eq(docVersions.docId, docIdB));

    tokenA = mintCapabilityToken();
    tokenB = mintCapabilityToken();
    await h.db.update(docs).set({ generalAccess: "anyone_with_link" }).where(eq(docs.id, docIdA));
    await h.db.update(docs).set({ generalAccess: "anyone_with_link" }).where(eq(docs.id, docIdB));
    await h.db.insert(shareLinks).values({ docId: docIdA, role: "viewer", capabilityToken: tokenA });
    await h.db.insert(shareLinks).values({ docId: docIdB, role: "viewer", capabilityToken: tokenB });

    const resolveDocRole = createResolveDocRole(h.db, {
      isOwner: createIsDocOwner(h.db),
      isWorkspaceMember: async () => false,
    });
    // PRODUCTION gate wired with the SECRET so the anon branch validates the admission cookie.
    const resolveAccess = createResolveAccess(h.db, { resolveDocRole, secret: SECRET });
    const loadContent = createLoadContent({ db: h.db, resolveAccess });
    const resolveViewerSession = async (): Promise<{ userId: string } | null> => null; // always anon.

    app = createApp({
      dbCheck: async () => {},
      shareRedeem: {
        resolveCapabilityToken: createCapabilityTokenRepo(h.db),
        secret: SECRET,
        secure: false,
      },
      // The /v/:id sandbox content route under test.
      loadContent,
      resolveViewerSession,
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

  /** Redeem a token via the real route and return the admission cookie value. */
  async function redeem(token: string): Promise<string | undefined> {
    const res = await app.handle(
      req(`/s/${token}/redeem`, { method: "POST", headers: { "content-type": "application/json" } }),
    );
    const setCookie = res.headers.get("set-cookie");
    return setCookie ? setCookie.split(";")[0]!.split("=").slice(1).join("=") : undefined;
  }

  function readContent(versionId: string, cookie: string | undefined) {
    return app.handle(
      req(`/v/${versionId}`, {
        headers: cookie ? { cookie: `${ADMISSION_COOKIE_NAME}=${cookie}` } : {},
      }),
    );
  }

  test("C-006: admission cookie authorizes GET /v/:id (anon HTML content read)", async () => {
    const cookie = await redeem(tokenA);
    expect(cookie).toBeTruthy();

    const res = await readContent(versionIdA, cookie);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Hello from the sandbox");
  });

  test("C-006: GET /v/:id with NO admission cookie → 404 (anon-without-cookie denied, S-003)", async () => {
    const res = await readContent(versionIdA, undefined);
    expect(res.status).toBe(404);
  });

  test("C-006 / AS-020: a doc-A admission cookie does NOT authorize GET /v/:id for doc B's version (cross-doc)", async () => {
    const cookieA = await redeem(tokenA);
    expect(cookieA).toBeTruthy();
    const res = await readContent(versionIdB, cookieA);
    expect(res.status).toBe(404);
  });
});
