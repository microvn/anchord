import { test, expect } from "bun:test";
import {
  ROLES,
  roleRank,
  maxRole,
  effectiveRole,
  can,
  canManageSharing,
  canToggleEditorsCanShare,
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

test("C-007 (static default): can(role, manage_sharing) is the conservative owner-only fallback", () => {
  // The STATIC table is the owner-only fallback a caller falls back to if it ignores the
  // per-doc editors_can_share toggle. The REAL gate is canManageSharing (below) — this
  // asserts the static default stays conservative (editor not granted in the flat table).
  expect(can("owner", "manage_sharing")).toBe(true);
  expect(can("editor", "manage_sharing")).toBe(false);
  expect(can("commenter", "manage_sharing")).toBe(false);
  expect(can("viewer", "manage_sharing")).toBe(false);

  const managers = ROLES.filter((r) => can(r, "manage_sharing"));
  expect(managers).toEqual(["owner"]);
});

test("AS-014: an editor CAN manage sharing when editors_can_share is enabled (default)", () => {
  // The Google-Docs default (C-007): with the toggle ON, an editor manages sharing.
  expect(canManageSharing({ role: "editor", editorsCanShare: true })).toBe(true);
  // The owner always manages, toggle or not.
  expect(canManageSharing({ role: "owner", editorsCanShare: true })).toBe(true);
  expect(canManageSharing({ role: "owner", editorsCanShare: false })).toBe(true);
});

test("AS-023: an editor CANNOT manage sharing when editors_can_share is disabled", () => {
  // The owner locked sharing to themselves → an editor is denied.
  expect(canManageSharing({ role: "editor", editorsCanShare: false })).toBe(false);
  // The owner is unaffected by the toggle.
  expect(canManageSharing({ role: "owner", editorsCanShare: false })).toBe(true);
});

test("AS-024: a viewer/commenter can NEVER manage sharing, regardless of the toggle", () => {
  for (const ecs of [true, false]) {
    expect(canManageSharing({ role: "viewer", editorsCanShare: ecs })).toBe(false);
    expect(canManageSharing({ role: "commenter", editorsCanShare: ecs })).toBe(false);
  }
});

test("AS-022 / C-015: only the OWNER may toggle editors_can_share", () => {
  // The toggle is owner-reserved — even an editor who may otherwise manage sharing
  // (toggle on) cannot flip the toggle itself.
  expect(canToggleEditorsCanShare("owner")).toBe(true);
  expect(canToggleEditorsCanShare("editor")).toBe(false);
  expect(canToggleEditorsCanShare("commenter")).toBe(false);
  expect(canToggleEditorsCanShare("viewer")).toBe(false);

  const togglers = ROLES.filter((r) => canToggleEditorsCanShare(r));
  expect(togglers).toEqual(["owner"]);
});

test("AS-014: editor still has the editing capabilities it should (manage-sharing is contextual, not removed)", () => {
  // Guard against a "fix" that neuters the editor role — editor keeps view/comment/
  // resolve/edit; its manage-sharing ability is contextual (the toggle), not gone.
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
