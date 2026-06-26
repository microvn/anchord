// Unit tests for the ONE shared activity visibility gate (workspace-activity S-002 / C-003 + C-008).
//
// This is the highest-correctness-risk piece: a single helper that BOTH the feed-list and the
// detail-url route through (and that S-003 counts / S-007 stats will reuse), so a leak here exposes
// content from docs a member can't open. The tests pin the rule per AS atom and prove the gate is
// the single source of the decision (feed `filterVisible` and detail `canSee` give the SAME answer).
//
// resolveAccess is injected as a fake here (the gate must NOT re-derive access — it calls the doc
// viewer's resolver, C-003); the live resolveAccess wiring is the route's concern + integration.

import { describe, expect, test } from "bun:test";
import {
  createActivityVisibility,
  type ResolveDocAccess,
  type ResolveLiveRole,
  type ResolveProjectVisibility,
} from "./visibility";
import type { ActivityType } from "./types";

type Row = {
  id: string;
  docId: string | null;
  projectId?: string | null;
  type?: ActivityType;
  actorUserId?: string | null;
};

const ADMIN = { userId: "u-mara", role: "admin" as const };
const MEMBER = { userId: "u-tom", role: "member" as const };

// A resolveAccess fake: `accessible` is the set of docIds the (sole) member can open RIGHT NOW.
// Reading it on every call models READ-TIME resolution (F-2) — flip the set and the answer changes.
function fakeResolveAccess(accessible: Set<string>): ResolveDocAccess & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (docId: string) => {
    calls.push(docId);
    return accessible.has(docId) ? { role: "viewer" as const, canView: true } : { role: null, canView: false };
  }) as unknown as ResolveDocAccess & { calls: string[] };
  fn.calls = calls;
  return fn;
}

// "Secret roadmap" = d-secret (restricted, Tom not invited); "Render pipeline RFC" = d-rfc
// (anyone_in_workspace, Tom can open); a workspace-level member-joined event has docId null.
const ROWS: Row[] = [
  { id: "e-secret", docId: "d-secret" },
  { id: "e-rfc", docId: "d-rfc" },
  { id: "e-join", docId: null },
];

