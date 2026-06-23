// Integration tier (guarded by RUN_INTEGRATION): the THREE workspace-membership notify events
// (workspace-notifications S-002/S-003/S-004) driven end-to-end — real Postgres, real HTTP routes
// (accept / remove / rename), the REAL createNotifyRepo(db), and a REAL (in-memory) MailQueue we
// inspect. The build covered these with unit fakes; this is the integration pass that catches what
// fakes hide: the pgEnum reality of `workspace_member_*` types, the FK on notifications.user_id,
// the PRE-delete name+email snapshot for removal (the row + email must land DESPITE the membership
// row being gone), the BATCH fan-out insert, and the real recipient queries against
// workspace_members.
//
// Wiring fidelity: the routes get notify deps the SAME way src/index.ts does — a real
// createNotifyRepo(db) (built from `db` inside the route when `notify` is present) + a MailQueue as
// the `mail` enqueuer + appUrl. Production wiring is untouched; the test only supplies a fake
// SessionResolver / WorkspaceRoleResolver (the better-auth cookie flow is heavy and unit-covered),
// and a real DB-backed actor-email resolver for the accept route's email-match.
//
// TIMING NOTE: the join (accept) + rename routes fire notify FIRE-AND-FORGET (`void (async …)()`,
// not awaited on the request critical path — C-005). So after those routes return we POLL the
// notifications table until the fan-out lands, rather than asserting immediately. The removal route
// AWAITS its notify, so its assertion is immediate.
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/workspace-notify.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { notifications, user, workspaceMembers } from "../../src/db/schema";
import { createApp } from "../../src/app";
import { MailQueue } from "../../src/auth/mail-queue";
import { createTenancyRepo } from "../../src/workspace/tenancy-repo";
import type { Actor, SessionResolver, WorkspaceRoleResolver } from "../../src/http/auth-gate";
import { withMigratedDb, seedWorkspace, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;
const APP_URL = "https://anchord.test";

/** Poll a query until it returns a truthy/non-empty result or the deadline passes. */
async function waitFor<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 4000): Promise<T> {
  const deadline = Date.now() + ms;
  let last = await read();
  while (!ok(last) && Date.now() < deadline) {
    await Bun.sleep(25);
    last = await read();
  }
  return last;
}

