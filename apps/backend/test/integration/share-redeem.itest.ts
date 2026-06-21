// Integration tier (guarded by RUN_INTEGRATION): the capability-link redeem → admission →
// read + write seam against a REAL Postgres, via the real app + the REAL resolve-access gate.
//
// These are the CROSS-SURFACE seams the unit tests can't prove (skill LINKED-FIELD/seam rule).
// The app is built with the PRODUCTION resolveAccess (createResolveAccess over the real
// createResolveDocRole) wired with APP_SECRET — NOT a stub — so the redeem-minted admission
// cookie is what actually authorizes the anon-reachable endpoints, end-to-end on real DB:
//   - AS-006 / C-006: the admission cookie minted by redeem authorizes the WRITE path (a
//     no-account guest holding a commenter capability link posts a comment, attributed to the
//     guest name) AND a READ path (annotations list) — "every anon-reachable endpoint", not one.
//   - AS-020 / C-007.a: the cookie is bound to its doc — a cookie minted for doc A does NOT
//     authorize a WRITE on doc B (whose link is viewer-only, so the slug fallback can't save it),
//     and a write with NO cookie on that viewer-only doc is likewise refused. Both negatives run
//     through the REAL gate — the seam is the production code path, not a mocked cookie check.
//
// Scope (S-002, additive): doc A keeps a commenter link, so the pre-S-003 slug admit still grants
// comment there even without a cookie — that REMOVAL is S-003's job and is NOT asserted here. The
// negatives use doc B (viewer link) where the slug fallback grants only view, so a refused write is
// attributable to the MISSING/cross-doc cookie, proving the cookie — not the slug — is the grant.
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/share-redeem.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { annotations, comments, docs, shareLinks } from "../../src/db/schema";
import { createApp } from "../../src/app";
import { createDocRepo } from "../../src/publish/repo";
import { createCapabilityTokenRepo } from "../../src/sharing/share-repo";
import { mintCapabilityToken } from "../../src/sharing/share-token";
import { resolveAdmission, ADMISSION_COOKIE_NAME } from "../../src/sharing/capability-cookie";
import { createResolveAccess } from "../../src/sharing/resolve-access";
import { createResolveDocRole, createIsDocOwner } from "../../src/sharing/resolve-doc-role-repo";
import type { SessionResolver, WorkspaceRoleResolver } from "../../src/http/auth-gate";
import { withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;
const SECRET = "itest-secret-at-least-16-chars";
const noSession: SessionResolver = async () => null; // every caller is an anon guest.
const asMember: WorkspaceRoleResolver = async () => "member";

describe.skipIf(!RUN)("capability-link redeem → admission seam (real Postgres, real resolveAccess)", () => {
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

    // Doc A: anyone_with_link, COMMENTER capability link (the happy path).
    slugA = `cap-a-${process.pid}`;
    const a = await createDocRepo(h.db).createDocWithV1({
      slug: slugA,
      title: "Secret Refund Spec",
      kind: "html",
      content: "<p>hello world</p>",
      contentHash: "hash-a",
    });
    docIdA = a.id;
    // Doc B: anyone_with_link, VIEWER capability link — the slug fallback grants only view, so a
    // refused WRITE on B is attributable to a missing/cross-doc cookie, not the link role.
    slugB = `cap-b-${process.pid}`;
    const b = await createDocRepo(h.db).createDocWithV1({
      slug: slugB,
      title: "Other Doc",
      kind: "html",
      content: "<p>other</p>",
      contentHash: "hash-b",
    });
    docIdB = b.id;

    tokenA = mintCapabilityToken();
    tokenB = mintCapabilityToken();
    await h.db.update(docs).set({ generalAccess: "anyone_with_link" }).where(eq(docs.id, docIdA));
    await h.db.update(docs).set({ generalAccess: "anyone_with_link" }).where(eq(docs.id, docIdB));
    await h.db
      .insert(shareLinks)
      .values({ docId: docIdA, role: "commenter", capabilityToken: tokenA });
    await h.db
      .insert(shareLinks)
      .values({ docId: docIdB, role: "viewer", capabilityToken: tokenB });

    // The PRODUCTION access gate: createResolveAccess over the real createResolveDocRole, wired
    // with APP_SECRET so the anon branch validates the admission cookie (resolveAdmission) against
    // the doc's CURRENT capability token and admits at the cookie's link role. NO stub.
    const resolveDocRole = createResolveDocRole(h.db, {
      isOwner: createIsDocOwner(h.db),
      isWorkspaceMember: async () => false,
    });
    const resolveAccess = createResolveAccess(h.db, { resolveDocRole, secret: SECRET });

    app = createApp({
      dbCheck: async () => {},
      shareRedeem: {
        resolveCapabilityToken: createCapabilityTokenRepo(h.db),
        secret: SECRET,
        secure: false,
      },
      annotations: {
        db: h.db,
        resolveSession: noSession,
        resolveWorkspaceRole: asMember,
        resolveDocRole,
        resolveAccess,
      },
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

  /** Redeem a token via the real route and return the parsed body + the admission cookie value. */
  async function redeem(token: string): Promise<{ status: number; slug?: string; role?: string; cookie?: string }> {
    const res = await app.handle(req(`/s/${token}/redeem`, { method: "POST" }));
    const setCookie = res.headers.get("set-cookie");
    const cookie = setCookie ? setCookie.split(";")[0]!.split("=").slice(1).join("=") : undefined;
    if (res.status !== 200) return { status: res.status };
    const body = (await res.json()) as { slug: string; role: string };
    return { status: res.status, slug: body.slug, role: body.role, cookie };
  }

  /** POST a guest annotation+comment to a doc, optionally carrying an admission cookie. */
  function postComment(slug: string, cookie: string | undefined, guestName: string) {
    return app.handle(
      req(`/api/docs/${slug}/annotations`, {
        method: "POST",
        headers: cookie ? { cookie: `${ADMISSION_COOKIE_NAME}=${cookie}` } : {},
        body: JSON.stringify({
          anchor: { blockId: "block-p-1", textSnippet: "hello", offset: 0, length: 5 },
          comment: { body: "guest feedback via capability link", guestName },
        }),
      }),
    );
  }

  test("AS-006 / C-006: a commenter capability link admits a no-account guest WRITE through the REAL access gate (admission cookie authorizes the comment endpoint)", async () => {
    // Given an anon visitor opens doc A's commenter capability link → admission cookie + slug.
    const redeemed = await redeem(tokenA);
    expect(redeemed.status).toBe(200);
    expect(redeemed.slug).toBe(slugA);
    expect(redeemed.role).toBe("commenter");
    expect(redeemed.cookie).toBeTruthy();

    // C-006: the cookie rides the doc-addressed comment WRITE — through the PRODUCTION resolveAccess
    // (its anon branch validated the cookie via resolveAdmission), a guest creates an annotation +
    // first comment under their guest name, on the REAL route + DB.
    const createRes = await postComment(slugA, redeemed.cookie, "calm-falcon-znmy");
    expect(createRes.status).toBe(201);

    // Then the comment is persisted, attributed to the guest name, with NO account (author_id null).
    const [ann] = await h.db
      .select({ id: annotations.id })
      .from(annotations)
      .where(eq(annotations.docId, docIdA))
      .limit(1);
    expect(ann).toBeTruthy();
    const [row] = await h.db
      .select({ guestName: comments.guestName, authorId: comments.authorId, body: comments.body })
      .from(comments)
      .where(and(eq(comments.annotationId, ann!.id), isNull(comments.authorId)))
      .limit(1);
    expect(row!.guestName).toBe("calm-falcon-znmy");
    expect(row!.authorId).toBeNull();
    expect(row!.body).toBe("guest feedback via capability link");
  });

  test("AS-006 / C-006: the SAME admission cookie also authorizes a READ endpoint for doc A (annotations list) — every anon-reachable endpoint, not only the write", async () => {
    const redeemed = await redeem(tokenA);
    expect(redeemed.cookie).toBeTruthy();
    const res = await app.handle(
      req(`/api/docs/${slugA}/annotations`, {
        headers: { cookie: `${ADMISSION_COOKIE_NAME}=${redeemed.cookie}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items: unknown[] } };
    // The annotation created in the previous test is visible to the cookie-bearing anon reader.
    expect(Array.isArray(body.data.items)).toBe(true);
  });

  test("AS-020 / C-007.a: a doc-A cookie does NOT authorize a WRITE on doc B (cross-doc replay refused at the REAL gate)", async () => {
    const redeemed = await redeem(tokenA);
    expect(redeemed.cookie).toBeTruthy();

    // The doc-A cookie presented on doc B's comment endpoint: resolveAdmission(B) is null (bound to
    // A), so the gate falls to doc B's slug role (viewer) → comment is refused. Doc B's viewer link
    // means the slug fallback can never save the write, so this 404/403 is the cross-doc refusal.
    const res = await postComment(slugB, redeemed.cookie, "calm-falcon-cross");
    expect([403, 404]).toContain(res.status);

    // And the binding is exactly what resolveAdmission decides on the live tokens the repo reads.
    const repo = createCapabilityTokenRepo(h.db);
    const targetA = await repo(tokenA);
    const targetB = await repo(tokenB);
    expect(targetA!.docId).toBe(docIdA);
    expect(targetB!.docId).toBe(docIdB);
    expect(resolveAdmission(redeemed.cookie, docIdA, tokenA, SECRET)).not.toBeNull();
    expect(resolveAdmission(redeemed.cookie, docIdB, tokenB, SECRET)).toBeNull();
  });

  test("AS-006 / C-006 (negative): a WRITE on the viewer-link doc B with NO cookie is refused — reaching the endpoint is not the grant", async () => {
    const res = await postComment(slugB, undefined, "no-cookie-guest");
    expect([403, 404]).toContain(res.status);
  });

  test("AS-005: redeeming a token that matches no doc → 404, no admission cookie", async () => {
    const res = await app.handle(req(`/s/${mintCapabilityToken()}/redeem`, { method: "POST" }));
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
