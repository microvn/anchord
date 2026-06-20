import { test, expect } from "bun:test";
import {
  setGeneralAccess,
  ShareRejected,
  type ShareRepo,
  type ResolvedShareSetting,
  type GeneralAccessLevel,
  type ShareRole,
} from "./share";

// Sharing S-001: an owner sets general-access level + anyone-with-link role.
//
// UNIT tests of the role validation + the owner-only editors_can_share guard (C-015)
// against an in-memory fake ShareRepo (mirrors publish's fakeRepo + version's
// VersionRepo pattern). They assert the SETTING is persisted correctly (level + role).
// The actual "outsider gets commenter access" / "stranger denied" ENFORCEMENT is S-005's
// role logic + the /d/:slug gate (integration) — NOT asserted here. The real Drizzle
// upsert (docs.general_access + the unique-docId share_links row in one transaction) is
// integration-verified-later.
//
// NOTE (sharing reversal 2026-06-20): there is NO guest-commenting toggle. A commenter+
// link role IS the grant for guests (Google-Docs model), so the old AS-003/C-003
// guest-on-restricted guard is GONE — `setGeneralAccess` no longer takes guestCommenting.

// In-memory fake: one share_links-style row per doc (keyed on docId — enforces the
// C-001 single-config invariant) + the doc's general_access level. Exposes ONLY
// the setGeneralAccess upsert the port needs. The link controls (S-004) are not
// modeled here — this is S-001's surface.
function fakeRepo() {
  const rows = new Map<string, ResolvedShareSetting>();
  const repo: ShareRepo = {
    async setGeneralAccess(docId, setting) {
      // Upsert on docId (C-001: never a second row for the same doc). editors_can_share
      // is left untouched when omitted: keep the prior value, defaulting to true (the
      // column default) for a first set — mirrors the real repo's upsert semantics.
      const prior = rows.get(docId);
      const editorsCanShare =
        setting.editorsCanShare ?? prior?.editorsCanShare ?? true;
      const resolved: ResolvedShareSetting = { docId, ...setting, editorsCanShare };
      rows.set(docId, resolved);
      return resolved;
    },
  };
  return { repo, rows };
}

test("AS-001: set anyone-with-link + commenter saves the setting (level + role)", async () => {
  const f = fakeRepo();

  const out = await setGeneralAccess(
    "doc-1",
    { level: "anyone_with_link", role: "commenter" },
    f.repo,
  );

  // The SETTING is what S-001 owns; outsider→commenter enforcement is S-005/integration.
  expect(out.level).toBe("anyone_with_link");
  expect(out.role).toBe("commenter");
  expect(f.rows.get("doc-1")).toEqual({
    docId: "doc-1",
    level: "anyone_with_link",
    role: "commenter",
    editorsCanShare: true, // default on (C-015) when not set
  });
});

test("AS-002: set restricted persists restricted level (invitees-only; link-not-invited denied is S-005)", async () => {
  const f = fakeRepo();

  const out = await setGeneralAccess("doc-1", { level: "restricted", role: "viewer" }, f.repo);

  expect(out.level).toBe("restricted");
  expect(out.role).toBe("viewer");
  // Enforcement that an uninvited link-holder is denied lives in S-005 + the
  // /d/:slug gate (integration). Here we assert only that the level is saved.
  expect(f.rows.get("doc-1")?.level).toBe("restricted");
});

test("AS-001 (reversal 2026-06-20): a commenter+ link role is the grant for guests — NO separate guest-commenting toggle is accepted", async () => {
  const f = fakeRepo();

  // The setting no longer carries any guest field; setting anyone_with_link + commenter is
  // the entire guest grant. (TypeScript would reject a `guestCommenting` field at compile
  // time — the toggle no longer exists on GeneralAccessInput.)
  const out = await setGeneralAccess(
    "doc-1",
    { level: "anyone_with_link", role: "commenter" },
    f.repo,
  );
  expect(out.role).toBe("commenter");
  expect(out).not.toHaveProperty("guestCommenting");
  expect(f.rows.get("doc-1")).not.toHaveProperty("guestCommenting");
});

