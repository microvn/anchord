// In-process route test for workspace-activity S-006: the `share` event emitted when a doc's
// general access changes (AS-022). EMIT GLUE only (no DB): a fake ActivityRepo captures the row
// the PUT …/access route writes post-commit; fake share/lookup repos + session/role/access
// resolvers run route→service without Postgres.
//
// AS map (workspace-activity S-006):
//   AS-022  share change → ONE `share` event recording the NEW access + role (new-state-only, F-10)
//   C-005   each action logs exactly one event of its originating type

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { SessionResolver } from "../../src/http/auth-gate";
import type { NewActivity, ActivityRepo, ActivityRow } from "../../src/activity/repo";
import type { ShareRepo } from "../../src/sharing/share";
import type { DocLookupRepo } from "../../src/routes/versions";

const owner: SessionResolver = async () => ({ userId: "u_devin" });

function fakeActivityRepo() {
  const rows: NewActivity[] = [];
  let seq = 0;
  const repo: ActivityRepo = {
    async insertActivity(input) {
      rows.push(input);
      return { id: `act_${++seq}` };
    },
    async countActivity() {
      return rows.length;
    },
    async listActivity() {
      return [] as ActivityRow[];
    },
    async listAllActivity() {
      return [] as ActivityRow[];
    },
    async getActivityById() {
      return null;
    },
    async listRelatedByDoc() {
      return [] as ActivityRow[];
    },
  };
  return { repo, rows };
}

/** A share repo that just echoes the requested level+role back (the stored setting). */
const fakeShareRepo: ShareRepo = {
  async setGeneralAccess(_docId, input) {
    return {
      docId: _docId,
      level: input.level,
      role: input.role,
      editorsCanShare: input.editorsCanShare ?? false,
      capabilityToken: input.level === "anyone_with_link" ? "tok_new" : null,
    };
  },
};

const fakeLookup: DocLookupRepo = {
  async findDocBySlug(slug) {
    return slug === "missing"
      ? null
      : { id: "doc_1", title: "Render pipeline RFC", kind: "markdown", generalAccess: "restricted" };
  },
  async getVersionContent() {
    return null;
  },
};

function buildApp(act: ReturnType<typeof fakeActivityRepo>, opts: { noActivity?: boolean } = {}) {
  return createApp({
    dbCheck: async () => {},
    sharing: {
      shareRepo: fakeShareRepo,
      lookupRepo: fakeLookup,
      // Eagerly built by the route factory but unused by the PUT …/access path — an inert stub.
      docMemberRepo: {} as never,
      enqueueInvite: () => {},
      resolveSession: owner,
      resolveWorkspaceRole: async () => "member",
      resolveDocRole: async () => "owner",
      loadShareConfig: async () => ({ editorsCanShare: false }),
      accessDeps: {
        isInvited: async () => false,
        isWorkspaceMember: async () => true,
      } as never,
      activity: opts.noActivity
        ? undefined
        : {
            repo: act.repo,
            workspaceOfDoc: async () => "ws_1",
            resolveActorName: async (userId) => (userId === "u_devin" ? "Devin" : null),
          },
    },
  });
}

function req(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("workspace-activity S-006: doc sharing-change event (AS-022)", () => {
  test("AS-022/C-005: setting general access to anyone_with_link/commenter logs ONE share event with the new access + role", async () => {
    const act = fakeActivityRepo();
    const app = buildApp(act);
    const res = await app.handle(
      req("/api/w/ws_1/docs/render-pipeline-rfc/access", {
        method: "PUT",
        body: JSON.stringify({ level: "anyone_with_link", role: "commenter" }),
      }),
    );
    expect(res.status).toBe(200);

    // Exactly one event, type=share (C-005), actor = the owner, anchored to the doc + workspace.
    expect(act.rows).toHaveLength(1);
    const row = act.rows[0];
    expect(row.type).toBe("share");
    expect(row.actorUserId).toBe("u_devin");
    expect(row.docId).toBe("doc_1");
    expect(row.workspaceId).toBe("ws_1");
    // F-10: NEW state only — meta carries the new access + role, no from/to.
    expect(row.meta).toEqual({ access: "anyone_with_link", role: "commenter" });
  });

  test("C-002: the share change still succeeds (200) when no activity block is wired — no row, no throw", async () => {
    const act = fakeActivityRepo();
    const app = buildApp(act, { noActivity: true });
    const res = await app.handle(
      req("/api/w/ws_1/docs/render-pipeline-rfc/access", {
        method: "PUT",
        body: JSON.stringify({ level: "restricted", role: "viewer" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(act.rows).toHaveLength(0);
  });
});
