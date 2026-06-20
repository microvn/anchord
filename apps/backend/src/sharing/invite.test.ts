import { test, expect } from "bun:test";
import {
  inviteByEmail,
  createFakeDocMemberStore,
  createDocMembersPendingInviteRepo,
  makeIsInvited,
  type InviteDeps,
} from "./invite";
import { activatePendingInvites } from "../auth/invite";
import { notifyOnInvited, type NotifyRepo, type MailEnqueuer } from "../notify/notify";

// Sharing S-003: an owner invites by email + role + message. An existing account is
// granted the role immediately (ACTIVE doc_members row) + notified; an email with no
// account gets a PENDING row that activates when an account for that email is created
// + verified (C-006).
//
// UNIT tests of the invite LOGIC + the concrete PendingInviteRepo adapter against an
// in-memory member store (mirrors share.ts's fakeRepo pattern). The real Drizzle glue
// over doc_members, and auth calling the repo live at signup, are
// integration-verified-later — but we drive auth's activatePendingInvites here with a
// FAKE-backed concrete repo to prove the round-trip (pending row → verified signup →
// editor role) at the unit level.

// Build the invite deps over a fresh fake store, recording enqueued mail so we can
// assert "is notified" / "email sent" without a real transport.
function setup(opts: { existingEmails?: string[] } = {}) {
  const store = createFakeDocMemberStore();
  const accounts = new Map<string, { id: string }>();
  let seq = 0;
  for (const e of opts.existingEmails ?? []) {
    accounts.set(e.trim().toLowerCase(), { id: `user_${++seq}` });
  }
  const enqueued: Array<{ kind: "active" | "pending"; email: string; inviteId: string }> = [];
  const deps: InviteDeps = {
    findUserByEmail(email) {
      return accounts.get(email.trim().toLowerCase()) ?? null;
    },
    members: store,
    enqueueInvite(msg) {
      enqueued.push(msg);
    },
  };
  return { store, deps, enqueued, accounts };
}

test("AS-007: invite an existing account → ACTIVE editor doc_members row + notified", async () => {
  const f = setup({ existingEmails: ["dev@acme.com"] });

  const out = await inviteByEmail(
    {
      docId: "doc-1",
      email: "dev@acme.com",
      role: "editor",
      message: "please review",
      invitedBy: "owner-1",
    },
    f.deps,
  );

  // An ACTIVE row exists with the userId bound + the editor role + the message.
  const rows = f.store.rows();
  expect(rows).toHaveLength(1);

  // Returns active + the granted role + the created row's id (AS-022: FE targets it for PATCH/DELETE).
  expect(out).toEqual({ status: "active", role: "editor", id: rows[0].id });
  expect(rows[0]).toMatchObject({
    docId: "doc-1",
    email: "dev@acme.com",
    role: "editor",
    message: "please review",
    status: "active",
    invitedBy: "owner-1",
  });
  expect(rows[0].userId).toBe("user_1"); // bound to the existing account

  // Notified: a mail was enqueued for that person, carrying the created row's id.
  expect(f.enqueued).toEqual([{ kind: "active", email: "dev@acme.com", inviteId: rows[0].id }]);
});

test("AS-008: invite an email with no account → PENDING row + invite mail enqueued", async () => {
  const f = setup(); // no accounts exist

  const out = await inviteByEmail(
    { docId: "doc-1", email: "bob@x.com", role: "editor", invitedBy: "owner-1" },
    f.deps,
  );

  const rows = f.store.rows();
  expect(rows).toHaveLength(1);

  // Returns pending + the created row's id (AS-022: a freshly invited pending person is removable).
  expect(out).toEqual({ status: "pending", id: rows[0].id });
  expect(rows[0]).toMatchObject({
    docId: "doc-1",
    email: "bob@x.com",
    role: "editor",
    status: "pending",
  });
  expect(rows[0].userId).toBeNull(); // no account yet → unbound

  // Invite mail (not an active-notify) enqueued so Bob can find his way in — carrying the
  // REAL pending-invite id the accept-link is minted against (AS-011).
  expect(f.enqueued).toEqual([{ kind: "pending", email: "bob@x.com", inviteId: rows[0].id }]);
});

