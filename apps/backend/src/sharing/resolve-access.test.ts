// UNIT tests (doc-access-routing S-001) for the SINGLE authoritative access gate
// `resolveAccess` — the one place "can this viewer see this doc, and at what role" is
// decided, applied on every doc-centric route. Replaces the permissive `canViewDoc`
// stubs (index.ts `isInvited: () => true, isWorkspaceMember: () => true`).
//
// These wire the REAL `createResolveDocRole` underneath `createResolveAccess` so the
// end-to-end S-001 behaviour is exercised (most-permissive across owner/invited/
// workspace/link, resolved against the doc's OWN workspace; project-less fail-closed),
// not a mocked resolver. A tiny fake DB returns seeded rows per table; the owner +
// workspace-membership ports are injected to model each scenario.

import { describe, expect, test } from "bun:test";
import { docs, docMembers, shareLinks } from "../db/schema";
import type { DB } from "../db/client";
import type { Viewer } from "./access";
import { createResolveDocRole } from "./resolve-doc-role-repo";
import { createResolveAccess } from "./resolve-access";

/** Minimal Drizzle fake: select(...).from(table).where(...).limit?() → seeded rows. */
function fakeDb(seed: {
  docRows?: Array<Record<string, unknown>>;
  memberRows?: Array<{ role: string }>;
  linkRows?: Array<{ role: string }>;
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
          const result = Promise.resolve(rows);
          // where(...) returns a thenable that also supports .limit(...)
          const where = () => Object.assign(Promise.resolve(rows), { limit: () => result });
          return { where };
        },
      };
    },
  } as unknown as DB;
}

const anon: Viewer = { kind: "anon" };
const asUser = (id: string): Viewer => ({ kind: "user", userId: id });

/** Build resolveAccess on top of the REAL resolveDocRole, with injected ports. */
function buildGate(
  db: DB,
  ports: { isOwner: (d: string, u: string) => Promise<boolean>; isWorkspaceMember: (d: string, u: string) => boolean | Promise<boolean> },
) {
  const resolveDocRole = createResolveDocRole(db, {
    isOwner: ports.isOwner,
    isWorkspaceMember: ports.isWorkspaceMember,
  });
  return createResolveAccess(db, { resolveDocRole });
}

