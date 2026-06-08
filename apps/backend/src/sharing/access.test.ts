import { test, expect } from "bun:test";
import {
  canViewDoc,
  type AccessDeps,
  type Viewer,
  type GeneralAccessLevel,
} from "./access";

// Sharing S-002: the doc read-gate. UNIT tests of the DECISION logic against fake
// deps (mirrors share.ts's fakeRepo pattern). The no-leak behaviour for a deny is the
// route serving the not-access page (integration) — here we assert the boolean only.

// Configurable fake deps: declare which user is invited / which is a workspace member.
function deps(opts?: { invited?: string[]; members?: string[] }): AccessDeps {
  const invited = new Set(opts?.invited ?? []);
  const members = new Set(opts?.members ?? []);
  return {
    isInvited: (_docId, userId) => invited.has(userId),
    isWorkspaceMember: (userId) => members.has(userId),
  };
}

const anon: Viewer = { kind: "anon" };
const user = (id: string): Viewer => ({ kind: "user", userId: id });

test("AS-004: anyone-with-link lets a logged-out (anon) person view", () => {
  // The anon view itself; the random name they get is asserted in anon-identity.test.ts.
  const d = canViewDoc({
    docId: "doc-1",
    generalAccess: "anyone_with_link",
    viewer: anon,
    deps: deps(),
  });
  expect(d).toEqual({ allowed: true });

  // A logged-in user with no invite & no membership also gets in via the link.
  const u = canViewDoc({
    docId: "doc-1",
    generalAccess: "anyone_with_link",
    viewer: user("u-stranger"),
    deps: deps(),
  });
  expect(u.allowed).toBe(true);
});

test("AS-006: restricted denies an uninvited stranger with a clean deny (no content)", () => {
  // Anon on a restricted doc → denied, no leak (route serves the not-access page).
  const a = canViewDoc({
    docId: "doc-1",
    generalAccess: "restricted",
    viewer: anon,
    deps: deps({ invited: ["u-invited"] }),
  });
  expect(a.allowed).toBe(false);
  // The decision carries NO content field — just a reason for logging. No-leak = the
  // shape is a pure boolean+reason, the route never receives doc content on a deny.
  expect(a).toEqual({ allowed: false, reason: "anon_not_allowed" });

  // A logged-in but uninvited user → also denied.
  const stranger = canViewDoc({
    docId: "doc-1",
    generalAccess: "restricted",
    viewer: user("u-stranger"),
    deps: deps({ invited: ["u-invited"] }),
  });
  expect(stranger).toEqual({ allowed: false, reason: "restricted_not_invited" });

  // An invited user (or owner) → allowed.
  const invited = canViewDoc({
    docId: "doc-1",
    generalAccess: "restricted",
    viewer: user("u-invited"),
    deps: deps({ invited: ["u-invited"] }),
  });
  expect(invited).toEqual({ allowed: true });
});

test("AS-015: anyone_in_workspace — member gets in, outsider & anon are denied", () => {
  const dp = deps({ members: ["u-member"] });

  // Logged-in workspace member, no individual invite → in.
  const member = canViewDoc({
    docId: "doc-1",
    generalAccess: "anyone_in_workspace",
    viewer: user("u-member"),
    deps: dp,
  });
  expect(member).toEqual({ allowed: true });

  // Logged-in but NOT a workspace member → denied.
  const outsider = canViewDoc({
    docId: "doc-1",
    generalAccess: "anyone_in_workspace",
    viewer: user("u-outsider"),
    deps: dp,
  });
  expect(outsider).toEqual({ allowed: false, reason: "workspace_not_member" });

  // Logged-out / anonymous → denied (anon never qualifies for workspace-only).
  const a = canViewDoc({
    docId: "doc-1",
    generalAccess: "anyone_in_workspace",
    viewer: anon,
    deps: dp,
  });
  expect(a).toEqual({ allowed: false, reason: "anon_not_allowed" });
});

test("C-009: the three access levels give distinct outcomes (restricted < anyone_in_workspace < anyone_with_link)", () => {
  // Four viewer kinds across all three levels makes the ordering explicit: each level
  // up admits a strictly larger set.
  const dp = deps({ invited: ["u-invited"], members: ["u-member", "u-invited"] });
  const viewers: Record<string, Viewer> = {
    anon,
    member: user("u-member"),
    nonMember: user("u-outsider"),
    invited: user("u-invited"),
  };
  const allowedSet = (level: GeneralAccessLevel) =>
    Object.entries(viewers)
      .filter(([, v]) => canViewDoc({ docId: "doc-1", generalAccess: level, viewer: v, deps: dp }).allowed)
      .map(([k]) => k)
      .sort();

  // restricted: only the invited user (owner/invitee).
  expect(allowedSet("restricted")).toEqual(["invited"]);
  // anyone_in_workspace: every logged-in MEMBER (here member + invited who is also a
  // member); NO anon, NO non-member. Strict superset of restricted's admitted users.
  expect(allowedSet("anyone_in_workspace")).toEqual(["invited", "member"]);
  // anyone_with_link: everyone, including anon and outsiders. Strict superset again.
  expect(allowedSet("anyone_with_link")).toEqual(["anon", "invited", "member", "nonMember"]);

  // Anon is the discriminator that proves the top level is distinct from the lower two.
  const anonByLevel = (level: GeneralAccessLevel) =>
    canViewDoc({ docId: "doc-1", generalAccess: level, viewer: anon, deps: dp }).allowed;
  expect(anonByLevel("restricted")).toBe(false);
  expect(anonByLevel("anyone_in_workspace")).toBe(false);
  expect(anonByLevel("anyone_with_link")).toBe(true);
});
