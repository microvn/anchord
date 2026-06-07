import { test, expect } from "bun:test";
import {
  ROLES,
  roleRank,
  maxRole,
  effectiveRole,
  can,
  type Role,
  type Action,
} from "./roles";

// Sharing S-005: UNIT tests of the pure role/capability model. No DB, no ports — this
// module is the contract annotation-core (comment authz) + workspace-project consume.
// Coverage is the full role×action matrix (so a flipped cell flips a test) plus the
// precedence rule (highest role wins across sources).

const ALL_ACTIONS: Action[] = [
  "view",
  "comment",
  "edit",
  "resolve",
  "manage_sharing",
];

// The intended capability matrix, declared independently of roles.ts's internal Set
// so the test is an external oracle: if production drops/adds a capability, the matrix
// here disagrees and the test goes red (falsifiability).
const EXPECTED: Record<Role, Action[]> = {
  viewer: ["view"],
  commenter: ["view", "comment", "resolve"],
  editor: ["view", "comment", "resolve", "edit"],
  owner: ["view", "comment", "resolve", "edit", "manage_sharing"],
};

test("AS-012: viewer can view but cannot comment (and the rest of the viewer row)", () => {
  // The core AS-012 assertion: a viewer has no comment capability. The route that
  // hides the comment box / denies create-comment is annotation-core (integration);
  // the falsy capability is the contract.
  expect(can("viewer", "comment")).toBe(false);

  // Full viewer row, exhaustively: view only, nothing else.
  expect(can("viewer", "view")).toBe(true);
  expect(can("viewer", "resolve")).toBe(false);
  expect(can("viewer", "edit")).toBe(false);
  expect(can("viewer", "manage_sharing")).toBe(false);
});

test("AS-014 / C-007: only the owner manages sharing — editor (and lower) cannot", () => {
  // C-007: v0 = ONLY the owner manages sharing (change access, invite, link controls).
  expect(can("owner", "manage_sharing")).toBe(true);

  // An editor — the highest non-owner role — still cannot manage sharing.
  expect(can("editor", "manage_sharing")).toBe(false);
  // And neither can commenter or viewer. Owner is the sole holder of this capability.
  expect(can("commenter", "manage_sharing")).toBe(false);
  expect(can("viewer", "manage_sharing")).toBe(false);

  const managers = ROLES.filter((r) => can(r, "manage_sharing"));
  expect(managers).toEqual(["owner"]);
});

test("AS-014: editor still has the editing capabilities it should (only manage_sharing is withheld)", () => {
  // Guard against "fix" that withholds manage_sharing by neutering the editor role —
  // editor keeps view/comment/resolve/edit, it just isn't an owner.
  expect(can("editor", "edit")).toBe(true);
  expect(can("editor", "comment")).toBe(true);
  expect(can("editor", "resolve")).toBe(true);
  expect(can("editor", "view")).toBe(true);
});

test("C-007: the full role × action capability matrix is exactly as specified", () => {
  // Exhaustive 4×5 sweep: every cell asserted against the external oracle. Flipping any
  // single capability in roles.ts flips exactly one of these expectations.
  for (const role of ROLES) {
    const granted = new Set(EXPECTED[role]);
    for (const action of ALL_ACTIONS) {
      expect(can(role, action)).toBe(granted.has(action));
    }
  }
});

test("AS-013 / C-002: highest role wins across multiple sources (invite=editor beats link=commenter)", () => {
  // The headline scenario: invited as editor while general-access grants commenter →
  // effective role is editor.
  expect(effectiveRole(["commenter", "editor"])).toBe("editor");
  // Order-independent — the same two sources reversed still resolves to editor.
  expect(effectiveRole(["editor", "commenter"])).toBe("editor");

  // owner beats everything; three sources (link + invite + owner) → owner.
  expect(effectiveRole(["commenter", "editor", "owner"])).toBe("owner");
  // A single source resolves to itself.
  expect(effectiveRole(["viewer"])).toBe("viewer");
});

test("C-002: roleRank / maxRole order roles viewer < commenter < editor < owner", () => {
  // The precedence backbone effectiveRole is built on.
  expect(roleRank("viewer")).toBeLessThan(roleRank("commenter"));
  expect(roleRank("commenter")).toBeLessThan(roleRank("editor"));
  expect(roleRank("editor")).toBeLessThan(roleRank("owner"));

  expect(maxRole("viewer", "editor")).toBe("editor");
  expect(maxRole("owner", "commenter")).toBe("owner");
  // Equal roles → that role (tie).
  expect(maxRole("editor", "editor")).toBe("editor");
});

test("C-002: effectiveRole rejects an empty source list (no access was ever granted)", () => {
  // Boundary / error path: zero sources is a caller bug — must throw, not silently
  // manufacture a viewer role that was never granted.
  expect(() => effectiveRole([])).toThrow();
});