describe("resolveAccess — the single doc-access gate (S-001)", () => {
  test("AS-001 / C-001: owner always resolves to owner via the single gate (restricted doc, owned by Alice)", async () => {
    const db = fakeDb({ docRows: [{ generalAccess: "restricted", ownerId: "u_alice" }], memberRows: [], linkRows: [] });
    const gate = buildGate(db, { isOwner: async (_d, u) => u === "u_alice", isWorkspaceMember: () => false });
    const r = await gate("doc_1", asUser("u_alice"));
    expect(r).toEqual({ role: "owner", canView: true });
  });

  test("AS-002: invited outsider gets invited role on an anyone_in_workspace doc (non-member but invited commenter)", async () => {
    // Bob is NOT a member of the doc's workspace, but has an ACTIVE commenter doc_members row.
    const db = fakeDb({
      docRows: [{ generalAccess: "anyone_in_workspace", ownerId: null }],
      memberRows: [{ role: "commenter" }],
      linkRows: [{ role: "viewer" }],
    });
    const gate = buildGate(db, { isOwner: async () => false, isWorkspaceMember: () => false });
    const r = await gate("doc_1", asUser("u_bob"));
    expect(r).toEqual({ role: "commenter", canView: true });
  });

  test("AS-003: workspace member gets the general-access role on anyone_in_workspace (Carol = member, role viewer)", async () => {
    const db = fakeDb({
      docRows: [{ generalAccess: "anyone_in_workspace", ownerId: null }],
      memberRows: [],
      linkRows: [{ role: "viewer" }],
    });
    // Carol is a member of THIS doc's workspace → the anyone_in_workspace link admits her.
    const gate = buildGate(db, { isOwner: async () => false, isWorkspaceMember: (d) => d === "doc_1" });
    const r = await gate("doc_1", asUser("u_carol"));
    expect(r).toEqual({ role: "viewer", canView: true });
  });

  test("AS-004: anyone_with_link visitor incl. signed-out gets the link role (link commenter → anon commenter)", async () => {
    const db = fakeDb({
      docRows: [{ generalAccess: "anyone_with_link", ownerId: null }],
      memberRows: [],
      linkRows: [{ role: "commenter" }],
    });
    const gate = buildGate(db, { isOwner: async () => false, isWorkspaceMember: () => false });
    const r = await gate("doc_1", anon);
    expect(r).toEqual({ role: "commenter", canView: true });
  });

  test("AS-005: cross-workspace member denied a restricted doc that lives elsewhere (Dan ∈ A only, ∉ B, not invited)", async () => {
    // Restricted doc in workspace B; Dan is a member of A only → isWorkspaceMember(doc) false,
    // no invite, no owner → no source admits him.
    const db = fakeDb({ docRows: [{ generalAccess: "restricted", ownerId: null }], memberRows: [], linkRows: [] });
    const gate = buildGate(db, { isOwner: async () => false, isWorkspaceMember: () => false });
    const r = await gate("doc_in_B", asUser("u_dan"));
    expect(r).toEqual({ role: null, canView: false });
  });

  test("AS-006: no matching source → denied (Eve unrelated to a restricted doc)", async () => {
    const db = fakeDb({ docRows: [{ generalAccess: "restricted", ownerId: null }], memberRows: [], linkRows: [] });
    const gate = buildGate(db, { isOwner: async () => false, isWorkspaceMember: () => false });
    const r = await gate("doc_1", asUser("u_eve"));
    expect(r).toEqual({ role: null, canView: false });
  });

  test("AS-008 / C-011: a project-less doc grants nothing via anyone_in_workspace (fail-closed)", async () => {
    // project_id null → the doc has no workspace, so isWorkspaceMember resolves false for it.
    // anyone_in_workspace therefore admits no one via the workspace path; only owner/invited/link.
    const db = fakeDb({
      docRows: [{ generalAccess: "anyone_in_workspace", ownerId: null }],
      memberRows: [],
      linkRows: [{ role: "viewer" }],
    });
    // A workspace member of SOME workspace, but the doc has no workspace → membership-of-doc false.
    const gate = buildGate(db, { isOwner: async () => false, isWorkspaceMember: async () => false });
    const r = await gate("doc_noproject", asUser("u_member"));
    expect(r).toEqual({ role: null, canView: false });
  });

  // ── C-003 most-permissive + anon edge behaviour ──

  test("C-003: most-permissive wins — owner folds over a lesser invited role", async () => {
    // Same doc, user is BOTH an invited commenter AND the owner → owner (highest) wins.
    const db = fakeDb({
      docRows: [{ generalAccess: "restricted", ownerId: "u_a" }],
      memberRows: [{ role: "commenter" }],
      linkRows: [],
    });
    const gate = buildGate(db, { isOwner: async (_d, u) => u === "u_a", isWorkspaceMember: () => false });
    expect(await gate("doc_1", asUser("u_a"))).toEqual({ role: "owner", canView: true });
  });

  test("C-003 edge: anon denied on restricted / anyone_in_workspace (only anyone_with_link admits anon)", async () => {
    const restricted = fakeDb({ docRows: [{ generalAccess: "restricted", ownerId: null }], linkRows: [{ role: "viewer" }] });
    const inWs = fakeDb({ docRows: [{ generalAccess: "anyone_in_workspace", ownerId: null }], linkRows: [{ role: "viewer" }] });
    const gateR = buildGate(restricted, { isOwner: async () => false, isWorkspaceMember: () => false });
    const gateW = buildGate(inWs, { isOwner: async () => false, isWorkspaceMember: () => false });
    expect(await gateR("doc_r", anon)).toEqual({ role: null, canView: false });
    expect(await gateW("doc_w", anon)).toEqual({ role: null, canView: false });
  });

  test("AS-010 edge: anon on anyone_with_link with NO link role row still views, defaulting to viewer", async () => {
    // general_access = anyone_with_link IS the grant; absent an explicit link-role row the
    // anon admits at least-privilege `viewer` (admitting, NOT failing closed) — matching
    // "anyone with the link can view".
    const db = fakeDb({ docRows: [{ generalAccess: "anyone_with_link", ownerId: null }], linkRows: [] });
    const gate = buildGate(db, { isOwner: async () => false, isWorkspaceMember: () => false });
    expect(await gate("doc_1", anon)).toEqual({ role: "viewer", canView: true });
  });

  test("C-003 edge: anon on a MISSING doc → denied (no leak, no throw)", async () => {
    const db = fakeDb({ docRows: [], linkRows: [] });
    const gate = buildGate(db, { isOwner: async () => false, isWorkspaceMember: () => false });
    expect(await gate("ghost", anon)).toEqual({ role: null, canView: false });
  });
});
