// In-process route tests (auth-routes S-002) proving the OWNER source now resolves for
// real on the manage-sharing gate of PUT /api/docs/:slug/access. Unlike
// test/routes/sharing-routes.test.ts (which injects a flat role), these build
// resolveDocRole from the REAL createResolveDocRole over a fake DB + an injected
// `isOwner`, so the assertion is "owner folds into effectiveRole → canManageSharing".
//
//   AS-003  owner (isOwner true)            → PUT access allowed (200)
//   AS-004  viewer (not owner, invited)     → 403 (viewers never manage sharing)
//   C-004   commenter (not owner, invited)  → 403 (commenter never manages sharing)
//
// app.handle(Request)→Response; no Postgres (fake DB returns seeded rows per table).

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import { docs, docMembers, shareLinks } from "../../src/db/schema";
import type { DB } from "../../src/db/client";
import type { SessionResolver } from "../../src/http/auth-gate";
import { createResolveDocRole } from "../../src/sharing/resolve-doc-role-repo";
import type { DocLookup, DocLookupRepo } from "../../src/routes/versions";
import type { ShareRepo, ResolvedShareSetting } from "../../src/sharing/share";
import { deriveLevel } from "../../src/sharing/share";

const session: SessionResolver = async () => ({ userId: "u_actor" });

const VISIBLE_DOC: DocLookup = {
  id: "doc_1",
  title: "Doc One",
  kind: "markdown",
  generalAccess: "restricted", // restricted → no link role; role comes from owner/invite only
};

function fakeLookupRepo(doc: DocLookup): DocLookupRepo {
  return {
    async findDocBySlug() {
      return doc;
    },
    async getVersionContent() {
      return null;
    },
  };
}

/** Fake Drizzle path: select(cols).from(table).where(cond) → seeded rows per table. */
function fakeDb(seed: { memberRows?: Array<{ role: string }> }): DB {
  const rowsFor = (table: unknown): Array<Record<string, unknown>> => {
    if (table === docs) return [{ generalAccess: "restricted" }];
    if (table === docMembers) return seed.memberRows ?? [];
    if (table === shareLinks) return [];
    return [];
  };
  return {
    select() {
      return {
        from(table: unknown) {
          const rows = rowsFor(table);
          return { where: async () => rows };
        },
      };
    },
  } as unknown as DB;
}

function fakeShareRepo() {
  const calls: ResolvedShareSetting[] = [];
  const repo: ShareRepo = {
    async setGeneralAccess(docId, setting) {
      // Partial-update (C-011): an absent axis resolves to null (the route sends both here).
      const workspaceRole = setting.workspaceRole ?? null;
      const linkRole = setting.linkRole ?? null;
      const resolved: ResolvedShareSetting = {
        docId,
        workspaceRole,
        linkRole,
        level: deriveLevel(workspaceRole, linkRole),
        editorsCanShare: setting.editorsCanShare ?? true,
        capabilityToken: linkRole != null ? "Hk3vQ2pLm8rT5wXyZ0aBcD" : null,
      };
      calls.push(resolved);
      return resolved;
    },
  };
  return { repo, calls };
}

function req(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function buildApp(opts: { isOwner: boolean; memberRows?: Array<{ role: string }> }) {
  const share = fakeShareRepo();
  const db = fakeDb({ memberRows: opts.memberRows });
  // The REAL resolver — owner is folded via createResolveDocRole's effectiveRole path.
  const resolveDocRole = createResolveDocRole(db, {
    isOwner: async () => opts.isOwner,
    isWorkspaceMember: () => false,
  });
  const app = createApp({
    dbCheck: async () => {},
    sharing: {
      shareRepo: share.repo,
      docMemberRepo: { async upsertMember() {}, async findMember() { return null; } } as any,
      lookupRepo: fakeLookupRepo(VISIBLE_DOC),
      findUserByEmail: () => null,
      enqueueInvite: () => {},
      resolveSession: session,
      resolveWorkspaceRole: async () => "member",
      resolveDocRole,
      loadShareConfig: async () => ({ editorsCanShare: false }), // toggle OFF → only owner can manage
      // doc-access-two-axis S-004 / C-010: read gate via the ONE authoritative resolveAccess
      // (canViewDoc retired). VISIBLE_DOC is admitted; the manage gate (resolveDocRole) still decides.
      resolveAccess: async () => ({ role: "owner", canView: true }),
    },
  });
  return { app, share };
}

describe("PUT /api/docs/:slug/access — owner source resolved for real (auth-routes S-002)", () => {
  test("AS-003: the owner can manage sharing (isOwner true → resolves owner → 200, saved)", async () => {
    const { app, share } = buildApp({ isOwner: true });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/access", {
        method: "PUT",
        body: JSON.stringify({ workspaceRole: null, linkRole: "commenter" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(share.calls).toHaveLength(1); // saved
    expect(share.calls[0]?.level).toBe("anyone_with_link");
  });

  test("AS-004: a viewer (not owner, invited viewer) cannot manage sharing → 403 (no persist)", async () => {
    const { app, share } = buildApp({ isOwner: false, memberRows: [{ role: "viewer" }] });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/access", {
        method: "PUT",
        body: JSON.stringify({ workspaceRole: null, linkRole: "commenter" }),
      }),
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("FORBIDDEN");
    expect(share.calls).toHaveLength(0);
  });

  test("C-004: a commenter (not owner, invited commenter) can never manage sharing → 403", async () => {
    const { app, share } = buildApp({ isOwner: false, memberRows: [{ role: "commenter" }] });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/access", {
        method: "PUT",
        body: JSON.stringify({ workspaceRole: null, linkRole: "commenter" }),
      }),
    );
    expect(res.status).toBe(403);
    expect(share.calls).toHaveLength(0);
  });
});