test("C-001: one general-access config per doc — re-setting upserts the same row, link controls independent", async () => {
  const f = fakeRepo();

  await setGeneralAccess("doc-1", { level: "restricted", role: "viewer" }, f.repo);
  await setGeneralAccess("doc-1", { level: "anyone_with_link", role: "editor" }, f.repo);

  // Still exactly one config for the doc (upsert, not a second row) — the unique
  // docId invariant. Latest write wins.
  expect(f.rows.size).toBe(1);
  expect(f.rows.get("doc-1")).toEqual({
    docId: "doc-1",
    level: "anyone_with_link",
    role: "editor",
    editorsCanShare: true,
  });
  // Link controls (password/expiry/view-limit, S-004) attach to this same row but
  // are independent of the general-access setting — S-001 neither sets nor reads
  // them, so setting general-access never mutates them.
});

test("AS-018 / C-012: an invalid general-access role (owner) is rejected — only viewer|commenter|editor", async () => {
  const f = fakeRepo();

  await expect(
    setGeneralAccess(
      "doc-1",
      // owner is conferred by ownership, never by a link → invalid as a link role.
      { level: "anyone_with_link", role: "owner" as unknown as ShareRole },
      f.repo,
    ),
  ).rejects.toThrow(ShareRejected);
  expect(f.rows.has("doc-1")).toBe(false);

  // Boundary: each valid role is accepted.
  for (const role of ["viewer", "commenter", "editor"] as ShareRole[]) {
    const out = await setGeneralAccess(
      "doc-r",
      { level: "anyone_with_link" as GeneralAccessLevel, role },
      f.repo,
    );
    expect(out.role).toBe(role);
  }
});

test("AS-022 / C-015: only the owner may change editors_can_share; a non-owner attempt is rejected and nothing persists", async () => {
  const f = fakeRepo();

  // A non-owner (the default ctx) carrying editorsCanShare → rejected before the write.
  await expect(
    setGeneralAccess(
      "doc-1",
      { level: "anyone_with_link", role: "commenter", editorsCanShare: false },
      f.repo,
    ),
  ).rejects.toThrow(ShareRejected);
  expect(f.rows.has("doc-1")).toBe(false);

  // Same, explicit non-owner ctx → same rejection (code is toggle_owner_only).
  await expect(
    setGeneralAccess(
      "doc-1",
      { level: "anyone_with_link", role: "commenter", editorsCanShare: true },
      f.repo,
      { actorIsOwner: false },
    ),
  ).rejects.toMatchObject({ code: "toggle_owner_only" });

  // The OWNER may turn the toggle off — accepted and persisted (AS-022).
  const off = await setGeneralAccess(
    "doc-1",
    { level: "anyone_with_link", role: "commenter", editorsCanShare: false },
    f.repo,
    { actorIsOwner: true },
  );
  expect(off.editorsCanShare).toBe(false);
  expect(f.rows.get("doc-1")?.editorsCanShare).toBe(false);
});

test("C-015: an editor's normal manage-sharing write (no toggle) leaves editors_can_share untouched", async () => {
  const f = fakeRepo();

  // Owner first turns the toggle OFF.
  await setGeneralAccess(
    "doc-1",
    { level: "anyone_with_link", role: "viewer", editorsCanShare: false },
    f.repo,
    { actorIsOwner: true },
  );

  // A subsequent write WITHOUT editorsCanShare (the editor path) must not flip it back —
  // omitting the toggle preserves the stored value (here: still off).
  const out = await setGeneralAccess(
    "doc-1",
    { level: "anyone_with_link", role: "editor" },
    f.repo,
  );
  expect(out.editorsCanShare).toBe(false);
  expect(f.rows.get("doc-1")?.editorsCanShare).toBe(false);
});