test("AS-008 / C-006: pending invite keyed by email activates on verified signup → editor role (round-trip via auth)", async () => {
  const f = setup(); // Bob has no account

  await inviteByEmail(
    { docId: "doc-1", email: "Bob@x.com", role: "editor", invitedBy: "owner-1" },
    f.deps,
  );

  // The concrete repo auth's activatePendingInvites will drive, backed by our store.
  const repo = createDocMembersPendingInviteRepo(f.store);

  // Before signup: Bob is not yet an active member of the doc.
  const isInvited = makeIsInvited(f.store);
  // Bob's account is created at signup time; the repo binds the pending row to it.
  const activated = await activatePendingInvites("bob@x.com", "bob-user", true, repo);

  // The pending invite activated for the doc with the editor role.
  expect(activated).toEqual([{ inviteId: rowId(f), docId: "doc-1", role: "editor" }]);

  // The doc_members row is now ACTIVE, bound to Bob.
  const rows = f.store.rows();
  expect(rows[0].status).toBe("active");
  expect(rows[0].userId).toBe("bob-user");

  // And the concrete isInvited backing for access.ts now returns true for Bob.
  expect(isInvited("doc-1", "bob-user")).toBe(true);
});

test("C-006: an UNVERIFIED signup does NOT activate the pending invite (verification gate)", async () => {
  const f = setup();
  await inviteByEmail(
    { docId: "doc-1", email: "bob@x.com", role: "editor", invitedBy: "owner-1" },
    f.deps,
  );
  const repo = createDocMembersPendingInviteRepo(f.store);

  const activated = await activatePendingInvites("bob@x.com", "bob-user", false, repo);

  expect(activated).toEqual([]);
  expect(f.store.rows()[0].status).toBe("pending"); // still pending
  expect(f.store.rows()[0].userId).toBeNull();
});

test("C-006: the repo matches by EXACT normalized email — a different signer activates nothing (AS-009 cross-check)", async () => {
  const f = setup();
  await inviteByEmail(
    { docId: "doc-1", email: "bob@x.com", role: "editor", invitedBy: "owner-1" },
    f.deps,
  );
  const repo = createDocMembersPendingInviteRepo(f.store);

  // Someone else verified-signs-up; the repo finds none of their invites.
  const found = await repo.findPendingByEmail("eve@x.com");
  expect(found).toEqual([]);

  const activated = await activatePendingInvites("eve@x.com", "eve-user", true, repo);
  expect(activated).toEqual([]);
  expect(f.store.rows()[0].status).toBe("pending");
});

test("AS-007: email match is normalized (lowercase + trim) when finding the account", async () => {
  const f = setup({ existingEmails: ["dev@acme.com"] });

  const out = await inviteByEmail(
    { docId: "doc-1", email: "  DEV@Acme.com  ", role: "commenter", invitedBy: "owner-1" },
    f.deps,
  );

  expect(out.status).toBe("active");
  // Stored email is normalized so pending-match + isInvited stay consistent.
  expect(f.store.rows()[0].email).toBe("dev@acme.com");
  expect(f.store.rows()[0].role).toBe("commenter");
});

// Helper: the id of the single row in the store (tests with exactly one invite).
function rowId(f: { store: ReturnType<typeof createFakeDocMemberStore> }): string {
  return f.store.rows()[0].id;
}

// ── notifications-email S-005 — notify the invitee on being added (AS-010) ──
// The invite flow fires the IN-APP `invited` notify ONLY on the account-exists branch
// (a resolvable userId). The pending branch (no account → null userId) fires NO notify.
// notify is best-effort: a throwing notify must never fail the invite.

// setup variant that captures notifyInvited calls (the in-app dispatch hook).
function setupNotify(opts: { existingEmails?: string[]; notifyThrows?: boolean } = {}) {
  const store = createFakeDocMemberStore();
  const accounts = new Map<string, { id: string }>();
  let seq = 0;
  for (const e of opts.existingEmails ?? []) {
    accounts.set(e.trim().toLowerCase(), { id: `user_${++seq}` });
  }
  const enqueued: Array<{ kind: "active" | "pending"; email: string; inviteId: string }> = [];
  const notified: Array<{ userId: string; refId: string }> = [];
  const deps: InviteDeps = {
    findUserByEmail(email) {
      return accounts.get(email.trim().toLowerCase()) ?? null;
    },
    members: store,
    enqueueInvite(msg) {
      enqueued.push(msg);
    },
    async notifyInvited(userId, refId) {
      if (opts.notifyThrows) throw new Error("notify boom");
      notified.push({ userId, refId });
    },
  };
  return { store, deps, enqueued, notified, accounts };
}

test("AS-010: invite an EXISTING account → ONE in-app `invited` dispatch for the bound invitee userId", async () => {
  const f = setupNotify({ existingEmails: ["dev@acme.com"] });

  const out = await inviteByEmail(
    { docId: "doc-1", email: "dev@acme.com", role: "editor", invitedBy: "owner-1" },
    f.deps,
  );

  expect(out.status).toBe("active");
  // The in-app notify fired ONCE, to the bound account userId, referencing the doc.
  expect(f.notified).toEqual([{ userId: "user_1", refId: "doc-1" }]);
  // The pre-existing transactional invite mail still fires (separate channel — not removed).
  expect(f.enqueued).toEqual([{ kind: "active", email: "dev@acme.com", inviteId: f.store.rows()[0].id }]);
});

