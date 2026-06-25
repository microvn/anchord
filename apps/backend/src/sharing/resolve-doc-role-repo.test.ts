// UNIT tests (auth-routes S-002) for the owner source of createResolveDocRole and the
// concrete createIsDocOwner read. These close the seam index.ts wired to `() => false`:
// the doc owner's effective role is owner (highest), overriding any lesser stored role.
//
// No real Postgres — a tiny fake DB returns seeded rows per table so the resolver's
// invited-roles + link-role reads run, and `isOwner` is injected. The real-PG path is
// test/integration/sharing-routes.itest.ts.
//
// Covers:
//   AS-005 / C-003 — owner role wins over a lesser stored role (owner > invited commenter).
//   C-003          — createIsDocOwner returns true iff docs.owner_id === userId.

import { describe, expect, test } from "bun:test";
import { docs, docMembers, shareLinks } from "../db/schema";
import type { DB } from "../db/client";
import { createResolveDocRole, createIsDocOwner } from "./resolve-doc-role-repo";

/**
 * Minimal fake of the Drizzle query path the resolver / isOwner use:
 *   db.select(cols).from(table).where(cond) → Promise<rows>
 * Rows are seeded per table; the fake ignores the actual predicate (the seed already
 * scopes to the doc/user under test).
 */
function fakeDb(seed: {
  docRows?: Array<Record<string, unknown>>;
  memberRows?: Array<{ role: string }>;
  // doc-access-two-axis S-001: share_links row carries the two axes (workspaceRole/linkRole).
  linkRows?: Array<Record<string, unknown>>;
}): DB {
  const rowsFor = (table: unknown): Array<Record<string, unknown>> => {
    if (table === docs) return seed.docRows ?? [];
    if (table === docMembers) return seed.memberRows ?? [];
    if (table === shareLinks) return seed.linkRows ?? [];
    return [];
  };
  return {
    select(_cols?: unknown) {
      return {
        from(table: unknown) {
          const rows = rowsFor(table);
          return { where: async () => rows };
        },
      };
    },
  } as unknown as DB;
}

