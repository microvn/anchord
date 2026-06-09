// Unit tests for requireWorkspaceMember — the path-scoped tenancy gate (workspaces S-006).
// Exercised in-process via app.handle against a mounted /api/w/:workspaceId/* group.

import { test, expect } from "bun:test";
import { Elysia } from "elysia";
import { apiEnvelope } from "./envelope";
import {
  requireSession,
  requireWorkspaceMember,
  type SessionResolver,
  type WorkspaceRoleResolver,
} from "./auth-gate";

function buildApp(opts: {
  resolveSession: SessionResolver;
  resolveWorkspaceRole: WorkspaceRoleResolver;
  state: { handlerRan: boolean; seenWorkspaceId?: string; seenRole?: string };
}) {
  return apiEnvelope(new Elysia())
    .use(requireSession({ resolveSession: opts.resolveSession }))
    .use(requireWorkspaceMember({ resolveWorkspaceRole: opts.resolveWorkspaceRole }))
    .get("/api/w/:workspaceId/thing", ({ ws }) => {
      opts.state.handlerRan = true;
      opts.state.seenWorkspaceId = ws.workspaceId;
      opts.state.seenRole = ws.role;
      return { ok: true };
    });
}

function get(app: ReturnType<typeof buildApp>, workspaceId: string) {
  return app.handle(new Request(`http://localhost/api/w/${workspaceId}/thing`));
}

const asUser = (userId: string): SessionResolver => async () => ({ userId });

test("C-002: a member of the path workspace passes; the handler sees { workspaceId, role }", async () => {
  const state: { handlerRan: boolean; seenWorkspaceId?: string; seenRole?: string } = { handlerRan: false };
  // The actor is a member of ws_acme only.
  const resolveWorkspaceRole: WorkspaceRoleResolver = async (workspaceId, _userId) =>
    workspaceId === "ws_acme" ? "member" : null;
  const app = buildApp({ resolveSession: asUser("u_alice"), resolveWorkspaceRole, state });
  const res = await get(app, "ws_acme");
  expect(res.status).toBe(200);
  expect(state.handlerRan).toBe(true);
  expect(state.seenWorkspaceId).toBe("ws_acme");
  expect(state.seenRole).toBe("member");
});

test("AS-018 / C-002: a member of A requesting B's data is refused (404, existence-hiding); handler never runs", async () => {
  const state: { handlerRan: boolean; seenWorkspaceId?: string; seenRole?: string } = { handlerRan: false };
  // Alice is a member of ws_acme only — she has NO role in ws_globex.
  const resolveWorkspaceRole: WorkspaceRoleResolver = async (workspaceId, _userId) =>
    workspaceId === "ws_acme" ? "member" : null;
  const app = buildApp({ resolveSession: asUser("u_alice"), resolveWorkspaceRole, state });
  const res = await get(app, "ws_globex");
  expect(res.status).toBe(404);
  expect(((await res.json()) as any).error.code).toBe("NOT_FOUND");
  expect(state.handlerRan).toBe(false);
});

test("AS-008: requesting a workspace I do not belong to is indistinguishable from a missing one (404)", async () => {
  const state: { handlerRan: boolean; seenWorkspaceId?: string; seenRole?: string } = { handlerRan: false };
  const resolveWorkspaceRole: WorkspaceRoleResolver = async () => null; // never a member
  const app = buildApp({ resolveSession: asUser("u_x"), resolveWorkspaceRole, state });
  const res = await get(app, "ws_does_not_exist");
  expect(res.status).toBe(404);
  expect(state.handlerRan).toBe(false);
});

test("C-005: the request scope is the :workspaceId PATH, not any server-side current workspace", async () => {
  const state: { handlerRan: boolean; seenWorkspaceId?: string; seenRole?: string } = { handlerRan: false };
  const resolveWorkspaceRole: WorkspaceRoleResolver = async (workspaceId) =>
    workspaceId === "ws_one" || workspaceId === "ws_two" ? "member" : null;
  const app = buildApp({ resolveSession: asUser("u_multi"), resolveWorkspaceRole, state });
  // Two different paths resolve to two different scopes for the SAME actor.
  const r1 = await get(app, "ws_one");
  expect(r1.status).toBe(200);
  expect(state.seenWorkspaceId).toBe("ws_one");
  const r2 = await get(app, "ws_two");
  expect(r2.status).toBe(200);
  expect(state.seenWorkspaceId).toBe("ws_two");
});
