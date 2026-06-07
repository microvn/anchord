import { test, expect } from "bun:test";
import {
  setGeneralAccess,
  ShareRejected,
  type ShareRepo,
  type ResolvedShareSetting,
  type GeneralAccessLevel,
  type ShareRole,
} from "./share";

// Sharing S-001: an owner sets general-access level + anyone-with-link role and
// toggles guest commenting.
//
// UNIT tests of the validation / C-003 guard LOGIC against an in-memory fake
// ShareRepo (mirrors publish's fakeRepo + version's VersionRepo pattern). They
// assert the SETTING is persisted correctly (level + role + guestCommenting). The
// actual "outsider gets commenter access" / "stranger denied" ENFORCEMENT is
// S-005's role logic + the /d/:slug gate (integration) — NOT asserted here. The
// real Drizzle upsert (docs.general_access + the unique-docId share_links row in
// one transaction) is integration-verified-later.

// In-memory fake: one share_links-style row per doc (keyed on docId — enforces the
// C-001 single-config invariant) + the doc's general_access level. Exposes ONLY
// the setGeneralAccess upsert the port needs. The link controls (S-004) are not
// modeled here — this is S-001's surface.
function fakeRepo() {
  const rows = new Map<string, ResolvedShareSetting>();
  const repo: ShareRepo = {
    async setGeneralAccess(docId, setting) {
      // Upsert on docId (C-001: never a second row for the same doc).
      const resolved: ResolvedShareSetting = { docId, ...setting };
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
  expect(out.guestCommenting).toBe(false); // not requested → defaults false
  expect(f.rows.get("doc-1")).toEqual({
    docId: "doc-1",
    level: "anyone_with_link",
    role: "commenter",
    guestCommenting: false,
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

test("AS-003 / C-003: guest commenting on a restricted doc is rejected (toggle unavailable until anyone-with-link)", async () => {
  const f = fakeRepo();

  // restricted + guestCommenting → rejected with a clear domain error.
  await expect(
    setGeneralAccess("doc-1", { level: "restricted", role: "commenter", guestCommenting: true }, f.repo),
  ).rejects.toThrow(ShareRejected);
  // Nothing persisted — guard runs BEFORE the repo is touched.
  expect(f.rows.has("doc-1")).toBe(false);

  // anyone_in_workspace is also not anyone-with-link → still rejected.
  await expect(
    setGeneralAccess(
      "doc-1",
      { level: "anyone_in_workspace", role: "commenter", guestCommenting: true },
      f.repo,
    ),
  ).rejects.toThrow(/anyone_with_link/);

  // The OTHER direction: anyone-with-link + guestCommenting → accepted & persisted.
  const ok = await setGeneralAccess(
    "doc-1",
    { level: "anyone_with_link", role: "commenter", guestCommenting: true },
    f.repo,
  );
  expect(ok.guestCommenting).toBe(true);
  expect(f.rows.get("doc-1")?.guestCommenting).toBe(true);
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
    guestCommenting: false,
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
