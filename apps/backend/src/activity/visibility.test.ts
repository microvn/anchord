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
import { createActivityVisibility, type ResolveDocAccess } from "./visibility";

type Row = { id: string; docId: string | null };

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
});