describe("activity visibility gate (workspace-activity S-002)", () => {
  test("AS-007: an admin sees an event on a doc they don't directly share", async () => {
    // Admin: resolveAccess is NEVER consulted — admins see ALL workspace events.
    const resolveAccess = fakeResolveAccess(new Set()); // empty: admin still sees everything
    const v = createActivityVisibility({ resolveAccess });
    const visible = await v.filterVisible(ROWS, ADMIN);
    expect(visible.map((r) => r.id)).toEqual(["e-secret", "e-rfc", "e-join"]);
    expect(await v.canSee({ docId: "d-secret" }, ADMIN)).toBe(true);
    expect(resolveAccess.calls).toEqual([]); // admin short-circuits the per-doc resolve
  });

  test("AS-008: a member does NOT see an event on a restricted doc with no grant", async () => {
    // Tom can open d-rfc only; d-secret (restricted, no grant) resolves canView:false.
    const v = createActivityVisibility({ resolveAccess: fakeResolveAccess(new Set(["d-rfc"])) });
    const visible = await v.filterVisible(ROWS, MEMBER);
    expect(visible.map((r) => r.id)).not.toContain("e-secret"); // the restricted doc's event is gone
    expect(await v.canSee({ docId: "d-secret" }, MEMBER)).toBe(false);
  });

  test("AS-029: a member SEES an event on an anyone_in_workspace doc they can open", async () => {
    const v = createActivityVisibility({ resolveAccess: fakeResolveAccess(new Set(["d-rfc"])) });
    const visible = await v.filterVisible(ROWS, MEMBER);
    expect(visible.map((r) => r.id)).toContain("e-rfc"); // membership grants the anyone_in_workspace doc
    expect(await v.canSee({ docId: "d-rfc" }, MEMBER)).toBe(true);
  });

  test("AS-009: a member sees a workspace-level event (docId null) regardless of doc access", async () => {
    // resolveAccess grants NOTHING — the docId-null row is still visible (it has no doc to gate on).
    const resolveAccess = fakeResolveAccess(new Set());
    const v = createActivityVisibility({ resolveAccess });
    const visible = await v.filterVisible(ROWS, MEMBER);
    expect(visible.map((r) => r.id)).toContain("e-join");
    expect(await v.canSee({ docId: null }, MEMBER)).toBe(true);
    expect(resolveAccess.calls).not.toContain(null as unknown as string); // never resolves a null docId
  });

  test("AS-030: access resolved at READ time — tightening a doc hides its event on the next read (F-2)", async () => {
    // d-roadmap starts accessible (Tom can see its event), then is flipped to restricted.
    const accessible = new Set<string>(["d-roadmap"]);
    const v = createActivityVisibility({ resolveAccess: fakeResolveAccess(accessible) });
    const rows: Row[] = [{ id: "e-roadmap", docId: "d-roadmap" }];

    expect((await v.filterVisible(rows, MEMBER)).map((r) => r.id)).toEqual(["e-roadmap"]);
    expect(await v.canSee({ docId: "d-roadmap" }, MEMBER)).toBe(true);

    accessible.delete("d-roadmap"); // doc set restricted, Tom not invited — current access tightened
    expect(await v.filterVisible(rows, MEMBER)).toEqual([]); // dropped from the feed at read time
    expect(await v.canSee({ docId: "d-roadmap" }, MEMBER)).toBe(false); // detail now hidden too
  });

  test("C-003: the feed-list and the detail-url route through ONE gate — same visibility, no second filter", async () => {
    // The invariant: for every row, the feed's filterVisible decision and the detail's canSee
    // decision MUST agree (they are the same helper — never two hand-written filters). A row is in
    // the filtered feed IFF canSee returns true for it.
    const v = createActivityVisibility({ resolveAccess: fakeResolveAccess(new Set(["d-rfc"])) });
    const visible = await v.filterVisible(ROWS, MEMBER);
    const visibleIds = new Set(visible.map((r) => r.id));
    for (const row of ROWS) {
      expect(await v.canSee(row, MEMBER)).toBe(visibleIds.has(row.id));
    }
  });

  test("C-008: the doc gate is resolveAccess (anchored to the doc's OWN workspace), not the row's", async () => {
    // The gate decides a doc-scoped row PURELY via resolveAccess(docId) — it passes only the docId,
    // so the access check is anchored to the doc's real workspace (resolveAccess resolves membership
    // there). A row whose stored workspaceId disagrees with the doc's real workspace can't surface:
    // an inaccessible doc is hidden no matter what workspace the row claims.
    const resolveAccess = fakeResolveAccess(new Set()); // member can open NO doc
    const v = createActivityVisibility({ resolveAccess });
    const crossWsRow: Row = { id: "e-foreign", docId: "d-foreign" };
    expect(await v.canSee(crossWsRow, MEMBER)).toBe(false);
    expect(resolveAccess.calls).toEqual(["d-foreign"]); // gated by the DOC, via resolveAccess
  });

  test("C-003: resolveAccess is consulted once per DISTINCT docId per feed pass (not once per row)", async () => {
    const resolveAccess = fakeResolveAccess(new Set(["d-a"]));
    const v = createActivityVisibility({ resolveAccess });
    const rows: Row[] = [
      { id: "1", docId: "d-a" },
      { id: "2", docId: "d-a" },
      { id: "3", docId: "d-b" },
    ];
    await v.filterVisible(rows, MEMBER);
    expect(resolveAccess.calls.sort()).toEqual(["d-a", "d-b"]); // d-a resolved once, cached
  });

  // ── doc-delete-trash S-006 / C-010: doc_deleted / doc_restored visibility ──────────────────────
  // A `resolveLiveRole` fake: `holders` maps docId → the set of userIds who held a role at delete
  // time (survives the tombstone). The deleted-aware resolveAccess returns canView:false for ALL
  // (the doc is deleted), modelling S-004 — so the lifecycle rule MUST come off resolveLiveRole.
  function fakeResolveLiveRole(holders: Record<string, Set<string>>): ResolveLiveRole & { calls: string[] } {
    const calls: string[] = [];
    const fn = (async (docId: string, userId: string) => {
      calls.push(docId);
      return holders[docId]?.has(userId) ? ("editor" as const) : null;
    }) as unknown as ResolveLiveRole & { calls: string[] };
    fn.calls = calls;
    return fn;
  }

  const PRIOR_EDITOR = { userId: "u-lan", role: "member" as const };
  const NEVER = { userId: "u-stranger", role: "member" as const };
  const ACTOR = { userId: "u-mai", role: "member" as const };

  test("AS-032: a member without prior access does NOT see a doc_deleted row (doc tombstoned → resolveAccess hides everyone)", async () => {
    // The doc is deleted, so resolveAccess says canView:false for everyone; only resolveLiveRole
    // knows who held a role. u-stranger never held one → the doc_deleted row is hidden from them.
    const resolveAccess = fakeResolveAccess(new Set()); // deleted: nobody passes the deleted-aware gate
    const resolveLiveRole = fakeResolveLiveRole({ "d-gone": new Set(["u-lan", "u-mai"]) });
    const v = createActivityVisibility({ resolveAccess, resolveLiveRole });
    const row: Row = { id: "e-del", docId: "d-gone", type: "doc_deleted", actorUserId: "u-mai" };
    expect(await v.filterVisible([row], NEVER)).toEqual([]);
    expect(await v.canSee(row, NEVER)).toBe(false);
  });

  test("AS-032: a workspace admin sees the doc_deleted row even with no per-doc role", async () => {
    // Admin short-circuits BOTH resolvers (sees every workspace event), so a tombstoned doc's
    // lifecycle row is still visible — and neither resolver is consulted.
    const resolveAccess = fakeResolveAccess(new Set());
    const resolveLiveRole = fakeResolveLiveRole({});
    const v = createActivityVisibility({ resolveAccess, resolveLiveRole });
    const row: Row = { id: "e-del", docId: "d-gone", type: "doc_deleted", actorUserId: "u-mai" };
    expect((await v.filterVisible([row], ADMIN)).map((r) => r.id)).toEqual(["e-del"]);
    expect(await v.canSee(row, ADMIN)).toBe(true);
    expect(resolveLiveRole.calls).toEqual([]); // admin never resolves per-doc
  });

  test("AS-032: a member who HELD a role before delete still sees the doc_deleted row", async () => {
    // u-lan held editor at delete time (resolveLiveRole returns a role) — so the lifecycle row stays
    // visible to her even though resolveAccess (deleted-aware) refuses her now.
    const resolveAccess = fakeResolveAccess(new Set()); // deleted: deleted-aware gate refuses everyone
    const resolveLiveRole = fakeResolveLiveRole({ "d-gone": new Set(["u-lan", "u-mai"]) });
    const v = createActivityVisibility({ resolveAccess, resolveLiveRole });
    const row: Row = { id: "e-del", docId: "d-gone", type: "doc_deleted", actorUserId: "u-mai" };
    expect((await v.filterVisible([row], PRIOR_EDITOR)).map((r) => r.id)).toEqual(["e-del"]);
    expect(await v.canSee(row, PRIOR_EDITOR)).toBe(true);
  });

  test("C-010: the deleting ACTOR always sees their own doc_restored row (even with no surviving grant)", async () => {
    // The actor of a delete/restore always sees their own lifecycle row — resolveLiveRole isn't even
    // consulted for the actor arm. Covers doc_restored symmetrically with doc_deleted.
    const resolveAccess = fakeResolveAccess(new Set());
    const resolveLiveRole = fakeResolveLiveRole({}); // actor holds no surviving grant
    const v = createActivityVisibility({ resolveAccess, resolveLiveRole });
    const row: Row = { id: "e-res", docId: "d-gone", type: "doc_restored", actorUserId: "u-mai" };
    expect((await v.filterVisible([row], ACTOR)).map((r) => r.id)).toEqual(["e-res"]);
    expect(await v.canSee(row, ACTOR)).toBe(true);
  });

  test("C-010: a NON-lifecycle doc-scoped row on the same (deleted) doc stays on the deleted-aware resolveAccess path", async () => {
    // A normal doc-scoped row (e.g. a `comment`) is NOT a lifecycle event, so it must still hide once
    // the doc is deleted (resolveAccess canView:false) — only doc_deleted/doc_restored get the
    // prior-role-holder exception. This proves the special-case is scoped to the two lifecycle types.
    const resolveAccess = fakeResolveAccess(new Set()); // deleted doc → canView:false
    const resolveLiveRole = fakeResolveLiveRole({ "d-gone": new Set(["u-lan"]) });
    const v = createActivityVisibility({ resolveAccess, resolveLiveRole });
    const commentRow: Row = { id: "e-cmt", docId: "d-gone", type: "comment", actorUserId: "u-mai" };
    expect(await v.canSee(commentRow, PRIOR_EDITOR)).toBe(false); // not a lifecycle row → still hidden
    expect(resolveLiveRole.calls).toEqual([]); // the live resolver is NOT used for non-lifecycle rows
  });

  // ── project-visibility S-006 / C-010: PROJECT-LEVEL event gating by project visibility ──────────
  // A `resolveProjectVisibility` fake: `projects` maps projectId → {isPrivate, ownerId}; an absent
  // id resolves to null (project gone). A project-level row is doc-less with a projectId.
  function fakeResolveProjectVisibility(
    projects: Record<string, { isPrivate: boolean; ownerId: string | null }>,
  ): ResolveProjectVisibility & { calls: string[] } {
    const calls: string[] = [];
    const fn = (async (projectId: string) => {
      calls.push(projectId);
      return projects[projectId] ?? null;
    }) as unknown as ResolveProjectVisibility & { calls: string[] };
    fn.calls = calls;
    return fn;
  }

  // A owns a PRIVATE project p-secret; a PUBLIC project p-open. B is a member, C an admin.
  const OWNER_A = { userId: "u-ann", role: "member" as const };
  const MEMBER_B = { userId: "u-bob", role: "member" as const };
  const ADMIN_C = { userId: "u-cara", role: "admin" as const };
  const PROJECTS = {
    "p-secret": { isPrivate: true, ownerId: "u-ann" },
    "p-open": { isPrivate: false, ownerId: "u-ann" },
  };

  test("AS-024: a project-level event of a PRIVATE project is hidden from a non-owner member AND an admin; the owner sees it", async () => {
    const resolveProjectVisibility = fakeResolveProjectVisibility(PROJECTS);
    const v = createActivityVisibility({ resolveProjectVisibility });
    // A doc-less "project created" row whose subject is A's private project p-secret.
    const row: Row = { id: "e-proj", docId: null, projectId: "p-secret", type: "project", actorUserId: "u-ann" };

    // Owner A sees their own private project's project-level event.
    expect((await v.filterVisible([row], OWNER_A)).map((r) => r.id)).toEqual(["e-proj"]);
    expect(await v.canSee(row, OWNER_A)).toBe(true);

    // A non-owner member B does NOT.
    expect(await v.filterVisible([row], MEMBER_B)).toEqual([]);
    expect(await v.canSee(row, MEMBER_B)).toBe(false);

    // An admin C does NOT either — the admin short-circuit does NOT override C-010 (mirrors C-003).
    expect(await v.filterVisible([row], ADMIN_C)).toEqual([]);
    expect(await v.canSee(row, ADMIN_C)).toBe(false);
  });

  test("AS-024: a project-level event of a PUBLIC project stays visible to a non-owner member and an admin", async () => {
    // The carve-out is for PRIVATE projects only — a public project's project-level event behaves
    // like any workspace-level event (visible to all members + admins).
    const v = createActivityVisibility({ resolveProjectVisibility: fakeResolveProjectVisibility(PROJECTS) });
    const row: Row = { id: "e-open", docId: null, projectId: "p-open", type: "project", actorUserId: "u-ann" };
    expect((await v.filterVisible([row], MEMBER_B)).map((r) => r.id)).toEqual(["e-open"]);
    expect((await v.filterVisible([row], ADMIN_C)).map((r) => r.id)).toEqual(["e-open"]);
    expect(await v.canSee(row, MEMBER_B)).toBe(true);
  });

  test("AS-025: a DOC-level event for an accessible doc still surfaces, even though the doc lives in a private project", async () => {
    // The doc-level event carries BOTH a docId AND a projectId (the private project it lives in). It
    // is NOT project-level (docId is set), so it must stay on the per-doc access path — a member who
    // can open the doc still sees its event, project visibility notwithstanding (soft-private).
    const resolveAccess = fakeResolveAccess(new Set(["d-shared"])); // B can open the shared doc
    const resolveProjectVisibility = fakeResolveProjectVisibility(PROJECTS);
    const v = createActivityVisibility({ resolveAccess, resolveProjectVisibility });
    const docRow: Row = { id: "e-pub", docId: "d-shared", projectId: "p-secret", type: "publish", actorUserId: "u-ann" };

    expect((await v.filterVisible([docRow], MEMBER_B)).map((r) => r.id)).toEqual(["e-pub"]);
    expect(await v.canSee(docRow, MEMBER_B)).toBe(true);
    // The project-visibility resolver is NEVER consulted for a doc-level row — only resolveAccess
    // (called once per filterVisible/canSee pass; each uses its own cache, hence two entries).
    expect(resolveProjectVisibility.calls).toEqual([]);
    expect(resolveAccess.calls.every((d) => d === "d-shared")).toBe(true);
    expect(resolveAccess.calls.length).toBeGreaterThanOrEqual(1);
  });

  test("C-010: a project-level row whose project vanished is hidden from non-owners (safe default)", async () => {
    // resolveProjectVisibility returns null for an unknown project — the gate hides the row rather
    // than leaking it. (Defensive: project hard-delete is out of scope, but a dangling row never leaks.)
    const v = createActivityVisibility({ resolveProjectVisibility: fakeResolveProjectVisibility(PROJECTS) });
    const row: Row = { id: "e-ghost", docId: null, projectId: "p-missing", type: "project" };
    expect(await v.filterVisible([row], MEMBER_B)).toEqual([]);
    expect(await v.filterVisible([row], ADMIN_C)).toEqual([]);
  });

  test("C-010: with NO project-visibility resolver wired, project-level rows fall back to doc-less-visible (backward compatible)", async () => {
    // Pre-S-006 wirings / tests that don't pass resolveProjectVisibility must keep the old behaviour:
    // a doc-less row (even with a projectId) is visible to everyone — no regression.
    const v = createActivityVisibility({});
    const row: Row = { id: "e-legacy", docId: null, projectId: "p-secret", type: "project" };
    expect((await v.filterVisible([row], MEMBER_B)).map((r) => r.id)).toEqual(["e-legacy"]);
    expect((await v.filterVisible([row], ADMIN_C)).map((r) => r.id)).toEqual(["e-legacy"]);
  });
});
