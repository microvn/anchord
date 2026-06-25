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
import { can, type Role } from "./roles";
import { createResolveDocRole, createIsDocDeleted } from "./resolve-doc-role-repo";
import { createResolveAccess } from "./resolve-access";
import { mintAdmissionCookie } from "./capability-cookie";

/** Minimal Drizzle fake: select(...).from(table).where(...).limit?() → seeded rows. */
function fakeDb(seed: {
  docRows?: Array<Record<string, unknown>>;
  memberRows?: Array<{ role: string }>;
  // doc-access-two-axis S-001: the share_links row now carries the two axes. A row whose
  // workspace_role is set models anyone_in_workspace; whose link_role is set models
  // anyone_with_link; both null = restricted (deriveLevel).
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

/** Build resolveAccess on top of the REAL resolveDocRole, with injected ports.
 *  doc-delete-trash S-004 / C-009: the deletion check is now a PORT — wire the REAL
 *  `createIsDocDeleted` over the same fakeDb (it reads the seeded docRows' `deletedAt`),
 *  so the S-004 tests exercise the same mechanism prod uses, not a raw `db.select`. */
function buildGate(
  db: DB,
  ports: { isOwner: (d: string, u: string) => Promise<boolean>; isWorkspaceMember: (d: string, u: string) => boolean | Promise<boolean> },
) {
  const resolveDocRole = createResolveDocRole(db, {
    isOwner: ports.isOwner,
    isWorkspaceMember: ports.isWorkspaceMember,
  });
  return createResolveAccess(db, { resolveDocRole, isDocDeleted: createIsDocDeleted(db) });
}

/** As buildGate, but wires the APP_SECRET so the anon capability-cookie path (S-002/S-003) is
 *  live — without a secret the cookie branch never runs. */
function buildGateWithSecret(
  db: DB,
  secret: string,
  ports: { isOwner: (d: string, u: string) => Promise<boolean>; isWorkspaceMember: (d: string, u: string) => boolean | Promise<boolean> },
) {
  const resolveDocRole = createResolveDocRole(db, {
    isOwner: ports.isOwner,
    isWorkspaceMember: ports.isWorkspaceMember,
  });
  return createResolveAccess(db, { resolveDocRole, secret, isDocDeleted: createIsDocDeleted(db) });
}

const anonWithCookie = (cookie: string): Viewer => ({ kind: "anon", admissionCookie: cookie });

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
      linkRows: [{ workspaceRole: "viewer", linkRole: null }],
    });
    const gate = buildGate(db, { isOwner: async () => false, isWorkspaceMember: () => false });
    const r = await gate("doc_1", asUser("u_bob"));
    expect(r).toEqual({ role: "commenter", canView: true });
  });

  test("AS-003: workspace member gets the general-access role on anyone_in_workspace (Carol = member, role viewer)", async () => {
    const db = fakeDb({
      docRows: [{ generalAccess: "anyone_in_workspace", ownerId: null }],
      memberRows: [],
      linkRows: [{ workspaceRole: "viewer", linkRole: null }],
    });
    // Carol is a member of THIS doc's workspace → the anyone_in_workspace link admits her.
    const gate = buildGate(db, { isOwner: async () => false, isWorkspaceMember: (d) => d === "doc_1" });
    const r = await gate("doc_1", asUser("u_carol"));
    expect(r).toEqual({ role: "viewer", canView: true });
  });

  // REGRESSION (capability-share-link S-003 / C-002, behaviour CHANGED 2026-06-21): this test
  // formerly asserted that an anon with NO cookie was admitted at the link role purely because
  // the doc is anyone_with_link (the old admit-by-slug). S-003 removed that — the readable
  // address is no longer an anon entry point. The boundary is preserved here as the new
  // contract: same anyone_with_link doc + same anon-with-no-cookie now → DENIED.
  test("AS-007 (was S-001 AS-004): anon WITHOUT a cookie on anyone_with_link is no longer admitted by slug", async () => {
    const db = fakeDb({
      docRows: [{ generalAccess: "anyone_with_link", ownerId: null }],
      memberRows: [],
      linkRows: [{ workspaceRole: null, linkRole: "commenter" }],
    });
    const gate = buildGate(db, { isOwner: async () => false, isWorkspaceMember: () => false });
    const r = await gate("doc_1", anon);
    expect(r).toEqual({ role: null, canView: false });
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
      linkRows: [{ workspaceRole: "viewer", linkRole: null }],
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
    const restricted = fakeDb({ docRows: [{ generalAccess: "restricted", ownerId: null }], linkRows: [{ workspaceRole: null, linkRole: null }] });
    const inWs = fakeDb({ docRows: [{ generalAccess: "anyone_in_workspace", ownerId: null }], linkRows: [{ workspaceRole: "viewer", linkRole: null }] });
    const gateR = buildGate(restricted, { isOwner: async () => false, isWorkspaceMember: () => false });
    const gateW = buildGate(inWs, { isOwner: async () => false, isWorkspaceMember: () => false });
    expect(await gateR("doc_r", anon)).toEqual({ role: null, canView: false });
    expect(await gateW("doc_w", anon)).toEqual({ role: null, canView: false });
  });

  // REGRESSION (capability-share-link S-003 / C-002, behaviour CHANGED 2026-06-21): formerly an
  // anon on anyone_with_link with NO link-role row was admitted at least-privilege `viewer`
  // ("anyone with the link can view"). Post-S-003 the link-by-slug admit is gone entirely — with
  // no admission cookie the anon is denied regardless of whether a link-role row exists.
  test("AS-007 edge (was S-001 AS-010): anon WITHOUT a cookie on anyone_with_link, no link row → denied", async () => {
    const db = fakeDb({ docRows: [{ generalAccess: "anyone_with_link", ownerId: null }], linkRows: [] });
    const gate = buildGate(db, { isOwner: async () => false, isWorkspaceMember: () => false });
    expect(await gate("doc_1", anon)).toEqual({ role: null, canView: false });
  });

  test("C-003 edge: anon on a MISSING doc → denied (no leak, no throw)", async () => {
    const db = fakeDb({ docRows: [], linkRows: [] });
    const gate = buildGate(db, { isOwner: async () => false, isWorkspaceMember: () => false });
    expect(await gate("ghost", anon)).toEqual({ role: null, canView: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// capability-share-link S-003 — the readable address stops admitting anonymous
// visitors (C-002 / C-005). The anon-by-slug admit is gone; an anon now needs a
// VALID capability admission cookie (S-002's path) and signed-in members are
// provably untouched.
// ─────────────────────────────────────────────────────────────────────────────
describe("resolveAccess — readable address stops admitting anon (S-003)", () => {
  const SECRET = "test-app-secret-s003";
  const TOKEN = "cap_tok_live_s003"; // the doc's CURRENT capability token.

  test("AS-007 / C-002.b: anon at the readable address (no cookie) on an anyone_with_link doc is NOT admitted", async () => {
    // Given an anyone_with_link doc and an anon who knows /d/<slug> but carries NO admission
    // cookie. When they open the readable address directly → refused (the slug is not an anon
    // entry point any more). Secret is wired, so this proves it's the missing-cookie, not a
    // missing-secret, that denies.
    const db = fakeDb({
      docRows: [{ generalAccess: "anyone_with_link", ownerId: null }],
      memberRows: [],
      linkRows: [{ workspaceRole: null, linkRole: "commenter", capabilityToken: TOKEN }],
    });
    const gate = buildGateWithSecret(db, SECRET, { isOwner: async () => false, isWorkspaceMember: () => false });
    expect(await gate("doc_1", anon)).toEqual({ role: null, canView: false });
  });

  test("AS-007 edge: anon with a GARBAGE/forged cookie (invalid type / not our signature) → denied, no throw", async () => {
    const db = fakeDb({
      docRows: [{ generalAccess: "anyone_with_link", ownerId: null }],
      linkRows: [{ workspaceRole: null, linkRole: "commenter", capabilityToken: TOKEN }],
    });
    const gate = buildGateWithSecret(db, SECRET, { isOwner: async () => false, isWorkspaceMember: () => false });
    // empty string, malformed, and a structurally-plausible-but-unsigned value all → denied.
    expect(await gate("doc_1", anonWithCookie(""))).toEqual({ role: null, canView: false });
    expect(await gate("doc_1", anonWithCookie("not-a-cookie"))).toEqual({ role: null, canView: false });
    expect(await gate("doc_1", anonWithCookie("eyJmb28iOiJiYXIifQ.deadbeef"))).toEqual({ role: null, canView: false });
  });

  test("S-002 kept working: anon with a VALID admission cookie (bound to this doc + current token) is admitted at the cookie's link role", async () => {
    const cookie = mintAdmissionCookie(
      { docId: "doc_1", token: TOKEN, role: "commenter", pwdCleared: true, exp: Date.now() + 60_000 },
      SECRET,
    );
    const db = fakeDb({
      docRows: [{ generalAccess: "anyone_with_link", ownerId: null }],
      linkRows: [{ workspaceRole: null, linkRole: "viewer", capabilityToken: TOKEN }], // link-role row irrelevant — cookie role wins.
    });
    const gate = buildGateWithSecret(db, SECRET, { isOwner: async () => false, isWorkspaceMember: () => false });
    expect(await gate("doc_1", anonWithCookie(cookie))).toEqual({ role: "commenter", canView: true });
  });

  test("AS-007 boundary: a VALID cookie for ANOTHER doc (cross-doc replay) does NOT admit here", async () => {
    // Cookie minted for doc_OTHER, presented against doc_1 → resolveAdmission rejects the
    // docId mismatch (AS-020) → no fallback → denied.
    const cookie = mintAdmissionCookie(
      { docId: "doc_OTHER", token: TOKEN, role: "editor", pwdCleared: true, exp: Date.now() + 60_000 },
      SECRET,
    );
    const db = fakeDb({
      docRows: [{ generalAccess: "anyone_with_link", ownerId: null }],
      linkRows: [{ workspaceRole: null, linkRole: "commenter", capabilityToken: TOKEN }],
    });
    const gate = buildGateWithSecret(db, SECRET, { isOwner: async () => false, isWorkspaceMember: () => false });
    expect(await gate("doc_1", anonWithCookie(cookie))).toEqual({ role: null, canView: false });
  });

  test("AS-007 boundary: a cookie minted from a STALE token (since rotated) does NOT admit", async () => {
    // Cookie bound to an old token; the doc's CURRENT token is different → tokenHash mismatch
    // (AS-021) → denied, no slug fallback.
    const cookie = mintAdmissionCookie(
      { docId: "doc_1", token: "cap_tok_OLD", role: "commenter", pwdCleared: true, exp: Date.now() + 60_000 },
      SECRET,
    );
    const db = fakeDb({
      docRows: [{ generalAccess: "anyone_with_link", ownerId: null }],
      linkRows: [{ workspaceRole: null, linkRole: "commenter", capabilityToken: TOKEN }], // current token rotated.
    });
    const gate = buildGateWithSecret(db, SECRET, { isOwner: async () => false, isWorkspaceMember: () => false });
    expect(await gate("doc_1", anonWithCookie(cookie))).toEqual({ role: null, canView: false });
  });

  test("AS-008 / C-005.a: a signed-in OWNER opens the readable address at owner — unchanged by S-003", async () => {
    // The critical don't-break-it path: the user branch never touches the cookie/slug logic.
    // anyone_with_link doc, link state present, but the owner is admitted via resolveDocRole.
    const db = fakeDb({
      docRows: [{ generalAccess: "anyone_with_link", ownerId: "u_owner" }],
      memberRows: [],
      linkRows: [{ workspaceRole: null, linkRole: "viewer", capabilityToken: TOKEN }],
    });
    const gate = buildGateWithSecret(db, SECRET, { isOwner: async (_d, u) => u === "u_owner", isWorkspaceMember: () => false });
    expect(await gate("doc_1", asUser("u_owner"))).toEqual({ role: "owner", canView: true });
  });

  test("AS-008 / C-005.a: a signed-in INVITED member opens the readable address at their invited role — unchanged", async () => {
    const db = fakeDb({
      docRows: [{ generalAccess: "anyone_with_link", ownerId: null }],
      memberRows: [{ role: "commenter" }], // active invited doc_members row.
      linkRows: [{ workspaceRole: null, linkRole: "viewer", capabilityToken: TOKEN }],
    });
    const gate = buildGateWithSecret(db, SECRET, { isOwner: async () => false, isWorkspaceMember: () => false });
    expect(await gate("doc_1", asUser("u_invited"))).toEqual({ role: "commenter", canView: true });
  });

  test("AS-008 / C-005.a: a signed-in WORKSPACE member opens an anyone_in_workspace doc — unchanged (link state irrelevant)", async () => {
    const db = fakeDb({
      docRows: [{ generalAccess: "anyone_in_workspace", ownerId: null }],
      memberRows: [],
      linkRows: [{ workspaceRole: "viewer", linkRole: null, capabilityToken: TOKEN }],
    });
    const gate = buildGateWithSecret(db, SECRET, { isOwner: async () => false, isWorkspaceMember: (d) => d === "doc_1" });
    expect(await gate("doc_1", asUser("u_member"))).toEqual({ role: "viewer", canView: true });
  });

  // ── S-006 / AS-019 / C-005.b: link controls (expiry / view-limit / password) NEVER gate a
  //    signed-in owner or invited member opening by the readable /d/:slug address. The link
  //    controls live only on the REDEEM path (the anon capability link); the user branch goes
  //    straight to resolveDocRole, which never reads passwordHash / expiresAt / viewLimit.
  //    These seed an EXPIRED + password-protected + view-limit-exhausted link row and prove the
  //    member is admitted at full role regardless.
  test("AS-019 / C-005.b: a signed-in OWNER opens despite an EXPIRED + password + view-limit-exhausted link", async () => {
    const db = fakeDb({
      docRows: [{ generalAccess: "anyone_with_link", ownerId: "u_owner" }],
      memberRows: [],
      // Hostile link state: expired yesterday, password set, view limit already hit.
      linkRows: [
        {
          workspaceRole: null, linkRole: "viewer",
          capabilityToken: TOKEN,
          passwordHash: "$argon2id$dummy",
          expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
          viewLimit: 5,
          viewCount: 5,
        } as Record<string, unknown>,
      ],
    });
    const gate = buildGateWithSecret(db, SECRET, { isOwner: async (_d, u) => u === "u_owner", isWorkspaceMember: () => false });
    // Owner still opens at owner — link controls ignored on the readable address.
    expect(await gate("doc_1", asUser("u_owner"))).toEqual({ role: "owner", canView: true });
  });

  test("AS-019 / C-005.b: a signed-in INVITED member opens at their invited role despite the same hostile link state", async () => {
    const db = fakeDb({
      docRows: [{ generalAccess: "anyone_with_link", ownerId: null }],
      memberRows: [{ role: "commenter" }],
      linkRows: [
        {
          workspaceRole: null, linkRole: "viewer",
          capabilityToken: TOKEN,
          passwordHash: "$argon2id$dummy",
          expiresAt: new Date(Date.now() - 1000),
          viewLimit: 1,
          viewCount: 1,
        } as Record<string, unknown>,
      ],
    });
    const gate = buildGateWithSecret(db, SECRET, { isOwner: async () => false, isWorkspaceMember: () => false });
    expect(await gate("doc_1", asUser("u_invited"))).toEqual({ role: "commenter", canView: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// doc-access-two-axis S-003 (C-004): the GUEST CAP. A no-account guest admitted via the
// link/admission cookie is clamped to commenter at THIS anon seam — editing always
// requires a logged-in account. The clamp lives here so every anon-reachable write
// surface (comment / resolve / version publish) inherits one capped role; no route
// re-implements it. (AS-009, AS-011)
// ─────────────────────────────────────────────────────────────────────────────
describe("resolveAccess — guest cap at the anon seam (S-003 / C-004)", () => {
  const SECRET = "test-app-secret-s003-cap";
  const TOKEN = "cap_tok_cap_s003";

  test("AS-009: a no-account guest on an EDITOR link is capped at commenter (publish denied)", async () => {
    // Given an anyone_with_link doc at link=editor and a guest who redeemed it: the cookie
    // was minted at the link role (editor). When the guest is admitted at the anon seam the
    // role is CLAMPED to commenter — so no write surface ever sees the guest as editor and
    // publishing a version (an `edit` action) is denied. Negating the clamp returns editor → red.
    const cookie = mintAdmissionCookie(
      { docId: "doc_1", token: TOKEN, role: "editor", pwdCleared: true, exp: Date.now() + 60_000 },
      SECRET,
    );
    const db = fakeDb({
      docRows: [{ generalAccess: "anyone_with_link", ownerId: null }],
      linkRows: [{ workspaceRole: null, linkRole: "editor", capabilityToken: TOKEN }],
    });
    const gate = buildGateWithSecret(db, SECRET, { isOwner: async () => false, isWorkspaceMember: () => false });
    const r = await gate("doc_1", anonWithCookie(cookie));
    // Capped: commenter (view + comment + resolve), NEVER editor. canEdit is false at commenter.
    expect(r).toEqual({ role: "commenter", canView: true });
    expect(can(r.role as Role, "edit")).toBe(false); // publish (edit) denied — the C-004 cap holds.
  });

  test("AS-011: a no-account guest on a VIEWER link can view only (comment denied) — clamp does not raise", async () => {
    // Given an anyone_with_link doc at link=viewer and a guest who redeemed it (cookie at
    // viewer): admitted at viewer. The commenter cap is a CEILING, not a floor — it never
    // promotes a viewer to commenter. So the guest may view but the comment action is denied.
    const cookie = mintAdmissionCookie(
      { docId: "doc_1", token: TOKEN, role: "viewer", pwdCleared: true, exp: Date.now() + 60_000 },
      SECRET,
    );
    const db = fakeDb({
      docRows: [{ generalAccess: "anyone_with_link", ownerId: null }],
      linkRows: [{ workspaceRole: null, linkRole: "viewer", capabilityToken: TOKEN }],
    });
    const gate = buildGateWithSecret(db, SECRET, { isOwner: async () => false, isWorkspaceMember: () => false });
    const r = await gate("doc_1", anonWithCookie(cookie));
    expect(r).toEqual({ role: "viewer", canView: true });
    expect(can(r.role as Role, "comment")).toBe(false); // viewer cannot comment.
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// doc-delete-trash S-004 (C-009): the `deleted_at` check lives in THIS single gate. A
// soft-deleted doc is unreadable on EVERY id-keyed read path (canView is always false),
// and the distinct `deleted` reason is gated on PRIOR access so it never becomes a
// slug-enumeration oracle (AS-014/AS-015/AS-028).
// ─────────────────────────────────────────────────────────────────────────────
describe("resolveAccess — soft-deleted doc, the single deletion chokepoint (S-004 / C-009)", () => {
  const SECRET = "test-app-secret-s004";
  const TOKEN = "cap_tok_s004";
  const DELETED_AT = new Date("2026-06-25T00:00:00Z");

  test("AS-014 / C-009: a member who WOULD HAVE had a role on a deleted doc → canView:false + reason 'deleted'", async () => {
    // Owner Mai on a now-deleted doc: resolveLive would admit her at owner, but deleted_at is set →
    // the gate refuses (canView:false) yet surfaces the `deleted` reason so the loader can show the
    // gated notice. Negating the prior-access gate (returning DENIED here) would drop the reason → red.
    const db = fakeDb({
      docRows: [{ generalAccess: "restricted", ownerId: "u_mai", deletedAt: DELETED_AT }],
      memberRows: [],
      linkRows: [],
    });
    const gate = buildGate(db, { isOwner: async (_d, u) => u === "u_mai", isWorkspaceMember: () => false });
    const r = await gate("doc_1", asUser("u_mai"));
    expect(r).toEqual({ role: null, canView: false, reason: "deleted" });
  });

  test("AS-015: a signed-in NON-member on a deleted doc → plain DENIED, NO `deleted` reason (no oracle)", async () => {
    // Stranger with no source of access on the SAME deleted doc: resolveLive denies, so the deletion
    // gate must NOT add the reason — the result is byte-identical to a missing/no-access doc. If the
    // reason leaked here, a stranger could probe which slugs once existed (the enumeration oracle).
    const db = fakeDb({
      docRows: [{ generalAccess: "restricted", ownerId: "u_mai", deletedAt: DELETED_AT }],
      memberRows: [],
      linkRows: [],
    });
    const gate = buildGate(db, { isOwner: async (_d, u) => u === "u_mai", isWorkspaceMember: () => false });
    const r = await gate("doc_1", asUser("u_stranger"));
    expect(r).toEqual({ role: null, canView: false });
    expect(r.reason).toBeUndefined();
  });

  test("AS-015: an anon with NO admission cookie on a deleted doc → plain DENIED, no reason", async () => {
    // The doc was anyone_with_link before delete, but an anon with no cookie was never admitted even
    // when live (S-003) — so they get the plain existence-hiding deny, never the deleted notice.
    const db = fakeDb({
      docRows: [{ generalAccess: "anyone_with_link", ownerId: null, deletedAt: DELETED_AT }],
      memberRows: [],
      linkRows: [{ workspaceRole: null, linkRole: "commenter", capabilityToken: TOKEN }],
    });
    const gate = buildGateWithSecret(db, SECRET, { isOwner: async () => false, isWorkspaceMember: () => false });
    const r = await gate("doc_1", anon);
    expect(r).toEqual({ role: null, canView: false });
    expect(r.reason).toBeUndefined();
  });

  test("AS-014: an anon carrying a VALID admission cookie for the doc → canView:false + reason 'deleted'", async () => {
    // A guest who HAD redeemed a valid capability link (cookie bound to this doc + its token) would
    // have been admitted at commenter when live → on the deleted doc they get the gated notice.
    const cookie = mintAdmissionCookie(
      { docId: "doc_1", token: TOKEN, role: "commenter", pwdCleared: true, exp: Date.now() + 60_000 },
      SECRET,
    );
    const db = fakeDb({
      docRows: [{ generalAccess: "anyone_with_link", ownerId: null, deletedAt: DELETED_AT }],
      linkRows: [{ workspaceRole: null, linkRole: "commenter", capabilityToken: TOKEN }],
    });
    const gate = buildGateWithSecret(db, SECRET, { isOwner: async () => false, isWorkspaceMember: () => false });
    const r = await gate("doc_1", anonWithCookie(cookie));
    expect(r).toEqual({ role: null, canView: false, reason: "deleted" });
  });

  test("AS-028 / C-009: a deleted doc is canView:false even for a prior editor — so version/annotation/diff reads all refuse", async () => {
    // The id-keyed read paths (version content, annotations GET, comment POST, diff) gate ONLY on
    // canView. An editor who held a role pre-delete still gets canView:false here → every one of
    // those paths refuses with no per-route re-derivation. (The reason rides along for the loader,
    // but `can(role, ...)` is moot because role is null and canView is false.)
    const db = fakeDb({
      docRows: [{ generalAccess: "restricted", ownerId: null, deletedAt: DELETED_AT }],
      memberRows: [{ role: "editor" }],
      linkRows: [],
    });
    const gate = buildGate(db, { isOwner: async () => false, isWorkspaceMember: () => false });
    const r = await gate("doc_1", asUser("u_editor"));
    expect(r.canView).toBe(false);
    expect(r.role).toBeNull();
    expect(r.reason).toBe("deleted");
  });

  test("C-009 boundary: an ACTIVE doc (deleted_at null) is unaffected — normal allow, no reason", async () => {
    // Negative control: the same owner on the SAME doc but NOT deleted → the live result is returned
    // verbatim, with no `deleted` reason. Proves the gate only fires on a real tombstone.
    const db = fakeDb({
      docRows: [{ generalAccess: "restricted", ownerId: "u_mai", deletedAt: null }],
      memberRows: [],
      linkRows: [],
    });
    const gate = buildGate(db, { isOwner: async (_d, u) => u === "u_mai", isWorkspaceMember: () => false });
    const r = await gate("doc_1", asUser("u_mai"));
    expect(r).toEqual({ role: "owner", canView: true });
  });
});
