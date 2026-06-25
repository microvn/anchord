import { test, expect } from "bun:test";
import {
  setGeneralAccess,
  ShareRejected,
  deriveLevel,
  type ShareRepo,
  type ResolvedShareSetting,
  type ShareRole,
  type AxisRole,
} from "./share";

// doc-access-two-axis S-001: someone who can manage sharing sets a doc's access as TWO
// INDEPENDENT axes — workspace_role + link_role — each a share role or off (null). The two
// are independent (C-001); the legacy single level is gone (DERIVED via deriveLevel).
//
// UNIT tests of the per-axis validation + independence + the column-scoped write contract,
// against an in-memory fake ShareRepo. The "members can comment / outsider denied" ENFORCEMENT
// is S-003's role logic + the access gate (integration); here we own that the SETTING persists
// on both axes independently, that an invalid axis value rejects, and that a per-axis write
// does not clobber the other axis (AS-007).

// In-memory fake: one share_links-style row per doc keyed on docId (C-001 single-config).
// PARTIAL-UPDATE (C-011): each call writes ONLY the axes it is GIVEN — an axis the caller
// omits (`undefined`) is LEFT AT ITS CURRENT VALUE by MERGING over the prior row (mirrors a
// column-scoped UPDATE that omits the column from the `set`). On first insert an omitted
// axis falls back to its default (workspace_role=commenter, link_role=null). This is what
// makes the AS-007 no-clobber test exercise real partial semantics rather than a vacuous
// read-back.
function fakeRepo() {
  const rows = new Map<string, ResolvedShareSetting>();
  const repo: ShareRepo = {
    async setGeneralAccess(docId, setting) {
      const prior = rows.get(docId);
      const editorsCanShare = setting.editorsCanShare ?? prior?.editorsCanShare ?? true;
      // Present → write it; absent → keep the prior column value, or the INSERT default.
      const workspaceRole =
        setting.workspaceRole !== undefined
          ? setting.workspaceRole
          : prior?.workspaceRole ?? "commenter";
      const linkRole =
        setting.linkRole !== undefined ? setting.linkRole : prior?.linkRole ?? null;
      const resolved: ResolvedShareSetting = {
        docId,
        workspaceRole,
        linkRole,
        level: deriveLevel(workspaceRole, linkRole),
        editorsCanShare,
        capabilityToken: linkRole != null ? "cap-token" : null,
      };
      rows.set(docId, resolved);
      return resolved;
    },
  };
  return { repo, rows };
}

test("AS-001: workspace=commenter, link off → both axes saved (members comment, outsider deny is S-003)", async () => {
  const f = fakeRepo();

  const out = await setGeneralAccess(
    "doc-1",
    { workspaceRole: "commenter", linkRole: null },
    f.repo,
  );

  // The SETTING is what S-001 owns; member-grant / outsider-deny enforcement is S-003/integration.
  expect(out.workspaceRole).toBe("commenter");
  expect(out.linkRole).toBeNull();
  // Derived legacy summary: workspace on, link off → anyone_in_workspace.
  expect(out.level).toBe("anyone_in_workspace");
  // No public link (link axis off) → no capability token.
  expect(out.capabilityToken).toBeNull();
  expect(f.rows.get("doc-1")).toMatchObject({ workspaceRole: "commenter", linkRole: null });
});

test("AS-002: turning link on at viewer does NOT demote workspace commenter members (independent axes)", async () => {
  const f = fakeRepo();

  // Workspace at commenter first.
  await setGeneralAccess("doc-1", { workspaceRole: "commenter", linkRole: null }, f.repo);
  // Now turn the link on at the LOWER (viewer) level.
  const out = await setGeneralAccess("doc-1", { workspaceRole: "commenter", linkRole: "viewer" }, f.repo);

  // Workspace members still hold commenter; link openers get only viewer — independent.
  expect(out.workspaceRole).toBe("commenter");
  expect(out.linkRole).toBe("viewer");
  // The lower link role did NOT pull the workspace axis down.
  expect(f.rows.get("doc-1")?.workspaceRole).toBe("commenter");
  // Link on → derived anyone_with_link + a capability token exists.
  expect(out.level).toBe("anyone_with_link");
  expect(out.capabilityToken).toBe("cap-token");
});

test("AS-003: turning workspace off + link viewer → out of workspace while link views (independent)", async () => {
  const f = fakeRepo();

  // Start workspace=commenter, link off.
  await setGeneralAccess("doc-1", { workspaceRole: "commenter", linkRole: null }, f.repo);
  // Turn workspace OFF and set link=viewer.
  const out = await setGeneralAccess("doc-1", { workspaceRole: null, linkRole: "viewer" }, f.repo);

  expect(out.workspaceRole).toBeNull(); // no longer shared with the workspace
  expect(out.linkRole).toBe("viewer"); // anyone with the link can view
  expect(out.level).toBe("anyone_with_link");
  expect(f.rows.get("doc-1")).toMatchObject({ workspaceRole: null, linkRole: "viewer" });
});

