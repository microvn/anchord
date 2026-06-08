import { test, expect } from "bun:test";
import {
  inviteByEmail,
  createFakeDocMemberStore,
  createDocMembersPendingInviteRepo,
  makeIsInvited,
  type InviteDeps,
} from "./invite";
import { activatePendingInvites } from "../auth/invite";

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
  const enqueued: Array<{ kind: "active" | "pending"; email: string }> = [];
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

  // Returns active + the granted role.
  expect(out).toEqual({ status: "active", role: "editor" });

  // An ACTIVE row exists with the userId bound + the editor role + the message.
  const rows = f.store.rows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    docId: "doc-1",
    email: "dev@acme.com",
    role: "editor",
    message: "please review",
    status: "active",
    invitedBy: "owner-1",
  });
  expect(rows[0].userId).toBe("user_1"); // bound to the existing account

  // Notified: a mail was enqueued for that person.
  expect(f.enqueued).toEqual([{ kind: "active", email: "dev@acme.com" }]);
});

test("AS-008: invite an email with no account → PENDING row + invite mail enqueued", async () => {
  const f = setup(); // no accounts exist

  const out = await inviteByEmail(
    { docId: "doc-1", email: "bob@x.com", role: "editor", invitedBy: "owner-1" },
    f.deps,
  );

  expect(out).toEqual({ status: "pending" });

  const rows = f.store.rows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    docId: "doc-1",
    email: "bob@x.com",
    role: "editor",
    status: "pending",
  });
  expect(rows[0].userId).toBeNull(); // no account yet → unbound

  // Invite mail (not an active-notify) enqueued so Bob can find his way in.
  expect(f.enqueued).toEqual([{ kind: "pending", email: "bob@x.com" }]);
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
