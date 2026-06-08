// Integration tier (guarded by RUN_INTEGRATION): the full route→service→DB path for the
// sharing-permissions /api/docs/:slug/{access,invites,link} routes against a REAL Postgres.
// Proves the concrete repos persist + read back over the HTTP envelope:
//   - PUT access  → docs.general_access updated + share_links row upserted (role + guest).
//   - POST invite (no account) → a PENDING doc_members row.
//   - PUT link (password) → an argon2id hash stored in share_links.password_hash.
//   - createResolveDocRole: an invited (ACTIVE) editor resolves to "editor".
//
// The better-auth cookie flow is heavy to drive in-test, so resolveSession +
// resolveDocRole are injected with fakes (a member acting as owner) — the point of THIS
// test is the live DB read/write, not auth. The invited-editor resolution uses the REAL
// createResolveDocRole over the seeded doc_members row.
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/sharing-routes.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { docs, docMembers, shareLinks, user } from "../../src/db/schema";
import { createApp } from "../../src/app";
import { createDocRepo } from "../../src/publish/repo";
import { createResolveDocRole, createLoadShareConfig } from "../../src/sharing/resolve-doc-role-repo";
import type { SessionResolver } from "../../src/http/auth-gate";
import type { Role } from "../../src/sharing/roles";
import { withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;
const owner: SessionResolver = async () => ({ userId: "u_owner_itest" });
const asOwner = async (): Promise<Role | null> => "owner";

describe.skipIf(!RUN)("sharing-permissions routes (real Postgres)", () => {
  let h: MigratedDb;
  let app: ReturnType<typeof createApp>;
  let slug: string;
  let docId: string;

  beforeAll(async () => {
    h = await withMigratedDb();
    // Seed the inviter user (doc_members.invited_by → user.id FK).
    await h.db.insert(user).values({
      id: "u_owner_itest",
      name: "Owner",
      email: "owner@itest.local",
    });
    slug = `sharing-${process.pid}`;
    const created = await createDocRepo(h.db).createDocWithV1({
      slug,
      title: "Shared Doc",
      kind: "markdown",
      content: "# v1\n",
      contentHash: "hash-v1",
    });
    docId = created.id;
    // anyone_with_link so the fake owner member can view (existence-hiding passes).
    await h.db.update(docs).set({ generalAccess: "anyone_with_link" }).where(eq(docs.id, docId));

    app = createApp({
      dbCheck: async () => {},
      sharing: {
        db: h.db,
        resolveSession: owner,
        resolveDocRole: asOwner, // owner gate; the owner SOURCE is the auth seam.
        accessDeps: { isInvited: () => true, isWorkspaceMember: () => true },
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
      headers: { "content-type": "application/json" },
      ...init,
    });
  }

  test("PUT access → docs.general_access updated + share_links row persisted (role + guest)", async () => {
    const res = await app.handle(
      req(`/api/docs/${slug}/access`, {
        method: "PUT",
        body: JSON.stringify({ level: "anyone_with_link", role: "commenter", guestCommenting: true }),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data).toEqual({
      level: "anyone_with_link",
      role: "commenter",
      guestCommenting: true,
      editorsCanShare: true, // default on (C-015), no toggle in this request
    });

    const [doc] = await h.db.select().from(docs).where(eq(docs.id, docId));
    expect(doc?.generalAccess).toBe("anyone_with_link");
    const [link] = await h.db.select().from(shareLinks).where(eq(shareLinks.docId, docId));
    expect(link?.role).toBe("commenter");
    expect(link?.guestCommenting).toBe(true);
    expect(link?.editorsCanShare).toBe(true); // default-on column persisted
  });

  test("AS-022 / C-015: owner sets editors_can_share=false → persisted; loadShareConfig reads it back", async () => {
    const res = await app.handle(
      req(`/api/docs/${slug}/access`, {
        method: "PUT",
        body: JSON.stringify({ level: "anyone_with_link", role: "commenter", editorsCanShare: false }),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.editorsCanShare).toBe(false);

    // Persisted on the row.
    const [link] = await h.db.select().from(shareLinks).where(eq(shareLinks.docId, docId));
    expect(link?.editorsCanShare).toBe(false);

    // The concrete loader (the gate's input) reads the stored toggle.
    const cfg = await createLoadShareConfig(h.db)(docId);
    expect(cfg.editorsCanShare).toBe(false);

    // Reset to on so later tests (editor-can-share) see the default again.
    await app.handle(
      req(`/api/docs/${slug}/access`, {
        method: "PUT",
        body: JSON.stringify({ level: "anyone_with_link", role: "commenter", editorsCanShare: true }),
      }),
    );
  });

  test("POST invite (no account) → a PENDING doc_members row", async () => {
    const res = await app.handle(
      req(`/api/docs/${slug}/invites`, {
        method: "POST",
        body: JSON.stringify({ email: "Pending@Invitee.com", role: "editor" }),
      }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.data.status).toBe("pending");

    const rows = await h.db
      .select()
      .from(docMembers)
      .where(and(eq(docMembers.docId, docId), eq(docMembers.email, "pending@invitee.com")));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.userId).toBeNull();
    expect(rows[0]?.role).toBe("editor");
  });

  test("PUT link (password) → an argon2id hash stored in share_links.password_hash", async () => {
    const res = await app.handle(
      req(`/api/docs/${slug}/link`, {
        method: "PUT",
        body: JSON.stringify({ password: "s3cret-link-pw", viewLimit: 10 }),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.passwordSet).toBe(true);
    expect(json.data.viewLimit).toBe(10);

    const [link] = await h.db.select().from(shareLinks).where(eq(shareLinks.docId, docId));
    expect(link?.passwordHash).toBeTruthy();
    expect(link?.passwordHash).not.toBe("s3cret-link-pw"); // hashed, not plaintext
    expect(link?.passwordHash?.startsWith("$argon2")).toBe(true);
    expect(link?.viewLimit).toBe(10);
  });

  test("createResolveDocRole: an invited ACTIVE editor resolves to 'editor'", async () => {
    // Seed the invitee user + an ACTIVE editor doc_members row binding them to the doc.
    await h.db.insert(user).values({
      id: "u_invited_editor",
      name: "Invited Editor",
      email: "editor@itest.local",
    });
    await h.db.insert(docMembers).values({
      docId,
      userId: "u_invited_editor",
      email: "editor@itest.local",
      role: "editor",
      invitedBy: "u_owner_itest",
      status: "active",
    });

    // Resolve over the REAL DB. The link role on this doc is currently "commenter"
    // (anyone_with_link, set above) — effectiveRole takes the HIGHER of invited=editor
    // vs link=commenter → editor (C-002/AS-013), and owner source is seamed false.
    const resolve = createResolveDocRole(h.db, {
      isOwner: async () => false,
      isWorkspaceMember: () => true,
    });
    const role = await resolve(docId, "u_invited_editor");
    expect(role).toBe("editor");

    // A user with no invite + no owner source resolves via the link role only → commenter.
    const linkOnly = await resolve(docId, "u_random_viewer");
    expect(linkOnly).toBe("commenter");
  });

  test("AS-014: an invited editor (real resolution) CAN PUT access when editors_can_share is on", async () => {
    // Ensure the toggle is ON for this doc.
    await app.handle(
      req(`/api/docs/${slug}/access`, {
        method: "PUT",
        body: JSON.stringify({ level: "anyone_with_link", role: "commenter", editorsCanShare: true }),
      }),
    );

    // Build an app where the session is the invited editor (seeded in the prior test) and
    // the role + toggle resolve over the REAL DB (no owner source).
    const realResolve = createResolveDocRole(h.db, {
      isOwner: async () => false,
      isWorkspaceMember: () => true,
    });
    const editorApp = createApp({
      dbCheck: async () => {},
      sharing: {
        db: h.db,
        resolveSession: async () => ({ userId: "u_invited_editor" }),
        resolveDocRole: realResolve,
        loadShareConfig: createLoadShareConfig(h.db),
        accessDeps: { isInvited: () => true, isWorkspaceMember: () => true },
      },
    });

    const res = await editorApp.handle(
      req(`/api/docs/${slug}/access`, {
        method: "PUT",
        body: JSON.stringify({ level: "anyone_with_link", role: "editor" }),
      }),
    );
    expect(res.status).toBe(200); // editor manages sharing (toggle on, real role resolution)

    // C-015: the same editor may NOT flip editors_can_share → 403.
    const toggleRes = await editorApp.handle(
      req(`/api/docs/${slug}/access`, {
        method: "PUT",
        body: JSON.stringify({ level: "anyone_with_link", role: "editor", editorsCanShare: false }),
      }),
    );
    expect(toggleRes.status).toBe(403);
  });
});