test("AS-004: an invalid role on either axis is rejected; only viewer|commenter|editor|off; state unchanged", async () => {
  const f = fakeRepo();

  // "owner" on the workspace axis → rejected (owner is never assignable, C-009).
  await expect(
    setGeneralAccess(
      "doc-1",
      { workspaceRole: "owner" as unknown as ShareRole, linkRole: null },
      f.repo,
    ),
  ).rejects.toThrow(ShareRejected);
  // "owner" on the link axis → also rejected.
  await expect(
    setGeneralAccess(
      "doc-1",
      { workspaceRole: null, linkRole: "owner" as unknown as ShareRole },
      f.repo,
    ),
  ).rejects.toThrow(ShareRejected);
  // An arbitrary invalid value → rejected too.
  await expect(
    setGeneralAccess(
      "doc-1",
      { workspaceRole: "manager" as unknown as ShareRole, linkRole: null },
      f.repo,
    ),
  ).rejects.toMatchObject({ code: "invalid_role" });
  // Nothing persisted — the stored access is unchanged (no row was ever written).
  expect(f.rows.has("doc-1")).toBe(false);

  // Boundary: each valid value (viewer|commenter|editor|null) is accepted on each axis.
  const valid: AxisRole[] = ["viewer", "commenter", "editor", null];
  for (const ws of valid) {
    for (const link of valid) {
      const out = await setGeneralAccess("doc-ok", { workspaceRole: ws, linkRole: link }, f.repo);
      expect(out.workspaceRole).toBe(ws);
      expect(out.linkRole).toBe(link);
    }
  }
});

test("AS-007 / C-011: two managers editing DIFFERENT axes do not clobber each other (genuine stale single-axis writes)", async () => {
  // Start state: workspace=commenter, link=viewer.
  const f = fakeRepo();
  await setGeneralAccess("doc-1", { workspaceRole: "commenter", linkRole: "viewer" }, f.repo);

  // Manager A updates ONLY the workspace axis → editor. The link axis is ABSENT (A neither
  // knows nor cares about it) — a true single-axis edit, not a re-send of the whole row.
  await setGeneralAccess("doc-1", { workspaceRole: "editor" }, f.repo);

  // Manager B holds a STALE snapshot (workspace was commenter when they opened the dialog)
  // and turns the LINK axis OFF. B sends ONLY linkRole=null — workspace is ABSENT. The
  // partial write must touch only the link column, so B's stale view CANNOT revert A's
  // concurrent workspace change.
  const out = await setGeneralAccess("doc-1", { linkRole: null }, f.repo);

  // Final state proves no-clobber in BOTH directions:
  //  - workspace=editor → A's change survived B's stale write,
  //  - link=null        → B's change applied and did NOT revert A.
  expect(out.workspaceRole).toBe("editor");
  expect(out.linkRole).toBeNull();
  expect(f.rows.get("doc-1")).toMatchObject({ workspaceRole: "editor", linkRole: null });
});

test("AS-007 / C-011: a single-axis write leaves the OTHER axis untouched (both directions)", async () => {
  // Seed: workspace=commenter, link=viewer.
  const f = fakeRepo();
  await setGeneralAccess("doc-1", { workspaceRole: "commenter", linkRole: "viewer" }, f.repo);

  // Setting ONLY linkRole leaves workspace_role untouched.
  const afterLink = await setGeneralAccess("doc-1", { linkRole: "editor" }, f.repo);
  expect(afterLink.workspaceRole).toBe("commenter"); // untouched
  expect(afterLink.linkRole).toBe("editor");

  // Setting ONLY workspaceRole leaves link_role untouched (still editor from above).
  const afterWs = await setGeneralAccess("doc-1", { workspaceRole: "viewer" }, f.repo);
  expect(afterWs.workspaceRole).toBe("viewer");
  expect(afterWs.linkRole).toBe("editor"); // untouched
});

test("C-001: one config per doc — re-setting upserts the same row; axes written independently", async () => {
  const f = fakeRepo();

  await setGeneralAccess("doc-1", { workspaceRole: null, linkRole: null }, f.repo);
  await setGeneralAccess("doc-1", { workspaceRole: "commenter", linkRole: "editor" }, f.repo);

  // Still exactly one config for the doc (upsert, not a second row) — latest write wins.
  expect(f.rows.size).toBe(1);
  expect(f.rows.get("doc-1")).toMatchObject({ workspaceRole: "commenter", linkRole: "editor" });
});

test("C-009: each axis is viewer|commenter|editor or off; null (off) is accepted, owner never is", async () => {
  const f = fakeRepo();
  // Both axes off (null) → restricted, accepted.
  const off = await setGeneralAccess("doc-1", { workspaceRole: null, linkRole: null }, f.repo);
  expect(off.level).toBe("restricted");
  // owner on either axis → rejected (covered in AS-004); re-assert the code here.
  await expect(
    setGeneralAccess("doc-2", { workspaceRole: "owner" as unknown as ShareRole, linkRole: null }, f.repo),
  ).rejects.toMatchObject({ code: "invalid_role" });
});

test("AS-022 / C-015: only the owner may change editors_can_share; a non-owner attempt rejects and nothing persists", async () => {
  const f = fakeRepo();

  await expect(
    setGeneralAccess(
      "doc-1",
      { workspaceRole: "commenter", linkRole: null, editorsCanShare: false },
      f.repo,
    ),
  ).rejects.toMatchObject({ code: "toggle_owner_only" });
  expect(f.rows.has("doc-1")).toBe(false);

  // The OWNER may turn the toggle off — accepted and persisted.
  const off = await setGeneralAccess(
    "doc-1",
    { workspaceRole: "commenter", linkRole: null, editorsCanShare: false },
    f.repo,
    { actorIsOwner: true },
  );
  expect(off.editorsCanShare).toBe(false);
});

test("deriveLevel: the three mappings (restricted / anyone_in_workspace / anyone_with_link)", () => {
  expect(deriveLevel(null, null)).toBe("restricted");
  expect(deriveLevel("commenter", null)).toBe("anyone_in_workspace");
  expect(deriveLevel("editor", null)).toBe("anyone_in_workspace");
  // Any link_role (regardless of the workspace axis) → anyone_with_link (the link axis dominates).
  expect(deriveLevel(null, "viewer")).toBe("anyone_with_link");
  expect(deriveLevel("commenter", "viewer")).toBe("anyone_with_link");
});
