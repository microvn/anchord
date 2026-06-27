// Regression: C-1 cross-tenant manage-sharing — sharing.ts missing doc↔path-workspace bind.
//
// The slug lookup (lookupRepo.findDocBySlug) is GLOBALLY unique and never bound to the
// :workspaceId in the URL path. The manage-sharing gate's workspace-admin override
// (requireManageSharing → isWorkspaceAdmin(workspaceId, userId)) is scoped to the PATH
// workspace. So an admin of workspace A (everyone is admin of their own auto-created
// workspace) can call a manage-sharing mutation on a link-shared doc that lives in
// workspace B by addressing it through /api/w/<A-id>/docs/<B-slug>/… — the admin arm
// fires against the WRONG workspace and returns "owner", letting the attacker rewrite
// B's access.
//
// The fix mirrors doc-delete.ts (C-007): after resolving the doc by slug, the doc's REAL
// workspace must equal the path :workspaceId, else 404 (existence-hiding).

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { SessionResolver } from "../../src/http/auth-gate";
import type { DocLookup, DocLookupRepo } from "../../src/routes/versions";
import type { ShareRepo, ResolvedShareSetting } from "../../src/sharing/share";
import { deriveLevel } from "../../src/sharing/share";

// The attacker — an admin of workspace A, NOT a member/owner of the doc in workspace B.
const attacker: SessionResolver = async () => ({ userId: "u_attacker" });

// A link-shared doc that LIVES in workspace B. resolveAccess.canView passes for any
// logged-in user (link_role is set), so existence-hiding does NOT save us here — only the
// doc↔path-workspace bind does.
const DOC_IN_WS_B: DocLookup = {
  id: "doc_in_B",
  title: "Victim Doc",
  kind: "markdown",
  generalAccess: "anyone_with_link",
};

function fakeLookupRepo(doc: DocLookup): DocLookupRepo {
  return {
    async findDocBySlug() {
      return doc; // global slug lookup — returns B's doc regardless of path workspace
    },
    async getVersionContent() {
      return null;
    },
  };
}

function fakeShareRepo() {
  const calls: ResolvedShareSetting[] = [];
  const repo: ShareRepo = {
    async setGeneralAccess(docId, setting) {
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

function buildApp() {
  const share = fakeShareRepo();
  const app = createApp({
    dbCheck: async () => {},
    sharing: {
      shareRepo: share.repo,
      docMemberRepo: {
        async upsertMember() {},
        async findMember() { return null; },
        // Should NEVER be reached — the doc↔workspace bind 404s before any member write.
        async remove() { throw new Error("docMemberRepo.remove must not be called cross-tenant"); },
        async updateRole() { throw new Error("docMemberRepo.updateRole must not be called cross-tenant"); },
      } as any,
      lookupRepo: fakeLookupRepo(DOC_IN_WS_B),
      findUserByEmail: () => null,
      enqueueInvite: () => {},
      resolveSession: attacker,
      // The attacker is a member (admin) of workspace A — the path workspace passes the
      // member gate. (Everyone is admin of their own workspace.)
      resolveWorkspaceRole: async () => "admin",
      // The attacker has NO per-doc role on B's doc.
      resolveDocRole: async () => null,
      loadShareConfig: async () => ({ editorsCanShare: false }),
      // The workspace-admin override: the attacker IS an admin of the PATH workspace (A).
      isWorkspaceAdmin: async () => true,
      // Link-shared doc → canView passes for any logged-in user. Existence-hiding does NOT
      // catch this; only the doc↔path-workspace bind does.
      resolveAccess: async () => ({ role: null, canView: true }),
      // The doc's REAL workspace is B — NOT the path workspace A.
      workspaceOfDoc: async () => "ws_B",
    },
  });
  return { app, share };
}

describe("C-1: cross-tenant manage-sharing is rejected (doc↔path-workspace bind)", () => {
  test("admin of ws_A cannot PUT access on a link-shared doc that lives in ws_B → 404 (no persist)", async () => {
    const { app, share } = buildApp();
    // Attacker addresses B's doc through THEIR OWN workspace A's path.
    const res = await app.handle(
      req("/api/w/ws_A/docs/victim-doc/access", {
        method: "PUT",
        body: JSON.stringify({ workspaceRole: null, linkRole: "viewer" }),
      }),
    );
    // Existence-hiding (matches doc-delete): a foreign-workspace doc is indistinguishable
    // from a non-existent one → 404, never the 200 that would let the rewrite land.
    expect(res.status).toBe(404);
    expect(share.calls).toHaveLength(0);
  });

  test("admin of ws_A cannot DELETE a member of a doc that lives in ws_B → 404", async () => {
    const { app } = buildApp();
    const res = await app.handle(
      req("/api/w/ws_A/docs/victim-doc/members/some-member-id", { method: "DELETE" }),
    );
    expect(res.status).toBe(404);
  });
});
