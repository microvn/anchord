// Integration tier (guarded by RUN_INTEGRATION): your-activity-inbox S-005 SEAM (AS-016) driven
// end-to-end against a real Postgres + real HTTP routes + the REAL producer emit — NEVER a mock
// (Linked-Field Seam Rule). This is the cross-spec contract between `workspace-notifications` (the
// `workspace_invited` emit that must populate the dedicated `invitationId` column) and this spec
// (the For-you inbox's TOKENLESS accept that targets that exact invitation id).
//
// Flow:
//   1. An admin invites Bob via POST /api/workspaces/:id/invitations — this fires the REAL
//      notifyOnWorkspaceInvited (createNotifyRepo(db)) post-commit, which must write a
//      `workspace_invited` notification carrying invitationId = the pending invitation's id and
//      refId = the workspace id (UNCHANGED).
//   2. We read that notification row back through the REAL read-repo (listForUser) and assert it
//      serves invitationId (the inbox reads this field), and refId still equals the workspace id.
//   3. Bob (signed in with the invited email) accepts TOKENLESS — POST /api/invitations/:id/accept
//      with NO token — authorized purely by his matching session email. He joins at the invited
//      role; the invitation is marked accepted.
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/inbox-invite-accept.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { notifications, user, workspaceMembers, workspaceInvitations } from "../../src/db/schema";
import { createApp } from "../../src/app";
import { MailQueue } from "../../src/auth/mail-queue";
import { createNotificationReadRepo } from "../../src/notify/read-repo";
import type { Actor, SessionResolver } from "../../src/http/auth-gate";
import { withMigratedDb, seedWorkspace, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;

/** Poll a query until it returns a non-empty result or the deadline passes (fire-and-forget emit). */
async function waitFor<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 4000): Promise<T> {
  const deadline = Date.now() + ms;
  let last = await read();
  while (!ok(last) && Date.now() < deadline) {
    await Bun.sleep(25);
    last = await read();
  }
  return last;
}

describe.skipIf(!RUN)("your-activity-inbox S-005 — inbox invite accept seam (real Postgres, real emit)", () => {
  let h: MigratedDb;
  const ALICE = `u_inv_alice_${process.pid}`;
  const BOB = `u_inv_bob_${process.pid}`;
  const ALICE_EMAIL = `inv-alice-${process.pid}@example.com`;
  const BOB_EMAIL = `inv-bob-${process.pid}@example.com`;

  beforeAll(async () => {
    h = await withMigratedDb();
    await h.db.insert(user).values([
      { id: ALICE, name: "Alice", email: ALICE_EMAIL, emailVerified: true },
      { id: BOB, name: "Bob", email: BOB_EMAIL, emailVerified: true },
    ]);
  }, 60_000);

  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  }, 30_000);

  function req(path: string, init: RequestInit = {}) {
    return new Request(`http://localhost${path}`, {
      headers: { "content-type": "application/json" },
      ...init,
    });
  }

  // The accept route reads the actor's verified email SERVER-side (never the body) to match the
  // invitation — backed by the REAL user table.
  const resolveActorEmail = async (userId: string) => {
    const [row] = await h.db.select({ email: user.email }).from(user).where(eq(user.id, userId));
    return row ? { email: row.email } : null;
  };

  // App whose session resolves to `userId`, with workspaces routes wired to the REAL notify emit
  // (createNotifyRepo(db) built inside the route from `db`) — exactly as index.ts does.
  function appAs(userId: string, mail: MailQueue) {
    const resolveSession: SessionResolver = async (): Promise<Actor> => ({ userId });
    return createApp({
      dbCheck: async () => {},
      workspaces: {
        db: h.db,
        resolveSession,
        resolveActorEmail,
        notify: { mail }, // workspace_invited is in-app only; mail required by the port
      },
    });
  }

  test("AS-016: invite emits a workspace_invited row carrying invitationId (refId = workspace id); a TOKENLESS accept joins at the invited role", async () => {
    const { workspaceId: WS } = await seedWorkspace(h.db, { userId: ALICE, name: "Mercury Docs" });
    const mail = new MailQueue();

    // 1) Alice invites Bob as EDITOR-equivalent member role "member" (workspace roles are admin|member;
    //    the spec's "editor" maps to the workspace member role here). Fire the REAL emit via the route.
    const inviteRes = await appAs(ALICE, mail).handle(
      req(`/api/workspaces/${WS}/invitations`, {
        method: "POST",
        body: JSON.stringify({ email: BOB_EMAIL, role: "member" }),
      }),
    );
    expect(inviteRes.status).toBe(201);
    const inviteJson = (await inviteRes.json()) as { data: { id: string } };
    const invitationId = inviteJson.data.id;
    expect(invitationId).toBeTruthy();

    // 2) The post-commit, fire-and-forget emit writes Bob's workspace_invited row — poll for it.
    const rows = await waitFor(
      () =>
        h.db
          .select()
          .from(notifications)
          .where(and(eq(notifications.userId, BOB), eq(notifications.type, "workspace_invited"))),
      (r) => r.length >= 1,
    );
    expect(rows).toHaveLength(1);
    // The dedicated invitationId column carries the pending invitation's id…
    expect(rows[0]!.invitationId).toBe(invitationId);
    // …and refId STAYS the workspace id (S-001's chip enrichment derives workspaceId = refId).
    expect(rows[0]!.refId).toBe(WS);

    // The READ repo (what the For-you inbox consumes) serves invitationId back on the row.
    const read = createNotificationReadRepo(h.db);
    const served = await read.listForUser(BOB, { offset: 0, limit: 50 });
    const invItem = served.find((n) => n.type === "workspace_invited");
    expect(invItem).toBeDefined();
    expect(invItem!.invitationId).toBe(invitationId);
    expect(invItem!.refId).toBe(WS);

    // 3) Bob accepts TOKENLESS — no token in the body — authorized by his matching session email.
    const acceptRes = await appAs(BOB, mail).handle(
      req(`/api/invitations/${invitationId}/accept`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(acceptRes.status).toBe(200);
    const acceptJson = (await acceptRes.json()) as { data: { workspaceId: string; role: string } };
    expect(acceptJson.data.workspaceId).toBe(WS);
    expect(acceptJson.data.role).toBe("member");

    // Bob is now a real member at the invited role; the invitation is accepted.
    const member = await h.db
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, WS), eq(workspaceMembers.userId, BOB)));
    expect(member).toHaveLength(1);
    expect(member[0]!.role).toBe("member");

    const [inv] = await h.db
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.id, invitationId));
    expect(inv!.status).toBe("accepted");
  });

  test("AS-017: a TOKENLESS decline rejects the invitation (email-authorized, no membership)", async () => {
    const { workspaceId: WS } = await seedWorkspace(h.db, { userId: ALICE, name: "Field IO" });
    const mail = new MailQueue();

    const inviteRes = await appAs(ALICE, mail).handle(
      req(`/api/workspaces/${WS}/invitations`, {
        method: "POST",
        body: JSON.stringify({ email: BOB_EMAIL, role: "member" }),
      }),
    );
    expect(inviteRes.status).toBe(201);
    const invitationId = ((await inviteRes.json()) as { data: { id: string } }).data.id;

    // Bob declines TOKENLESS.
    const rejectRes = await appAs(BOB, mail).handle(
      req(`/api/invitations/${invitationId}/reject`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(rejectRes.status).toBe(200);

    const member = await h.db
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, WS), eq(workspaceMembers.userId, BOB)));
    expect(member).toHaveLength(0);
    const [inv] = await h.db
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.id, invitationId));
    expect(inv!.status).toBe("rejected");
  });
});
