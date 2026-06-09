// workspaces S-004 / AS-009: inviting a member must ENQUEUE a workspace-invite email
// through the shared MailQueue + transport, carrying the invitee's address + an accept
// link. This guards the live wiring bug where index.ts assembled the workspaces route
// deps WITHOUT enqueueInvite, so the route's `deps.enqueueInvite?.(...)` optional-chained
// to a silent no-op (201 returned, no mail, invitee with no way in).
//
// Two layers:
//   1. createEnqueueWorkspaceInvite — the EXACT port index.ts now injects. Proves the
//      port sends a workspace-invite mail to the invitee with an accept link.
//   2. createApp wired with that port — proves the route invokes it (not the no-op) and
//      surfaces the accept link in the 201 body.

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import { MailQueue, type MailMessage, type MailTransport } from "../../src/auth/mail-queue";
import { createEnqueueWorkspaceInvite } from "../../src/auth/mail-transport";
import type { TenancyRepo, WorkspaceRole } from "../../src/workspace/tenancy";
import type { SessionResolver } from "../../src/http/auth-gate";

const asUser = (userId: string): SessionResolver => async () => ({ userId });

function fakeRepo() {
  let wsN = 0;
  let invN = 0;
  const state = {
    workspaces: [] as Array<{ id: string; name: string; slug: string }>,
    members: [] as Array<{ workspaceId: string; userId: string; role: WorkspaceRole }>,
    invitations: [] as Array<{ id: string; workspaceId: string; email: string; role: WorkspaceRole; token: string; status: string; expiresAt: Date }>,
  };
  const repo = {
    async createWorkspace(input: { name: string; slug: string }) {
      const ws = { id: `ws_${++wsN}`, name: input.name, slug: input.slug };
      state.workspaces.push(ws);
      return ws;
    },
    async addMember(workspaceId: string, userId: string, role: WorkspaceRole) {
      if (!state.members.some((m) => m.workspaceId === workspaceId && m.userId === userId))
        state.members.push({ workspaceId, userId, role });
    },
    async findMemberRole(workspaceId: string, userId: string) {
      return state.members.find((m) => m.workspaceId === workspaceId && m.userId === userId)?.role ?? null;
    },
    async createInvitation(input: any) {
      const inv = { id: `inv_${++invN}`, status: "pending", ...input };
      state.invitations.push(inv);
      return { id: inv.id, token: inv.token };
    },
    async userName() {
      return null;
    },
  } as unknown as TenancyRepo;
  return { repo, state };
}

function req(method: string, path: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function fakeTransport() {
  const sent: MailMessage[] = [];
  const transport: MailTransport = {
    async send(msg) {
      sent.push(msg);
    },
  };
  return { sent, transport };
}

describe("workspaces S-004 AS-009 — inviting a member enqueues a workspace-invite email", () => {
  test("createEnqueueWorkspaceInvite sends a workspace-invite mail to the invitee with an accept link", async () => {
    const queue = new MailQueue();
    const { sent, transport } = fakeTransport();
    const enqueue = createEnqueueWorkspaceInvite(queue, transport);

    enqueue({ workspaceId: "ws_1", email: "bob@acme.com", token: "tok_123", invitationId: "inv_1" });
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget send settle

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("bob@acme.com");
    expect(sent[0]!.subject).toContain("workspace");
    expect(sent[0]!.body).toContain("/invite/workspace/inv_1");
    expect(sent[0]!.body).toContain("tok_123");
  });

  test("the route invokes the wired enqueue (not the no-op) and surfaces the accept link", async () => {
    const f = fakeRepo();
    const queue = new MailQueue();
    const { sent, transport } = fakeTransport();
    const app = createApp({
      dbCheck: async () => {},
      workspaces: {
        repo: f.repo,
        resolveSession: asUser("u_a"),
        resolveActorEmail: async () => null,
        enqueueInvite: createEnqueueWorkspaceInvite(queue, transport),
      },
    });

    await app.handle(req("POST", "/api/workspaces", { name: "Acme" }));
    const res = await app.handle(
      req("POST", "/api/workspaces/ws_1/invitations", { email: "bob@acme.com" }),
    );
    expect(res.status).toBe(201);

    const json = (await res.json()) as any;
    expect(typeof json.data.acceptLink).toBe("string");
    expect(json.data.acceptLink).toContain("/invite/workspace/");

    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("bob@acme.com");
  });
});
