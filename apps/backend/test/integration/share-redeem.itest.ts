// Integration tier (guarded by RUN_INTEGRATION): the capability-link redeem → admission →
// read + write seam against a REAL Postgres, via the real app + the real capability-token repo.
//
// These are the CROSS-SURFACE seams the unit tests can't prove (skill LINKED-FIELD/seam rule):
//   - AS-006 / C-006: the admission cookie minted by redeem authorizes the WRITE path — a
//     no-account guest holding a commenter capability link can post a comment, attributed to
//     the guest name, through the REAL doc-addressed comment route (not a mocked cookie check).
//   - AS-020 / C-007.a: a cookie minted for doc A is refused on doc B — the binding runs against
//     the REAL token the capability-token repo reads back, not a fake.
//
// resolveSession returns null (no account) so the guest path is exercised; the doc is a real
// anyone_with_link doc with a real minted capability token.
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
import type { SessionResolver, WorkspaceRoleResolver } from "../../src/http/auth-gate";
import { withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;
const SECRET = "itest-secret-at-least-16-chars";
const noSession: SessionResolver = async () => null; // every caller is an anon guest.
const asMember: WorkspaceRoleResolver = async () => "member";

describe.skipIf(!RUN)("capability-link redeem → admission seam (real Postgres)", () => {
  let h: MigratedDb;
  let app: ReturnType<typeof createApp>;
  let tokenA = "";
  let tokenB = "";
  let slugA = "";
  let docIdA = "";
  let docIdB = "";

  beforeAll(async () => {
    h = await withMigratedDb();

    // Two real anyone_with_link docs, each with its own minted capability token + a commenter link.
    slugA = `cap-a-${process.pid}`;
    const a = await createDocRepo(h.db).createDocWithV1({
      slug: slugA,
      title: "Secret Refund Spec",
      kind: "html",
      content: "<p>hello world</p>",
      contentHash: "hash-a",
    });
    docIdA = a.id;
    const b = await createDocRepo(h.db).createDocWithV1({
      slug: `cap-b-${process.pid}`,
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
      .values({ docId: docIdB, role: "commenter", capabilityToken: tokenB });

    app = createApp({
      dbCheck: async () => {},
      // The redeem surface under test, wired to the REAL token repo.
      shareRedeem: {
        resolveCapabilityToken: createCapabilityTokenRepo(h.db),
        secret: SECRET,
        secure: false,
      },
      // The doc-addressed read + the guest comment WRITE path (session-optional). resolveAccess
      // admits an anon on an anyone_with_link doc at the link role (the pre-S-003 behaviour); the
      // point of THIS test is that the redeem-minted cookie rides the write, end-to-end on real DB.
      annotations: {
        db: h.db,
        resolveSession: noSession,
        resolveWorkspaceRole: asMember,
        resolveDocRole: async () => "viewer" as const,
        resolveAccess: async (_docId, viewer) =>
          viewer.kind === "user"
            ? { role: "owner" as const, canView: true }
            : { role: "commenter" as const, canView: true },
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

  test("AS-006 / C-006: a commenter capability link lets a no-account guest comment (admission cookie authorizes the WRITE path)", async () => {
    // Given an anon visitor opens doc A's commenter capability link → admission cookie + slug.
    const redeemed = await redeem(tokenA);
    expect(redeemed.status).toBe(200);
    expect(redeemed.slug).toBe(slugA);
    expect(redeemed.role).toBe("commenter");
    expect(redeemed.cookie).toBeTruthy();

    // C-006: the SAME cookie authorizes the doc-addressed comment WRITE — a guest creates an
    // annotation carrying a first comment under their guest session name, on the REAL route + DB.
    const createRes = await app.handle(
      req(`/api/docs/${slugA}/annotations`, {
        method: "POST",
        headers: { cookie: `${ADMISSION_COOKIE_NAME}=${redeemed.cookie}` },
        body: JSON.stringify({
          anchor: { blockId: "block-p-1", textSnippet: "hello", offset: 0, length: 5 },
          comment: { body: "guest feedback via capability link", guestName: "calm-falcon-znmy" },
        }),
      }),
    );
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

  test("AS-020 / C-007.a: an admission cookie for doc A does not open doc B (cross-doc replay, real tokens)", async () => {
    // Given the guest holds doc A's admission cookie.
    const redeemed = await redeem(tokenA);
    expect(redeemed.cookie).toBeTruthy();

    // The binding runs against the REAL tokens the capability-token repo reads back. The cookie is
    // valid for A with A's current token...
    const repo = createCapabilityTokenRepo(h.db);
    const targetA = await repo(tokenA);
    const targetB = await repo(tokenB);
    expect(targetA!.docId).toBe(docIdA);
    expect(targetB!.docId).toBe(docIdB);

    // ...accepted against doc A (its docId + current token)...
    expect(resolveAdmission(redeemed.cookie, docIdA, tokenA, SECRET)).not.toBeNull();
    // ...but REFUSED against doc B even using B's own current token — the cookie is bound to A's
    // docId, so it can never admit on B (the gate S-003 will apply on B's anon read).
    expect(resolveAdmission(redeemed.cookie, docIdB, tokenB, SECRET)).toBeNull();
  });

  test("AS-005: redeeming a token that matches no doc → 404, no admission cookie", async () => {
    const res = await app.handle(req(`/s/${mintCapabilityToken()}/redeem`, { method: "POST" }));
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
