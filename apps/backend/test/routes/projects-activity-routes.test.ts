// In-process route test for workspace-activity S-006: the `project` event emitted when a project
// is created (AS-024). EMIT GLUE only (no DB): a fake ActivityRepo captures the row the POST
// /api/w/:workspaceId/projects route writes post-commit; a fake ProjectRepo + ctx run route→
// service without Postgres.
//
// AS map (workspace-activity S-006):
//   AS-024  project created → ONE `project` event naming the project (workspace-level, docId null)
//   C-005   each action logs exactly one event of its originating type

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { SessionResolver, WorkspaceRoleResolver } from "../../src/http/auth-gate";
import type { NewActivity, ActivityRepo, ActivityRow } from "../../src/activity/repo";
import type { ProjectRepo, ProjectRow } from "../../src/workspace/projects";
import type { ProjectsRouteRepo } from "../../src/workspace/repo";

const asUser = (userId: string): SessionResolver => async () => ({ userId });
const asMember: WorkspaceRoleResolver = async () => "member";

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

function fakeProjectRepo() {
  let n = 0;
  const projects: ProjectRow[] = [];
  const repo: ProjectRepo = {
    async insert(input) {
      const row: ProjectRow = {
        id: `p_${++n}`,
        workspaceId: input.workspaceId,
        name: input.name,
        ownerId: input.ownerId,
        isDefault: input.isDefault,
        visibility: input.visibility,
        archivedAt: null,
      };
      projects.push(row);
      return row;
    },
    async findById(ws, id) {
      return projects.find((p) => p.workspaceId === ws && p.id === id) ?? null;
    },
    async findDefaultFor() {
      return null;
    },
    async listActive(ws) {
      return projects.filter((p) => p.workspaceId === ws && p.archivedAt == null);
    },
    async listAll(ws) {
      return projects.filter((p) => p.workspaceId === ws);
    },
    async setName() {},
    async setArchivedAt() {},
    async setVisibility() {},
    async setVisibilityPrivateCascade() {},
    async countDocs() {
      return 0;
    },
    async delete() {},
  };
  return { repo, projects };
}

const fakeCtx: ProjectsRouteRepo = {
  async countDocsByProject() {
    return new Map();
  },
  async docsInProject() {
    return [];
  },
  async isInvited() {
    return false;
  },
  async workspaceDocs() {
    return [];
  },
};

function buildApp(act: ReturnType<typeof fakeActivityRepo>, opts: { noActivity?: boolean } = {}) {
  const pr = fakeProjectRepo();
  return createApp({
    dbCheck: async () => {},
    projects: {
      repo: pr.repo,
      ctx: fakeCtx,
      resolveSession: asUser("u_mara"),
      resolveWorkspaceRole: asMember,
      activity: opts.noActivity
        ? undefined
        : {
            repo: act.repo,
            resolveActorName: async (userId) => (userId === "u_mara" ? "Mara" : null),
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

describe("workspace-activity S-006: project-created event (AS-024)", () => {
  test('AS-024/C-005: creating the project "annotation-core" logs ONE project event naming it', async () => {
    const act = fakeActivityRepo();
    const app = buildApp(act);
    const res = await app.handle(
      req("/api/w/ws_1/projects", { method: "POST", body: JSON.stringify({ name: "annotation-core" }) }),
    );
    expect(res.status).toBe(201);

    expect(act.rows).toHaveLength(1);
    const row = act.rows[0];
    expect(row.type).toBe("project");
    expect(row.actorUserId).toBe("u_mara");
    expect(row.workspaceId).toBe("ws_1");
    // Workspace-level event — no doc target.
    expect(row.docId ?? null).toBeNull();
    // The project name is carried for the row to render (target or summary).
    expect([row.target, row.summary]).toContain("annotation-core");
    // The new project id is linked so the row can deep-link.
    expect(row.projectId).toBeTruthy();
  });

  test("C-002: project create still succeeds (201) when no activity block is wired — no row, no throw", async () => {
    const act = fakeActivityRepo();
    const app = buildApp(act, { noActivity: true });
    const res = await app.handle(
      req("/api/w/ws_1/projects", { method: "POST", body: JSON.stringify({ name: "web-core" }) }),
    );
    expect(res.status).toBe(201);
    expect(act.rows).toHaveLength(0);
  });
});
