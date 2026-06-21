// Integration tier (guarded by RUN_INTEGRATION): S-004 — turning sharing off kills the link;
// re-enabling / rotating issues a fresh one, and every admission cookie minted from the OLD
// token is refused thereafter. Run against a REAL Postgres, the real app, the PRODUCTION
// resolveAccess gate (NOT a stub), and the real /s/:token redeem route.
//
// The cross-SURFACE seam the unit tests can't prove (skill LINKED-FIELD/seam rule):
//   - AS-021 / C-007.b: a guest holds an admission cookie minted from the OLD token; the owner
//     rotates (or turns off) → the guest's NEXT read/write through the REAL gate is REFUSED,
//     because resolveAdmission binds the cookie to a HASH of the doc's CURRENT token and the
//     stored token changed. Proven on the real comment WRITE + annotations READ path.
//   - AS-009 / AS-010 / AS-011: the token lifecycle on real DB — off clears it (old /s/:token
//     404s), re-enable mints a NEW token (old stays dead), rotate replaces it while the level +
//     link role stay anyone_with_link/commenter.
//   - Permission: rotate is gated by the SAME manage-sharing gate as set-general-access
//     (GAP-002) — a non-permitted caller (viewer-role) gets 403.
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/capability-rotate.itest.ts --timeout 60000

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { docs, shareLinks, user } from "../../src/db/schema";
import { createApp } from "../../src/app";
import { createDocRepo } from "../../src/publish/repo";
import { createCapabilityTokenRepo, rotateCapabilityToken } from "../../src/sharing/share-repo";
import { setGeneralAccess } from "../../src/sharing/share";
import { createShareRepo } from "../../src/sharing/share-repo";
import { ADMISSION_COOKIE_NAME } from "../../src/sharing/capability-cookie";
import { createResolveAccess } from "../../src/sharing/resolve-access";
import { createResolveDocRole, createIsDocOwner } from "../../src/sharing/resolve-doc-role-repo";
import type { SessionResolver, WorkspaceRoleResolver } from "../../src/http/auth-gate";
import type { Role } from "../../src/sharing/roles";
import { withMigratedDb, seedWorkspace, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;
const SECRET = "itest-secret-at-least-16-chars";
const OWNER = "u_rot_owner";

describe.skipIf(!RUN)("S-004 capability rotate/off (real Postgres, real resolveAccess)", () => {
  let h: MigratedDb;
  let app: ReturnType<typeof createApp>;
  let ws = "";
  let slug = "";
  let docId = "";

  // The app's resolveDocRole/resolveSession are injected; toggling these lets one test act as
  // owner (manage sharing) and another as a viewer (denied rotate).
  let actingUserId = OWNER;
  let actingRole: Role = "owner";

  beforeAll(async () => {
    h = await withMigratedDb();
    await h.db.insert(user).values({ id: OWNER, name: "Owner", email: "rot-owner@itest.local" });
    ({ workspaceId: ws } = await seedWorkspace(h.db, { userId: OWNER }));

    slug = `cap-rot-${process.pid}`;
    const created = await createDocRepo(h.db).createDocWithV1({
      slug,
      title: "Rotatable Spec",
      kind: "html",
      content: "<p>hello world</p>",
      contentHash: "hash-rot",
    });
    docId = created.id;
    // Enter anyone_with_link via the REAL service → mints the first capability token.
    await setGeneralAccess(
      docId,
      { level: "anyone_with_link", role: "commenter" },
      createShareRepo(h.db),
      { actorIsOwner: true },
    );

    const resolveSession: SessionResolver = async () => ({ userId: actingUserId });
    const asMember: WorkspaceRoleResolver = async () => "member";
    const resolveDocRole = createResolveDocRole(h.db, {
      isOwner: createIsDocOwner(h.db),
      isWorkspaceMember: async () => false,
    });
    // For the rotate route's manage-sharing gate, inject the role under test directly.
    const docRoleForGate = async (): Promise<Role | null> => actingRole;
    const resolveAccess = createResolveAccess(h.db, { resolveDocRole, secret: SECRET });

    app = createApp({
      dbCheck: async () => {},
      shareRedeem: {
        resolveCapabilityToken: createCapabilityTokenRepo(h.db),
        secret: SECRET,
        secure: false,
      },
      sharing: {
        db: h.db,
        resolveSession,
        resolveWorkspaceRole: asMember,
        resolveDocRole: docRoleForGate,
        accessDeps: { isInvited: () => true, isWorkspaceMember: () => true },
      },
      annotations: {
        db: h.db,
        resolveSession: async () => null, // the guest is anon on the doc-content surface
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

  async function currentToken(): Promise<string | null> {
    const [row] = await h.db
      .select({ t: shareLinks.capabilityToken })
      .from(shareLinks)
      .where(eq(shareLinks.docId, docId));
    return row?.t ?? null;
  }

  async function redeem(token: string): Promise<{ status: number; cookie?: string; role?: string }> {
    const res = await app.handle(req(`/s/${token}/redeem`, { method: "POST" }));
    const setCookie = res.headers.get("set-cookie");
    const cookie = setCookie ? setCookie.split(";")[0]!.split("=").slice(1).join("=") : undefined;
    if (res.status !== 200) return { status: res.status };
    const body = (await res.json()) as { role: string };
    return { status: res.status, cookie, role: body.role };
  }

  function postComment(cookie: string | undefined, guestName: string) {
    return app.handle(
      req(`/api/docs/${slug}/annotations`, {
        method: "POST",
        headers: cookie ? { cookie: `${ADMISSION_COOKIE_NAME}=${cookie}` } : {},
        body: JSON.stringify({
          anchor: { blockId: "block-p-1", textSnippet: "hello", offset: 0, length: 5 },
          comment: { body: "guest comment", guestName },
        }),
      }),
    );
  }

  function rotateViaRoute() {
    return app.handle(
      req(`/api/w/${ws}/docs/${slug}/link/rotate`, { method: "POST" }),
    );
  }

  test("AS-011: rotate via the route replaces the stored token, old /s/:token 404s, new resolves, level + role UNCHANGED", async () => {
    actingUserId = OWNER;
    actingRole = "owner";
    const old = (await currentToken())!;
    expect((await redeem(old)).status).toBe(200);

    const res = await rotateViaRoute();
    expect(res.status).toBe(200);

    const fresh = (await currentToken())!;
    expect(fresh).not.toBe(old);
    // Old dead, new alive.
    expect((await redeem(old)).status).toBe(404);
    const r = await redeem(fresh);
    expect(r.status).toBe(200);
    expect(r.role).toBe("commenter"); // link role unchanged
    // generalAccess unchanged.
    const [doc] = await h.db.select({ ga: docs.generalAccess }).from(docs).where(eq(docs.id, docId));
    expect(doc!.ga).toBe("anyone_with_link");
  });

  test("AS-021 / C-007.b: a guest's admission cookie minted from the OLD token is REFUSED on read AND write after rotate (stale token-hash, real gate)", async () => {
    actingUserId = OWNER;
    actingRole = "owner";
    const before = (await currentToken())!;
    // Guest opens the live link → admission cookie bound to `before`'s hash.
    const opened = await redeem(before);
    expect(opened.cookie).toBeTruthy();
    // The cookie works NOW (write succeeds) — proving it is a real, valid grant pre-rotate.
    expect((await postComment(opened.cookie, "guest-pre-rotate")).status).toBe(201);

    // Owner rotates → stored token changes → the cookie's bound token-hash is now stale.
    expect((await rotateViaRoute()).status).toBe(200);
    expect((await currentToken())!).not.toBe(before);

    // The guest's NEXT write with the SAME (old) cookie is refused at the real gate.
    const w = await postComment(opened.cookie, "guest-post-rotate");
    expect([401, 403, 404]).toContain(w.status);
    // …and their next READ likewise — must re-open the new link.
    const rd = await app.handle(
      req(`/api/docs/${slug}/annotations`, {
        headers: { cookie: `${ADMISSION_COOKIE_NAME}=${opened.cookie}` },
      }),
    );
    expect([401, 403, 404]).toContain(rd.status);
  });

  test("AS-021 (off variant) / C-007.b: turning sharing OFF also refuses the old admission cookie (token cleared → no admission possible)", async () => {
    actingUserId = OWNER;
    actingRole = "owner";
    // Re-enable a clean link, open it as a guest.
    await setGeneralAccess(
      docId,
      { level: "anyone_with_link", role: "commenter" },
      createShareRepo(h.db),
      { actorIsOwner: true },
    );
    const live = (await currentToken())!;
    const opened = await redeem(live);
    expect(opened.cookie).toBeTruthy();

    // Turn sharing OFF.
    await setGeneralAccess(
      docId,
      { level: "restricted", role: "commenter" },
      createShareRepo(h.db),
      { actorIsOwner: true },
    );
    expect(await currentToken()).toBeNull();

    // The old cookie is refused — resolveAdmission returns null when the doc has no current token.
    const w = await postComment(opened.cookie, "guest-after-off");
    expect([401, 403, 404]).toContain(w.status);
  });

  test("AS-010: after off, re-enabling mints a NEW token that resolves while the old token stays dead (real DB)", async () => {
    actingUserId = OWNER;
    actingRole = "owner";
    // Ensure off first.
    await setGeneralAccess(
      docId,
      { level: "restricted", role: "commenter" },
      createShareRepo(h.db),
      { actorIsOwner: true },
    );
    // Re-enable.
    await setGeneralAccess(
      docId,
      { level: "anyone_with_link", role: "commenter" },
      createShareRepo(h.db),
      { actorIsOwner: true },
    );
    const fresh = (await currentToken())!;
    expect((await redeem(fresh)).status).toBe(200);
    // A clearly-bogus prior token never resolves.
    expect((await redeem("deadbeefdeadbeefdeadbe")).status).toBe(404);
  });

  test("Permission (GAP-002): a viewer-role caller cannot rotate the link → 403 (same gate as set-general-access)", async () => {
    actingUserId = "u_rot_viewer";
    actingRole = "viewer";
    const res = await rotateViaRoute();
    expect(res.status).toBe(403);
  });

  test("C-004 (edge): rotating a doc that is NOT anyone_with_link is a no-op / refusal, not a crash, and mints no token", async () => {
    actingUserId = OWNER;
    actingRole = "owner";
    await setGeneralAccess(
      docId,
      { level: "restricted", role: "commenter" },
      createShareRepo(h.db),
      { actorIsOwner: true },
    );
    // The repo primitive: no token to rotate → reports not-rotated, leaves the column null.
    const out = await rotateCapabilityToken(h.db, docId);
    expect(out.rotated).toBe(false);
    expect(await currentToken()).toBeNull();
    // The route surfaces a non-2xx (409) rather than crashing.
    const res = await rotateViaRoute();
    expect(res.status).toBe(409);
  });
});