describe("createResolveDocRole owner source (auth-routes S-002)", () => {
  test("AS-005: owner role wins over a lesser stored role (owner beats invited commenter)", async () => {
    // A is BOTH the owner AND an invited ACTIVE commenter on a restricted doc (no link role).
    const db = fakeDb({
      docRows: [{ generalAccess: "restricted" }],
      memberRows: [{ role: "commenter" }],
      linkRows: [],
    });
    const resolve = createResolveDocRole(db, {
      isOwner: async () => true, // A owns the doc
      isWorkspaceMember: () => false,
    });
    const role = await resolve("doc_1", "u_A");
    // effectiveRole folds owner into the sources → highest wins (C-002/C-003), not commenter.
    expect(role).toBe("owner");
  });

  test("C-003: a non-owner with only an invited commenter role resolves to commenter (owner not folded)", async () => {
    // Same stored commenter role, but isOwner false → owner is NOT injected, so the
    // lesser stored role stands (proves the owner fold is what flips AS-005, not a constant).
    const db = fakeDb({
      docRows: [{ generalAccess: "restricted" }],
      memberRows: [{ role: "commenter" }],
      linkRows: [],
    });
    const resolve = createResolveDocRole(db, {
      isOwner: async () => false,
      isWorkspaceMember: () => false,
    });
    const role = await resolve("doc_1", "u_B");
    expect(role).toBe("commenter");
  });

  test("AS-003: an owner with no stored role at all still resolves to owner", async () => {
    // Owner of a restricted doc, no invite, no link role → owner is the ONLY source.
    const db = fakeDb({ docRows: [{ generalAccess: "restricted" }], memberRows: [], linkRows: [] });
    const resolve = createResolveDocRole(db, {
      isOwner: async () => true,
      isWorkspaceMember: () => false,
    });
    expect(await resolve("doc_1", "u_A")).toBe("owner");
  });

  // ── workspaces S-006 (C-002): anyone_in_workspace is scoped to the DOC's workspace ──

  test("AS-020: a member of the DOC's workspace gets the link role on an anyone_in_workspace doc", async () => {
    // The doc is anyone_in_workspace with a viewer link role; Carol is a member of the
    // doc's OWN workspace → the link admits her, so she resolves to the link's viewer role.
    const db = fakeDb({
      docRows: [{ generalAccess: "anyone_in_workspace" }],
      memberRows: [],
      linkRows: [{ workspaceRole: "viewer", linkRole: null }],
    });
    const resolve = createResolveDocRole(db, {
      isOwner: async () => false,
      // The resolver passes (docId, userId); membership of THIS doc's workspace is true.
      isWorkspaceMember: (docId, _userId) => docId === "doc_1",
    });
    expect(await resolve("doc_1", "u_carol")).toBe("viewer");
  });

  test("AS-019: a member of ANOTHER workspace does NOT get anyone_in_workspace access to this doc", async () => {
    // Bob is a member of a DIFFERENT workspace, so isWorkspaceMember for THIS doc is false
    // → the anyone_in_workspace link does not admit him → no role (null).
    const db = fakeDb({
      docRows: [{ generalAccess: "anyone_in_workspace" }],
      memberRows: [],
      linkRows: [{ workspaceRole: "viewer", linkRole: null }],
    });
    const resolve = createResolveDocRole(db, {
      isOwner: async () => false,
      // Bob is NOT a member of this doc's workspace → false (the cross-tenant guard, C-002).
      isWorkspaceMember: () => false,
    });
    expect(await resolve("doc_1", "u_bob")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// doc-access-two-axis S-003 (C-005): the LOGGED-IN resolver folds the effective role
// from both axes (workspace_role member-gated + link_role) plus owner + invite, highest
// wins. A logged-in caller reaches link_role unconditionally (C-005: "link_role when the
// caller holds the link"); the anon cap (C-004) lives at the anon seam, not here.
// ─────────────────────────────────────────────────────────────────────────────
describe("createResolveDocRole — effective role from both axes (S-003 / C-005)", () => {
  test("AS-008: a logged-in person on an editor link resolves to editor (can publish)", async () => {
    // link_role = editor, no workspace axis, no invite, not owner → the link axis is the
    // sole source and a LOGGED-IN caller gets the full editor role (un-capped — the cap is
    // anon-only, C-004). editor → can edit (publish a version).
    const db = fakeDb({
      memberRows: [],
      linkRows: [{ workspaceRole: null, linkRole: "editor" }],
    });
    const resolve = createResolveDocRole(db, {
      isOwner: async () => false,
      isWorkspaceMember: () => false,
    });
    expect(await resolve("doc_1", "u_loggedin")).toBe("editor");
  });

  test("AS-010: highest role wins across sources (workspace=commenter + invite=editor → editor)", async () => {
    // C is a workspace member of a doc shared workspace=commenter AND is individually
    // invited as editor. Both sources contribute; effectiveRole picks the higher (editor).
    const db = fakeDb({
      memberRows: [{ role: "editor" }], // individual invite = editor
      linkRows: [{ workspaceRole: "commenter", linkRole: null }], // workspace axis = commenter
    });
    const resolve = createResolveDocRole(db, {
      isOwner: async () => false,
      isWorkspaceMember: (docId) => docId === "doc_1", // C is a member of this doc's workspace
    });
    expect(await resolve("doc_1", "u_c")).toBe("editor");
  });

  test("AS-010 (both axes set): a logged-in member folds BOTH axes, highest wins (workspace=commenter + link=editor → editor)", async () => {
    // A doc shared with the workspace at commenter AND link-shared at editor. A logged-in
    // workspace member reaches both axes; the resolver must fold both (not just the one a
    // derived level would pick) → editor wins. Negating the link-axis fold turns this red.
    const db = fakeDb({
      memberRows: [],
      linkRows: [{ workspaceRole: "commenter", linkRole: "editor" }],
    });
    const resolve = createResolveDocRole(db, {
      isOwner: async () => false,
      isWorkspaceMember: (docId) => docId === "doc_1",
    });
    expect(await resolve("doc_1", "u_member")).toBe("editor");
  });
});

describe("createIsDocOwner (auth-routes S-002, C-003)", () => {
  test("C-003: returns true when docs.owner_id === userId", async () => {
    const db = fakeDb({ docRows: [{ ownerId: "u_A" }] });
    const isOwner = createIsDocOwner(db);
    expect(await isOwner("doc_1", "u_A")).toBe(true);
  });

  test("C-003: returns false when docs.owner_id !== userId", async () => {
    const db = fakeDb({ docRows: [{ ownerId: "u_A" }] });
    const isOwner = createIsDocOwner(db);
    expect(await isOwner("doc_1", "u_B")).toBe(false);
  });

  test("C-003: returns false when the doc has no owner (owner_id null)", async () => {
    const db = fakeDb({ docRows: [{ ownerId: null }] });
    const isOwner = createIsDocOwner(db);
    expect(await isOwner("doc_1", "u_A")).toBe(false);
  });

  test("C-003: returns false when the doc does not exist (no row)", async () => {
    const db = fakeDb({ docRows: [] });
    const isOwner = createIsDocOwner(db);
    expect(await isOwner("missing", "u_A")).toBe(false);
  });
});
