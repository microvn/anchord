// In-process route tests for the workspace-project first-run POST /api/setup mount
// (no DB). These exercise the HTTP GLUE only — envelope + auth gate + Zod validation
// + SetupRejected→DomainError mapping — via app.handle(Request)→Response with a fake
// WorkspaceRepo. The real-Postgres path (sign up over HTTP, the auth member hook, the
// in-tx single-workspace guard) is covered by test/integration/workspace-setup.itest.ts.
//
// AS map (workspace-project S-001):
//   AS-001  first-run claims admin → 201 { workspaceId, slug, name }; actor is admin.
//   AS-002  member-on-signup is the auth-hook path (integration); the route's job is
//           the admin claim — covered here + the second-call refusal proves later
//           callers can't become a second admin via setup.
//   C-001   second setup once a workspace exists → 409 CONFLICT (no second workspace).
//   (anti-forgery) a body-supplied role/userId is ignored — admin = session actor.

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import {
  SetupRejected,
  type WorkspaceRepo,
  type CreatedWorkspace,
} from "../../src/workspace/setup";
import type { SessionResolver } from "../../src/http/auth-gate";

const installer: SessionResolver = async () => ({ userId: "u_installer" });
const secondUser: SessionResolver = async () => ({ userId: "u_second" });
const noSession: SessionResolver = async () => null;

/** In-memory WorkspaceRepo mirroring the real single-workspace invariants. */
function fakeRepo() {
  const state: {
    workspace: CreatedWorkspace | null;
    members: Array<{ userId: string; role: string }>;
  } = { workspace: null, members: [] };
  const repo: WorkspaceRepo = {
    async countWorkspaces() {
      return state.workspace ? 1 : 0;
    },
    async createWorkspaceWithAdmin(input) {
      if (state.workspace) throw new SetupRejected("already set up", "already_set_up");
      const ws: CreatedWorkspace = {
        workspaceId: "ws_1",
        slug: input.slug,
        name: input.name,
        adminUserId: input.adminUserId,
      };
      state.workspace = ws;
      state.members.push({ userId: input.adminUserId, role: "admin" });
      return ws;
    },
    async currentWorkspaceId() {
      return state.workspace?.workspaceId ?? null;
    },
    async addMember(_w, userId) {
      if (state.members.some((m) => m.userId === userId)) return;
      state.members.push({ userId, role: "member" });
    },
  };
  return { repo, state };
}

function buildApp(opts: { resolveSession: SessionResolver; repo?: WorkspaceRepo }) {
  return createApp({
    dbCheck: async () => {},
    setup: { repo: opts.repo ?? fakeRepo().repo, resolveSession: opts.resolveSession },
  });
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const ACME = { name: "Acme", settings: { providers: { github: true, google: true } } };

describe("POST /api/setup route glue (workspace-project S-001)", () => {
  test("AS-001: first-run claims admin → 201 { workspaceId, slug, name } in envelope", async () => {
    const f = fakeRepo();
    const app = buildApp({ resolveSession: installer, repo: f.repo });
    const res = await app.handle(post(ACME));

    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.statusCode).toBe(201);
    expect(json.data.workspaceId).toBe("ws_1");
    expect(json.data.name).toBe("Acme");
    expect(typeof json.data.slug).toBe("string");
    // The running session user is recorded as admin.
    expect(f.state.members).toEqual([{ userId: "u_installer", role: "admin" }]);
  });

  test("C-001: a second setup once a workspace exists → 409 CONFLICT (no second workspace/admin)", async () => {
    const f = fakeRepo();
    // First-run by the installer.
    await buildApp({ resolveSession: installer, repo: f.repo }).handle(post(ACME));
    // A different signed-in user tries to set up again → refused.
    const res = await buildApp({ resolveSession: secondUser, repo: f.repo }).handle(
      post({ name: "Evil Corp", settings: { providers: { github: false, google: false } } }),
    );

    expect(res.status).toBe(409);
    const json = (await res.json()) as any;
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("CONFLICT");
    // Still one workspace, still one admin (the installer).
    expect(await f.repo.countWorkspaces()).toBe(1);
    expect(f.state.members).toEqual([{ userId: "u_installer", role: "admin" }]);
  });

  test("anti-forgery: a body-supplied role/userId is ignored — admin = the SESSION actor", async () => {
    const f = fakeRepo();
    const app = buildApp({ resolveSession: installer, repo: f.repo });
    const res = await app.handle(
      post({ ...ACME, role: "admin", userId: "u_attacker", adminUserId: "u_attacker" } as any),
    );
    expect(res.status).toBe(201);
    // The recorded admin is the cookie/session user, never the forged body field.
    expect(f.state.members).toEqual([{ userId: "u_installer", role: "admin" }]);
  });

  test("no session → 401 UNAUTHENTICATED (handler never runs, nothing created)", async () => {
    const f = fakeRepo();
    const app = buildApp({ resolveSession: noSession, repo: f.repo });
    const res = await app.handle(post(ACME));
    expect(res.status).toBe(401);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("UNAUTHENTICATED");
    expect(f.state.workspace).toBeNull();
  });

  test("bad body shape (missing name) → 400 VALIDATION_ERROR", async () => {
    const app = buildApp({ resolveSession: installer });
    const res = await app.handle(
      post({ settings: { providers: { github: true, google: true } } }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(json.error.field).toBe("name");
  });
});
