// In-process route tests for the bootstrap surface /api/me (workspaces S-003).
// HTTP GLUE only — envelope + auth gate + the tenancy list via a fake TenancyRepo.

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { TenancyRepo, WorkspaceListItem } from "../../src/workspace/tenancy";
import type { SessionResolver } from "../../src/http/auth-gate";

const asUser = (userId: string): SessionResolver => async () => ({ userId });
const noSession: SessionResolver = async () => null;

function fakeRepo(byUser: Record<string, WorkspaceListItem[]>) {
  const repo = {
    async listMyWorkspaces(userId: string) {
      return byUser[userId] ?? [];
    },
  } as unknown as TenancyRepo;
  return repo;
}

function buildApp(resolveSession: SessionResolver, repo: TenancyRepo, active?: Record<string, string>) {
  const store: Record<string, string> = { ...(active ?? {}) };
  return createApp({
    dbCheck: async () => {},
    me: {
      repo,
      resolveSession,
      getActiveWorkspaceId: async (uid) => store[uid] ?? null,
      setActiveWorkspaceId: async (uid, ws) => {
        store[uid] = ws;
      },
    },
  });
}

function req(method: string, path: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const MINE: WorkspaceListItem[] = [
  { id: "ws_own", name: "default", slug: "s1", role: "admin", adminName: "Me" },
  { id: "ws_acme", name: "Acme", slug: "s2", role: "member", adminName: "Lan" },
];

describe("/api/me bootstrap route glue (workspaces S-003)", () => {
  test("AS-006: GET /api/me lists every workspace I belong to with my role + admin name + active", async () => {
    const app = buildApp(asUser("u_me"), fakeRepo({ u_me: MINE }), { u_me: "ws_acme" });
    const res = await app.handle(req("GET", "/api/me"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.workspaces).toHaveLength(2);
    expect(json.data.workspaces.find((w: any) => w.id === "ws_acme").role).toBe("member");
    expect(json.data.workspaces.find((w: any) => w.id === "ws_acme").adminName).toBe("Lan");
    expect(json.data.activeWorkspaceId).toBe("ws_acme");
  });

  test("AS-006: with no active set, the bootstrap defaults active to a workspace I belong to", async () => {
    const app = buildApp(asUser("u_me"), fakeRepo({ u_me: MINE }));
    const res = await app.handle(req("GET", "/api/me"));
    const json = (await res.json()) as any;
    expect(["ws_own", "ws_acme"]).toContain(json.data.activeWorkspaceId);
  });

  test("AS-007: switching the active workspace to one I belong to succeeds", async () => {
    const app = buildApp(asUser("u_me"), fakeRepo({ u_me: MINE }));
    const res = await app.handle(req("POST", "/api/me/active-workspace", { workspaceId: "ws_acme" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.activeWorkspaceId).toBe("ws_acme");
    // It persists on the next bootstrap.
    const me = await app.handle(req("GET", "/api/me"));
    expect(((await me.json()) as any).data.activeWorkspaceId).toBe("ws_acme");
  });

  test("AS-008: switching to a workspace I do NOT belong to is refused (404, existence-hiding)", async () => {
    const app = buildApp(asUser("u_me"), fakeRepo({ u_me: MINE }));
    const res = await app.handle(req("POST", "/api/me/active-workspace", { workspaceId: "ws_globex" }));
    expect(res.status).toBe(404);
  });

  test("no session → 401", async () => {
    const app = buildApp(noSession, fakeRepo({}));
    expect((await app.handle(req("GET", "/api/me"))).status).toBe(401);
  });
});