describe.skipIf(!RUN)("workspace membership notify (real Postgres, real routes)", () => {
  let h: MigratedDb;
  // Unique ids per process so parallel files never collide.
  const ALICE = `u_wn_alice_${process.pid}`;
  const BOB = `u_wn_bob_${process.pid}`;
  const CAROL = `u_wn_carol_${process.pid}`;
  const ALICE_EMAIL = `wn-alice-${process.pid}@example.com`;
  const BOB_EMAIL = `wn-bob-${process.pid}@example.com`;
  const CAROL_EMAIL = `wn-carol-${process.pid}@example.com`;

  beforeAll(async () => {
    h = await withMigratedDb();
    await h.db.insert(user).values([
      { id: ALICE, name: "Alice", email: ALICE_EMAIL, emailVerified: true },
      { id: BOB, name: "Bob", email: BOB_EMAIL, emailVerified: true },
      { id: CAROL, name: "Carol", email: CAROL_EMAIL, emailVerified: true },
    ]);
    // Booting the ephemeral container + running migrations can exceed bun's 5s default hook timeout
    // on a cold run, so give the setup hook generous headroom (the harness has its own 30s readiness
    // deadline; this just lets the hook wait for it).
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

  // Fresh actor email resolver backed by the REAL user table (the accept route reads the actor's
  // verified email server-side to match the invitation — never the body).
  const resolveActorEmail = async (userId: string) => {
    const [row] = await h.db.select({ email: user.email }).from(user).where(eq(user.id, userId));
    return row ? { email: row.email } : null;
  };

  // Real workspace-role resolver backed by workspace_members (the members route's tenancy gate;
  // the tenancy service still re-reads admin from the repo, so this just admits a member).
  const resolveWorkspaceRole: WorkspaceRoleResolver = async (workspaceId, userId) => {
    const [row] = await h.db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
    return row?.role ?? null;
  };

  // Build an app whose session resolves to `userId`, with the workspaces + members routes wired to
  // a notify dep — exactly as index.ts does (the route builds createNotifyRepo(db) from `db`).
  function appAs(userId: string, mail: MailQueue) {
    const resolveSession: SessionResolver = async (): Promise<Actor> => ({ userId });
    return createApp({
      dbCheck: async () => {},
      workspaces: {
        db: h.db,
        resolveSession,
        resolveActorEmail,
        notify: { mail }, // workspace_invited/joined/renamed are in-app only; mail required by the port
      },
      members: {
        db: h.db,
        resolveSession,
        resolveWorkspaceRole,
        notify: { mail, appUrl: APP_URL }, // workspace_member_removed emails the removed user
      },
    });
  }

  // ── AS-004: join → notify all admins minus the joiner, in-app only ────────────────────────────
  test("AS-004: accepting an invite notifies every admin (Alice, Carol) minus the joiner (Bob), no email", async () => {
    const { workspaceId: WS } = await seedWorkspace(h.db, { userId: ALICE, name: "Acme" });
    // Carol is a SECOND admin; Bob is the pending invitee.
    await h.db.insert(workspaceMembers).values({ workspaceId: WS, userId: CAROL, role: "admin" });
    const repo = createTenancyRepo(h.db);
    const inv = await repo.createInvitation({
      workspaceId: WS,
      email: BOB_EMAIL,
      role: "member",
      token: `tok-join-${process.pid}`,
      invitedBy: ALICE,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const mail = new MailQueue();
    const res = await appAs(BOB, mail).handle(
      req(`/api/invitations/${inv.id}/accept`, {
        method: "POST",
        body: JSON.stringify({ token: inv.token }),
      }),
    );
    expect(res.status).toBe(200);

    // Fire-and-forget: poll until the fan-out (one row per admin) lands.
    const rows = await waitFor(
      () =>
        h.db
          .select()
          .from(notifications)
          .where(and(eq(notifications.refId, WS), eq(notifications.type, "workspace_member_joined"))),
      (r) => r.length >= 2,
    );

    const recipients = rows.map((r) => r.userId).sort();
    expect(recipients).toEqual([ALICE, CAROL].sort());
    expect(recipients).not.toContain(BOB);
    // Exactly one row per admin (no dup).
    expect(rows.filter((r) => r.userId === ALICE)).toHaveLength(1);
    expect(rows.filter((r) => r.userId === CAROL)).toHaveLength(1);
    expect(rows).toHaveLength(2);
    // refId = workspaceId for every row.
    expect(rows.every((r) => r.refId === WS)).toBe(true);
    // C-001: in-app only — NO email for a join.
    expect(mail.statusCounts().pending).toBe(0);
  });

  // ── AS-005 + AS-006: removal → one in-app row + one email to the removed user, PRE-delete snapshot
  test("AS-005 + AS-006: removing Bob notifies Bob (in-app + email) from a PRE-delete snapshot; Alice none; membership gone", async () => {
    const { workspaceId: WS } = await seedWorkspace(h.db, { userId: ALICE, name: "Globex" });
    await h.db.insert(workspaceMembers).values({ workspaceId: WS, userId: BOB, role: "member" });

    const mail = new MailQueue();
    const res = await appAs(ALICE, mail).handle(
      req(`/api/w/${WS}/members/${BOB}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(200);

    // The removal route AWAITS notify → assert immediately (no poll needed).
    const rows = await h.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.refId, WS), eq(notifications.type, "workspace_member_removed")));
    // Exactly one in-app row, for Bob, carrying the workspace name as refLabel.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(BOB);
    expect(rows[0]!.refLabel).toBe("Globex");
    // Alice (the remover) gets nothing.
    expect(rows.some((r) => r.userId === ALICE)).toBe(false);

    // One email enqueued, addressed to Bob.
    expect(mail.statusCounts().pending).toBe(1);
    const dead = mail.deadLetters();
    expect(dead).toHaveLength(0);

    // AS-006 / C-003: the row + email exist EVEN THOUGH Bob's membership row is gone — the
    // pre-delete snapshot (name + email) is what reached the dispatch.
    const stillMember = await h.db
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, WS), eq(workspaceMembers.userId, BOB)));
    expect(stillMember).toHaveLength(0);
  });

  // ── AS-009: removal with a crafted name → refLabel + email are inert (no CR/LF/control/injection)
  test("AS-009: a workspace name with CR/LF + control + spoofed 'Subject:' is sanitized in refLabel and the email", async () => {
    // NOTE (real-DB finding): a literal NUL (\x00) cannot be SEEDED into a Postgres text column at
    // all — `invalid byte sequence for encoding "UTF8": 0x00`. So a workspace name can never carry a
    // NUL in reality; the crafted vector here uses CR/LF + a non-NUL control char (\x07 BEL), which
    // Postgres DOES accept and which sanitizeRefLabel must still strip.
    const crafted = "Evil\r\nSubject: spoofed\r\nWs\x07Name";
    const { workspaceId: WS } = await seedWorkspace(h.db, { userId: ALICE, name: crafted });
    await h.db.insert(workspaceMembers).values({ workspaceId: WS, userId: BOB, role: "member" });

    const mail = new MailQueue();
    const res = await appAs(ALICE, mail).handle(
      req(`/api/w/${WS}/members/${BOB}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(200);

    const [row] = await h.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.refId, WS), eq(notifications.type, "workspace_member_removed")));
    expect(row).toBeDefined();
    // The persisted refLabel has NO CR/LF or control chars (inert). Control-stripping leaves the
    // visible characters concatenated: "EvilSubject: spoofedWsName".
    const label = row!.refLabel ?? "";
    expect(label).not.toMatch(/[\r\n]/);
    // eslint-disable-next-line no-control-regex
    expect(label).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(label).toBe("EvilSubject: spoofedWsName");

    // Exactly one email enqueued (to the removed user), nothing dead-lettered. The MailQueue doesn't
    // expose the queued message body, so the NEXT test re-runs this through a recording enqueuer to
    // inspect the actual subject/body for injection.
    expect(mail.deadLetters()).toHaveLength(0);
    expect(mail.statusCounts().pending).toBe(1);
  });

  // ── AS-009 (email capture): re-run via a RECORDING enqueuer to inspect the actual email message ──
  test("AS-009: the removed-member email subject/body contain no injected header or control chars", async () => {
    const crafted = "Acme\r\nBcc: attacker@evil.test\r\n\x1bX";
    const { workspaceId: WS } = await seedWorkspace(h.db, { userId: ALICE, name: crafted });
    await h.db.insert(workspaceMembers).values({ workspaceId: WS, userId: CAROL, role: "member" });

    // A recording mail enqueuer satisfying MailEnqueuer (returns an id) — captures the message so we
    // can inspect subject + body for injection. createNotifyRepo is still built from `db` by the route.
    const captured: Array<{ to: string; subject: string; text?: string }> = [];
    const recorder = {
      enqueue(msg: { to: string; subject: string; text?: string; html?: string }): string {
        captured.push({ to: msg.to, subject: msg.subject, text: msg.text });
        return `rec_${captured.length}`;
      },
    };

    const resolveSession: SessionResolver = async (): Promise<Actor> => ({ userId: ALICE });
    const app = createApp({
      dbCheck: async () => {},
      members: {
        db: h.db,
        resolveSession,
        resolveWorkspaceRole,
        notify: { mail: recorder, appUrl: APP_URL },
      },
    });
    const res = await app.handle(req(`/api/w/${WS}/members/${CAROL}`, { method: "DELETE" }));
    expect(res.status).toBe(200);

    expect(captured).toHaveLength(1);
    const msg = captured[0]!;
    expect(msg.to).toBe(CAROL_EMAIL);
    // Subject is the fixed per-type subject — never the crafted name.
    expect(msg.subject).toBe("You've been removed from a workspace");
    expect(msg.subject).not.toMatch(/[\r\n]/);
    // Body: the deep-link is workspace-shaped; the crafted name is NOT interpolated into the body
    // at all (the body copy is a fixed one-liner + the link), so no injected header can appear.
    const body = msg.text ?? "";
    expect(body).not.toMatch(/Bcc:/i);
    // eslint-disable-next-line no-control-regex
    expect(body).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/);
    expect(body).toContain(`${APP_URL}/w/${WS}`);
  });

  // ── AS-007: rename → notify every current member minus the renamer, in-app only ─────────────────
  test("AS-007: renaming notifies Bob + Carol with refLabel '<old> → <new>'; Alice (renamer) none; no email", async () => {
    const { workspaceId: WS } = await seedWorkspace(h.db, { userId: ALICE, name: "Acme" });
    await h.db.insert(workspaceMembers).values([
      { workspaceId: WS, userId: BOB, role: "member" },
      { workspaceId: WS, userId: CAROL, role: "member" },
    ]);

    const mail = new MailQueue();
    const res = await appAs(ALICE, mail).handle(
      req(`/api/workspaces/${WS}`, { method: "PATCH", body: JSON.stringify({ name: "Acme Docs" }) }),
    );
    expect(res.status).toBe(200);

    // Fire-and-forget: poll until the member fan-out lands.
    const rows = await waitFor(
      () =>
        h.db
          .select()
          .from(notifications)
          .where(and(eq(notifications.refId, WS), eq(notifications.type, "workspace_renamed"))),
      (r) => r.length >= 2,
    );

    const recipients = rows.map((r) => r.userId).sort();
    expect(recipients).toEqual([BOB, CAROL].sort());
    expect(recipients).not.toContain(ALICE);
    expect(rows.filter((r) => r.userId === BOB)).toHaveLength(1);
    expect(rows.filter((r) => r.userId === CAROL)).toHaveLength(1);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.refLabel === "Acme → Acme Docs")).toBe(true);
    // In-app only — NO email for a rename.
    expect(mail.statusCounts().pending).toBe(0);
  });

  // ── C-005 fan-out: a 3-member rename writes EXACTLY one row per recipient (no dup) ──────────────
  test("C-005: a 3-member rename fans out to exactly one row per non-renamer recipient (batch, no dup)", async () => {
    const { workspaceId: WS } = await seedWorkspace(h.db, { userId: ALICE, name: "Init" });
    await h.db.insert(workspaceMembers).values([
      { workspaceId: WS, userId: BOB, role: "member" },
      { workspaceId: WS, userId: CAROL, role: "admin" }, // an admin is a member too → still notified
    ]);

    const mail = new MailQueue();
    const res = await appAs(ALICE, mail).handle(
      req(`/api/workspaces/${WS}`, { method: "PATCH", body: JSON.stringify({ name: "Final" }) }),
    );
    expect(res.status).toBe(200);

    const rows = await waitFor(
      () =>
        h.db
          .select()
          .from(notifications)
          .where(and(eq(notifications.refId, WS), eq(notifications.type, "workspace_renamed"))),
      (r) => r.length >= 2,
    );
    // Exactly two recipients (Bob + Carol), one row each — Alice (renamer) excluded, no duplicates.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.userId).sort()).toEqual([BOB, CAROL].sort());
    expect(new Set(rows.map((r) => r.userId)).size).toBe(2);
  });
});
