import { test, expect } from "bun:test";
import {
  activatePendingInvites,
  acceptInviteByLink,
  buildAcceptLink,
  parseAcceptLink,
  normalizeEmail,
  type PendingInvite,
  type PendingInviteRepo,
} from "./invite";

// S-005: activate pending invite on sign up.
// The concrete PendingInviteRepo lands in sharing-permissions (owns doc_members);
// here we drive the activation logic with a fake repo.

function makeRepo(invites: PendingInvite[]) {
  const activated: Array<{ inviteId: string; userId: string }> = [];
  const repo: PendingInviteRepo = {
    async findPendingByEmail(email: string) {
      const norm = email.trim().toLowerCase();
      return invites.filter((i) => i.email.trim().toLowerCase() === norm && i.status === "pending");
    },
    async activate(inviteId: string, userId: string) {
      activated.push({ inviteId, userId });
      const inv = invites.find((i) => i.id === inviteId);
      if (inv) inv.status = "active";
    },
  };
  return { repo, activated };
}

const bobInvite: PendingInvite = {
  id: "inv-1",
  docId: "doc-1",
  email: "bob@x.com",
  role: "editor",
  status: "pending",
};

test("AS-008: sign up with the invited email (verified) activates the editor role", async () => {
  const { repo, activated } = makeRepo([{ ...bobInvite }]);

  const result = await activatePendingInvites("bob@x.com", "user-bob", true, repo);

  expect(result).toEqual([{ inviteId: "inv-1", docId: "doc-1", role: "editor" }]);
  expect(activated).toEqual([{ inviteId: "inv-1", userId: "user-bob" }]);
});

test("AS-008: invited-email match is case-insensitive (special-casing edge), still activates", async () => {
  const { repo, activated } = makeRepo([{ ...bobInvite }]);

  const result = await activatePendingInvites("BOB@X.com", "user-bob", true, repo);

  expect(result.map((r) => r.role)).toEqual(["editor"]);
  expect(activated).toHaveLength(1);
});

test("AS-009: a different email does NOT activate someone else's invite", async () => {
  const { repo, activated } = makeRepo([{ ...bobInvite }]);

  const result = await activatePendingInvites("eve@x.com", "user-eve", true, repo);

  expect(result).toEqual([]);
  expect(activated).toEqual([]); // bob's invite untouched
});

test("C-005: a pending invite activates only when the exact email exists AND is verified", async () => {
  // Verified + exact → activates.
  {
    const { repo, activated } = makeRepo([{ ...bobInvite }]);
    const ok = await activatePendingInvites("bob@x.com", "user-bob", true, repo);
    expect(ok).toHaveLength(1);
    expect(activated).toHaveLength(1);
  }
  // UNVERIFIED exact email → activates NOTHING (mirror the verification gate).
  {
    const { repo, activated } = makeRepo([{ ...bobInvite }]);
    const blocked = await activatePendingInvites("bob@x.com", "user-bob", false, repo);
    expect(blocked).toEqual([]);
    expect(activated).toEqual([]);
  }
});

test("C-005: empty / missing email or userId activates nothing (null/empty + boundary edge)", async () => {
  const { repo, activated } = makeRepo([{ ...bobInvite }]);

  expect(await activatePendingInvites("", "user-bob", true, repo)).toEqual([]);
  expect(await activatePendingInvites("   ", "user-bob", true, repo)).toEqual([]);
  expect(await activatePendingInvites("bob@x.com", "", true, repo)).toEqual([]);
  // @ts-expect-error invalid type guard
  expect(await activatePendingInvites(null, "user-bob", true, repo)).toEqual([]);
  expect(activated).toEqual([]);
});

test("C-005: a non-pending (already active) invite is never re-activated (status guard)", async () => {
  const { repo, activated } = makeRepo([{ ...bobInvite, status: "active" }]);

  const result = await activatePendingInvites("bob@x.com", "user-bob", true, repo);

  expect(result).toEqual([]);
  expect(activated).toEqual([]);
});

test("AS-008: multiple pending invites for the same email all activate", async () => {
  const second: PendingInvite = { id: "inv-2", docId: "doc-2", email: "bob@x.com", role: "viewer", status: "pending" };
  const { repo, activated } = makeRepo([{ ...bobInvite }, { ...second }]);

  const result = await activatePendingInvites("bob@x.com", "user-bob", true, repo);

  expect(result.map((r) => r.docId).sort()).toEqual(["doc-1", "doc-2"]);
  expect(activated).toHaveLength(2);
});

// --- Accept-link (AS-011 / C-009): the email-independent acceptance path ---

test("C-009: accept-link round-trips (build then parse) including special chars", async () => {
  const link = buildAcceptLink("inv/1", "tok en+/=");
  const parsed = parseAcceptLink(link);
  expect(parsed).toEqual({ inviteId: "inv/1", token: "tok en+/=" });
});

test("C-009: malformed accept-links parse to null (invalid-input edge)", () => {
  expect(parseAcceptLink("/wrong/prefix/x/y")).toBeNull();
  expect(parseAcceptLink("/invite/accept/only-id")).toBeNull();
  expect(parseAcceptLink("/invite/accept//tok")).toBeNull();
  // @ts-expect-error invalid type
  expect(parseAcceptLink(null)).toBeNull();
});

test("AS-011: invite accept-link works even when the mail transport is failing (email-independent)", async () => {
  const { repo, activated } = makeRepo([{ ...bobInvite }]);
  const token = "secret-token";
  const link = buildAcceptLink("inv-1", token);

  // No mailer involved at all — the link path does not depend on email arriving.
  const result = await acceptInviteByLink(link, "user-bob", "bob@x.com", true, token, repo);

  expect(result).toEqual({ inviteId: "inv-1", docId: "doc-1", role: "editor" });
  expect(activated).toEqual([{ inviteId: "inv-1", userId: "user-bob" }]);
});

test("C-009: accept-link rejects a wrong token / wrong email / unverified (still gated)", async () => {
  const token = "secret-token";
  const link = buildAcceptLink("inv-1", token);

  {
    const { repo } = makeRepo([{ ...bobInvite }]);
    expect(await acceptInviteByLink(link, "user-bob", "bob@x.com", true, "WRONG", repo)).toBeNull();
  }
  {
    const { repo } = makeRepo([{ ...bobInvite }]);
    expect(await acceptInviteByLink(link, "user-eve", "eve@x.com", true, token, repo)).toBeNull();
  }
  {
    const { repo } = makeRepo([{ ...bobInvite }]);
    expect(await acceptInviteByLink(link, "user-bob", "bob@x.com", false, token, repo)).toBeNull();
  }
});

test("normalizeEmail lowercases and trims", () => {
  expect(normalizeEmail("  BOB@X.com ")).toBe("bob@x.com");
});