test("AS-010 (pending nuance): invite an email with NO account → NO in-app dispatch (no userId)", async () => {
  const f = setupNotify(); // no accounts

  const out = await inviteByEmail(
    { docId: "doc-1", email: "bob@x.com", role: "editor", invitedBy: "owner-1" },
    f.deps,
  );

  expect(out.status).toBe("pending");
  // No account → no resolvable userId → NO in-app notify row.
  expect(f.notified).toHaveLength(0);
  // The transactional pending invite mail still fires unchanged.
  expect(f.enqueued).toEqual([{ kind: "pending", email: "bob@x.com", inviteId: f.store.rows()[0].id }]);
});

test("AS-010 (self-invite): inviting one's own account still fires the in-app dispatch (no special-case)", async () => {
  const f = setupNotify({ existingEmails: ["owner@me.com"] });

  const out = await inviteByEmail(
    { docId: "doc-1", email: "owner@me.com", role: "commenter", invitedBy: "user_1" },
    f.deps,
  );

  // Reasonable behavior: the flow does not crash; the bound account gets a row (no self-guard here).
  expect(out.status).toBe("active");
  expect(f.notified).toEqual([{ userId: "user_1", refId: "doc-1" }]);
});

test("C-007: a THROWING notifyInvited never fails the invite (best-effort) — active row still created", async () => {
  const f = setupNotify({ existingEmails: ["dev@acme.com"], notifyThrows: true });

  const out = await inviteByEmail(
    { docId: "doc-1", email: "dev@acme.com", role: "editor", invitedBy: "owner-1" },
    f.deps,
  );

  // Invite SUCCEEDS despite the notify throwing — the active row + transactional mail persist.
  expect(out).toMatchObject({ status: "active", role: "editor" });
  expect(f.store.rows()[0].status).toBe("active");
  expect(f.enqueued).toHaveLength(1);
});

test("AS-010 (back-compat): an invite with NO notifyInvited hook still works (optional dep)", async () => {
  const f = setup({ existingEmails: ["dev@acme.com"] }); // base setup — no notifyInvited

  const out = await inviteByEmail(
    { docId: "doc-1", email: "dev@acme.com", role: "editor", invitedBy: "owner-1" },
    f.deps,
  );

  expect(out.status).toBe("active");
  expect(f.store.rows()).toHaveLength(1);
});

// Surface-level test: drive the REAL notifyOnInvited against a recording NotifyRepo through
// the real inviteByEmail wiring (the in-app channel end-to-end, no mocked notify body).
test("AS-010 (surface): inviteByEmail wired to the REAL notifyOnInvited writes ONE in-app `invited` row, NO email", async () => {
  const store = createFakeDocMemberStore();
  const accounts = new Map([["dev@acme.com", { id: "dev-user" }]]);

  const inserted: Array<{ userId: string; type: string; refId: string }> = [];
  const mailSent: unknown[] = [];
  const notifyRepo: NotifyRepo = {
    async listParticipantIds() { return []; },
    async getDocOwnerId() { return null; },
    async getUserEmail() { return null; },
    async insertNotification(input) {
      inserted.push({ userId: input.userId, type: input.type, refId: input.refId });
      return { id: `n_${inserted.length}` };
    },
  };
  const notifyMail: MailEnqueuer = {
    enqueue(msg) {
      mailSent.push(msg);
      return "m_1";
    },
  };

  const deps: InviteDeps = {
    findUserByEmail: (email) => accounts.get(email.trim().toLowerCase()) ?? null,
    members: store,
    enqueueInvite() {},
    // The real production wiring: the hook drives notifyOnInvited with the real ports.
    notifyInvited: (userId, refId) =>
      notifyOnInvited({ refId, inviteeUserId: userId }, { repo: notifyRepo, mail: notifyMail }).then(() => undefined),
  };

  const out = await inviteByEmail(
    { docId: "doc-1", email: "dev@acme.com", role: "editor", invitedBy: "owner-1" },
    deps,
  );

  expect(out.status).toBe("active");
  // REAL notify wrote exactly one in-app row, typed `invited`, NO email enqueued (low-signal).
  expect(inserted).toEqual([{ userId: "dev-user", type: "invited", refId: "doc-1" }]);
  expect(mailSent).toHaveLength(0);
});
