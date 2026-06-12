// In-process route tests for the sharing-permissions /api/docs/:slug/{access,invites,link}
// mounts (no DB). Exercise the HTTP GLUE only — envelope + auth gate + Zod validation +
// existence-hiding (C-006) + manage-sharing gate (C-007/C-015 Google-Docs model:
// AS-014 editor-on, AS-023 editor-off, AS-024 viewer/commenter, AS-022 owner-only toggle)
// + the share/invite services — via
// app.handle(Request)→Response. Fake repos + a fake resolveSession + a fake resolveDocRole
// are injected so route→service runs without Postgres; the real-DB path is covered by
// test/integration/sharing-routes.itest.ts.
//
// AS map (sharing-permissions):
//   AS-001  PUT access (anyone_with_link + commenter) → 200 { level, role, guestCommenting }
//   AS-003  PUT access guest-commenting on restricted → 400 VALIDATION_ERROR
//   AS-018  PUT access invalid role → 400 VALIDATION_ERROR
//   AS-007  POST invites, existing account → 201 { status: "active" }
//   AS-008  POST invites, no account → 201 { status: "pending" } + enqueue
//   AS-014  editor on a VISIBLE doc with editors_can_share ON → ALLOWED (200/201)
//   AS-023  editor with editors_can_share OFF → 403 FORBIDDEN
//   AS-024  viewer/commenter → 403 (never manage sharing)
//   AS-022  owner sets editors_can_share off → 200; non-owner sets toggle → 403 (C-015)
//   (gates) no session → 401; missing/hidden doc → 404

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { SessionResolver } from "../../src/http/auth-gate";
import type { Role } from "../../src/sharing/roles";
import type { DocLookup, DocLookupRepo } from "../../src/routes/versions";
import type { ShareRepo, ResolvedShareSetting } from "../../src/sharing/share";
import { createFakeDocMemberStore } from "../../src/sharing/invite";
import type { EnqueuedInvite } from "../../src/sharing/invite";
import type { ShareStateRepo, ShareStateRow } from "../../src/sharing/share-state";

const member: SessionResolver = async () => ({ userId: "u_owner" });
const noSession: SessionResolver = async () => null;
const asOwner = async (): Promise<Role | null> => "owner";
const asEditor = async (): Promise<Role | null> => "editor";
const asViewer = async (): Promise<Role | null> => "viewer";
const asCommenter = async (): Promise<Role | null> => "commenter";

// loadShareConfig fakes — the manage-sharing gate reads editors_can_share from here.
const shareToggleOn = async () => ({ editorsCanShare: true });
const shareToggleOff = async () => ({ editorsCanShare: false });

const VISIBLE_DOC: DocLookup = {
  id: "doc_1",
  title: "Doc One",
  kind: "markdown",
  generalAccess: "anyone_with_link",
};

function fakeLookupRepo(doc: DocLookup | null): DocLookupRepo {
  return {
    async findDocBySlug(_slug) {
      return doc;
    },
    async getVersionContent() {
      return null;
    },
  };
}

/** In-memory ShareRepo recording the last persisted setting. */
function fakeShareRepo() {
  const calls: ResolvedShareSetting[] = [];
  const repo: ShareRepo = {
    async setGeneralAccess(docId, setting) {
      const resolved: ResolvedShareSetting = {
        docId,
        ...setting,
        editorsCanShare: setting.editorsCanShare ?? true,
      };
      calls.push(resolved);
      return resolved;
    },
  };
  return { repo, calls };
}

// AS-025 fixture: anyone-with-link/commenter, guest ON, editors_can_share ON, one
// ACTIVE + one PENDING invite, a password-protected link with expiry/view controls.
// AS-026: the repo shape carries hasPassword (a boolean) only — never a hash.
const SHARE_STATE_ROW: ShareStateRow = {
  level: "anyone_with_link",
  role: "commenter",
  guestCommenting: true,
  editorsCanShare: true,
  people: [
    { email: "active@acme.com", name: "Active Person", role: "editor", status: "active" },
    { email: "pending@x.com", role: "viewer", status: "pending" },
  ],
  link: {
    hasPassword: true,
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    viewLimit: 50,
    viewCount: 7,
  },
};

function fakeShareStateRepo(row: ShareStateRow = SHARE_STATE_ROW): ShareStateRepo {
  return { async readShareState() { return row; } };
}

function req(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function buildApp(opts: {
  resolveSession?: SessionResolver;
  resolveDocRole?: (docId: string, userId: string) => Promise<Role | null>;
  loadShareConfig?: (docId: string) => Promise<{ editorsCanShare: boolean }>;
  doc?: DocLookup | null;
  shareRepo?: ShareRepo;
  findUserByEmail?: (email: string) => { id: string } | null;
  enqueueInvite?: (msg: EnqueuedInvite) => void;
  members?: ReturnType<typeof createFakeDocMemberStore>;
  shareStateRepo?: ShareStateRepo;
}) {
  return createApp({
    dbCheck: async () => {},
    sharing: {
      shareRepo: opts.shareRepo ?? fakeShareRepo().repo,
      docMemberRepo: opts.members ?? createFakeDocMemberStore(),
      lookupRepo: fakeLookupRepo(opts.doc === undefined ? VISIBLE_DOC : opts.doc),
      shareStateRepo: opts.shareStateRepo ?? fakeShareStateRepo(),
      findUserByEmail: opts.findUserByEmail ?? (() => null),
      enqueueInvite: opts.enqueueInvite ?? (() => {}),
      resolveSession: opts.resolveSession ?? member,
      resolveWorkspaceRole: async () => "member",
      resolveDocRole: opts.resolveDocRole ?? asOwner,
      // Default toggle ON (the Google-Docs default) unless a test overrides it.
      loadShareConfig: opts.loadShareConfig ?? shareToggleOn,
      accessDeps: { isInvited: () => true, isWorkspaceMember: () => true },
    },
  });
}

describe("PUT /api/docs/:slug/access (S-001)", () => {
  test("AS-001: owner sets anyone_with_link + commenter → 200 { level, role, guestCommenting }", async () => {
    const share = fakeShareRepo();
    const app = buildApp({ shareRepo: share.repo });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/access", {
        method: "PUT",
        body: JSON.stringify({ level: "anyone_with_link", role: "commenter", guestCommenting: true }),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data).toEqual({
      level: "anyone_with_link",
      role: "commenter",
      guestCommenting: true,
      editorsCanShare: true,
    });
    expect(share.calls).toHaveLength(1);
    expect(share.calls[0]?.guestCommenting).toBe(true);
  });

  test("AS-018: invalid role → 400 VALIDATION_ERROR (no persist)", async () => {
    const share = fakeShareRepo();
    const app = buildApp({ shareRepo: share.repo });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/access", {
        method: "PUT",
        body: JSON.stringify({ level: "anyone_with_link", role: "owner" }),
      }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(share.calls).toHaveLength(0);
  });

  test("AS-003: guest commenting on restricted → 400 VALIDATION_ERROR", async () => {
    const app = buildApp({});
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/access", {
        method: "PUT",
        body: JSON.stringify({ level: "restricted", role: "viewer", guestCommenting: true }),
      }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  test("AS-014: editor on a VISIBLE doc with editors_can_share ON → 200 ALLOWED", async () => {
    const share = fakeShareRepo();
    const app = buildApp({ resolveDocRole: asEditor, loadShareConfig: shareToggleOn, shareRepo: share.repo });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/access", {
        method: "PUT",
        body: JSON.stringify({ level: "anyone_with_link", role: "viewer" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(share.calls).toHaveLength(1);
  });

  test("AS-023: editor with editors_can_share OFF → 403 FORBIDDEN (no persist)", async () => {
    const share = fakeShareRepo();
    const app = buildApp({ resolveDocRole: asEditor, loadShareConfig: shareToggleOff, shareRepo: share.repo });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/access", {
        method: "PUT",
        body: JSON.stringify({ level: "anyone_with_link", role: "viewer" }),
      }),
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("FORBIDDEN");
    expect(share.calls).toHaveLength(0);
  });

  test("AS-024: viewer can never manage sharing → 403 (toggle on)", async () => {
    const app = buildApp({ resolveDocRole: asViewer, loadShareConfig: shareToggleOn });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/access", {
        method: "PUT",
        body: JSON.stringify({ level: "anyone_with_link", role: "viewer" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  test("AS-024: commenter can never manage sharing → 403 (toggle on)", async () => {
    const app = buildApp({ resolveDocRole: asCommenter, loadShareConfig: shareToggleOn });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/access", {
        method: "PUT",
        body: JSON.stringify({ level: "anyone_with_link", role: "viewer" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  test("AS-022 / C-015: owner sets editors_can_share off → 200 { editorsCanShare: false }", async () => {
    const share = fakeShareRepo();
    const app = buildApp({ resolveDocRole: asOwner, shareRepo: share.repo });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/access", {
        method: "PUT",
        body: JSON.stringify({ level: "anyone_with_link", role: "viewer", editorsCanShare: false }),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.editorsCanShare).toBe(false);
    expect(share.calls[0]?.editorsCanShare).toBe(false);
  });

  test("C-015: a non-owner editor trying to set editors_can_share → 403 (toggle owner-only, no persist)", async () => {
    // Editor may otherwise manage sharing (toggle on) — but may NOT flip the toggle itself.
    const share = fakeShareRepo();
    const app = buildApp({ resolveDocRole: asEditor, loadShareConfig: shareToggleOn, shareRepo: share.repo });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/access", {
        method: "PUT",
        body: JSON.stringify({ level: "anyone_with_link", role: "viewer", editorsCanShare: false }),
      }),
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("FORBIDDEN");
    expect(share.calls).toHaveLength(0);
  });

  test("no session → 401 UNAUTHENTICATED", async () => {
    const app = buildApp({ resolveSession: noSession });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/access", {
        method: "PUT",
        body: JSON.stringify({ level: "anyone_with_link", role: "viewer" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  test("missing/hidden doc → 404 (existence-hiding before owner gate)", async () => {
    const app = buildApp({ doc: null });
    const res = await app.handle(
      req("/api/w/ws_1/docs/nope/access", {
        method: "PUT",
        body: JSON.stringify({ level: "anyone_with_link", role: "viewer" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("bad body (missing level) → 400 VALIDATION_ERROR", async () => {
    const app = buildApp({});
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/access", { method: "PUT", body: JSON.stringify({ role: "viewer" }) }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/docs/:slug/invites (S-003)", () => {
  test("AS-007: invite an existing account → 201 { status: 'active' } + active member row", async () => {
    const members = createFakeDocMemberStore();
    const enqueued: EnqueuedInvite[] = [];
    const app = buildApp({
      members,
      findUserByEmail: () => ({ id: "u_existing" }),
      enqueueInvite: (m) => enqueued.push(m),
    });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/invites", {
        method: "POST",
        body: JSON.stringify({ email: "has@acct.com", role: "editor" }),
      }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.data.status).toBe("active");
    const row = members.rows()[0];
    expect(row?.status).toBe("active");
    expect(row?.userId).toBe("u_existing");
    expect(enqueued[0]?.kind).toBe("active");
  });

  test("AS-008: invite an email with NO account → 201 { status: 'pending' } + pending row + enqueue", async () => {
    const members = createFakeDocMemberStore();
    const enqueued: EnqueuedInvite[] = [];
    const app = buildApp({
      members,
      findUserByEmail: () => null,
      enqueueInvite: (m) => enqueued.push(m),
    });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/invites", {
        method: "POST",
        body: JSON.stringify({ email: "New@Acct.com", role: "commenter" }),
      }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.data.status).toBe("pending");
    const row = members.rows()[0];
    expect(row?.status).toBe("pending");
    expect(row?.userId).toBeNull();
    expect(row?.email).toBe("new@acct.com"); // normalized
    expect(enqueued[0]?.kind).toBe("pending");
  });

  test("AS-014: editor with editors_can_share ON → 201 (can invite)", async () => {
    const app = buildApp({ resolveDocRole: asEditor, loadShareConfig: shareToggleOn });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/invites", {
        method: "POST",
        body: JSON.stringify({ email: "x@y.com", role: "viewer" }),
      }),
    );
    expect(res.status).toBe(201);
  });

  test("AS-023: editor with editors_can_share OFF → 403", async () => {
    const app = buildApp({ resolveDocRole: asEditor, loadShareConfig: shareToggleOff });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/invites", {
        method: "POST",
        body: JSON.stringify({ email: "x@y.com", role: "viewer" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  test("AS-024: viewer → 403 (cannot invite, toggle on)", async () => {
    const app = buildApp({ resolveDocRole: asViewer, loadShareConfig: shareToggleOn });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/invites", {
        method: "POST",
        body: JSON.stringify({ email: "x@y.com", role: "viewer" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  test("no session → 401", async () => {
    const app = buildApp({ resolveSession: noSession });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/invites", {
        method: "POST",
        body: JSON.stringify({ email: "x@y.com", role: "viewer" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  test("missing doc → 404", async () => {
    const app = buildApp({ doc: null });
    const res = await app.handle(
      req("/api/w/ws_1/docs/nope/invites", {
        method: "POST",
        body: JSON.stringify({ email: "x@y.com", role: "viewer" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("invalid email → 400 VALIDATION_ERROR", async () => {
    const app = buildApp({});
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/invites", {
        method: "POST",
        body: JSON.stringify({ email: "not-an-email", role: "viewer" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/docs/:slug/link (S-004) — gate behaviour (no DB)", () => {
  // The link route persists onto share_links and so needs a DB; the persistence path
  // is integration-verified. Here we assert the GATES that run BEFORE persistence.
  test("AS-023: editor with editors_can_share OFF → 403 (before any DB write)", async () => {
    const app = buildApp({ resolveDocRole: asEditor, loadShareConfig: shareToggleOff });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/link", { method: "PUT", body: JSON.stringify({ viewLimit: 5 }) }),
    );
    expect(res.status).toBe(403);
  });

  test("AS-024: viewer → 403 (cannot set link controls)", async () => {
    const app = buildApp({ resolveDocRole: asViewer, loadShareConfig: shareToggleOn });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/link", { method: "PUT", body: JSON.stringify({ viewLimit: 5 }) }),
    );
    expect(res.status).toBe(403);
  });

  test("no session → 401", async () => {
    const app = buildApp({ resolveSession: noSession });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/link", { method: "PUT", body: JSON.stringify({ viewLimit: 5 }) }),
    );
    expect(res.status).toBe(401);
  });

  test("missing doc → 404", async () => {
    const app = buildApp({ doc: null });
    const res = await app.handle(
      req("/api/w/ws_1/docs/nope/link", { method: "PUT", body: JSON.stringify({ viewLimit: 5 }) }),
    );
    expect(res.status).toBe(404);
  });

  test("bad body (viewLimit not positive) → 400 VALIDATION_ERROR", async () => {
    const app = buildApp({});
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/link", { method: "PUT", body: JSON.stringify({ viewLimit: 0 }) }),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/w/:workspaceId/docs/:slug/share (S-006 — read share state)", () => {
  test("AS-025: owner reads full share state → level, role, guestCommenting, editorsCanShare, people[], link controls", async () => {
    const app = buildApp({ resolveDocRole: asOwner });
    const res = await app.handle(req("/api/w/ws_1/docs/doc-one/share"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    const d = json.data;
    // AS-025.T1 level · T2 role · T3 guestCommenting · T4 editorsCanShare
    expect(d.level).toBe("anyone_with_link");
    expect(d.role).toBe("commenter");
    expect(d.guestCommenting).toBe(true);
    expect(d.editorsCanShare).toBe(true);
    // AS-025.T5 people[] — each with email/name, role, active|pending
    expect(d.people).toHaveLength(2);
    expect(d.people[0]).toEqual({
      email: "active@acme.com",
      name: "Active Person",
      role: "editor",
      status: "active",
    });
    const pending = d.people.find((p: any) => p.status === "pending");
    expect(pending.email).toBe("pending@x.com");
    expect(pending.role).toBe("viewer");
    expect(pending.name).toBeUndefined(); // pending invite has no account name
    // AS-025.T6 link{ expiresAt, viewLimit, viewCount, url, hasPassword }
    expect(d.link.hasPassword).toBe(true);
    expect(new Date(d.link.expiresAt).toISOString()).toBe("2030-01-01T00:00:00.000Z");
    expect(d.link.viewLimit).toBe(50);
    expect(d.link.viewCount).toBe(7);
    expect(d.link.url).toBe("/d/doc-one"); // shareable viewer path
  });

  test("AS-026: the stored password is NEVER returned — only a hasPassword boolean, no hash", async () => {
    const app = buildApp({ resolveDocRole: asOwner });
    const res = await app.handle(req("/api/w/ws_1/docs/doc-one/share"));
    expect(res.status).toBe(200);
    const raw = await res.text();
    // No password hash anywhere in the serialized response (argon2 hashes start "$argon2").
    expect(raw).not.toContain("$argon2");
    expect(raw.toLowerCase()).not.toContain("passwordhash");
    const json = JSON.parse(raw);
    expect(json.data.link.hasPassword).toBe(true);
    expect(json.data.link).not.toHaveProperty("passwordHash");
    expect(json.data.link).not.toHaveProperty("password");
  });

  test("AS-027 / C-016: a commenter (cannot manage) is REFUSED the read → 403 FORBIDDEN", async () => {
    const app = buildApp({ resolveDocRole: asCommenter, loadShareConfig: shareToggleOn });
    const res = await app.handle(req("/api/w/ws_1/docs/doc-one/share"));
    expect(res.status).toBe(403);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  test("AS-027 / C-016: an editor when editors_can_share is OFF is REFUSED → 403", async () => {
    const app = buildApp({ resolveDocRole: asEditor, loadShareConfig: shareToggleOff });
    const res = await app.handle(req("/api/w/ws_1/docs/doc-one/share"));
    expect(res.status).toBe(403);
  });

  test("C-016: an editor when editors_can_share is ON CAN read (gated identically to writes) → 200", async () => {
    const app = buildApp({ resolveDocRole: asEditor, loadShareConfig: shareToggleOn });
    const res = await app.handle(req("/api/w/ws_1/docs/doc-one/share"));
    expect(res.status).toBe(200);
  });

  test("no session → 401 UNAUTHENTICATED", async () => {
    const app = buildApp({ resolveSession: noSession });
    const res = await app.handle(req("/api/w/ws_1/docs/doc-one/share"));
    expect(res.status).toBe(401);
  });

  test("missing/hidden doc → 404 (existence-hiding before the manage gate)", async () => {
    const app = buildApp({ doc: null });
    const res = await app.handle(req("/api/w/ws_1/docs/nope/share"));
    expect(res.status).toBe(404);
  });
});

describe("PATCH/DELETE /api/w/:workspaceId/docs/:slug/members/:memberId (S-007)", () => {
  // Seed a member store with rows on doc_1 (the VISIBLE_DOC). A row on a DIFFERENT doc
  // and the absence of any owner row are how AS-032 owner-protection is exercised: the
  // repo is docId-scoped, so a memberId not on THIS doc → null/false → 404.
  async function seedMembers() {
    const members = createFakeDocMemberStore();
    const active = await members.insert({
      docId: "doc_1",
      userId: "u_member",
      email: "member@acme.com",
      role: "viewer",
      message: null,
      invitedBy: "u_owner",
      status: "active",
    });
    const pending = await members.insert({
      docId: "doc_1",
      userId: null,
      email: "bob@x.com",
      role: "viewer",
      message: null,
      invitedBy: "u_owner",
      status: "pending",
    });
    const otherDoc = await members.insert({
      docId: "doc_OTHER",
      userId: "u_other",
      email: "other@acme.com",
      role: "editor",
      message: null,
      invitedBy: "u_owner",
      status: "active",
    });
    return { members, activeId: active.id, pendingId: pending.id, otherDocId: otherDoc.id };
  }

  test("AS-028: manager PATCHes an active member viewer→editor → 200 { role: 'editor' }", async () => {
    const { members, activeId } = await seedMembers();
    const app = buildApp({ members, resolveDocRole: asOwner });
    const res = await app.handle(
      req(`/api/w/ws_1/docs/doc-one/members/${activeId}`, {
        method: "PATCH",
        body: JSON.stringify({ role: "editor" }),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data).toEqual({ role: "editor" });
    // side effect: the stored row's role is now editor
    expect(members.rows().find((r) => r.id === activeId)?.role).toBe("editor");
  });

  test("AS-029: manager DELETEs an active member → 200 { removed: true } + row gone", async () => {
    const { members, activeId } = await seedMembers();
    const app = buildApp({ members, resolveDocRole: asOwner });
    const res = await app.handle(
      req(`/api/w/ws_1/docs/doc-one/members/${activeId}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data).toEqual({ removed: true });
    expect(members.rows().find((r) => r.id === activeId)).toBeUndefined();
  });

  test("AS-030: manager DELETEs a PENDING invite (userId null) → 200 + row gone", async () => {
    const { members, pendingId } = await seedMembers();
    const app = buildApp({ members, resolveDocRole: asOwner });
    const res = await app.handle(
      req(`/api/w/ws_1/docs/doc-one/members/${pendingId}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.removed).toBe(true);
    expect(members.rows().find((r) => r.id === pendingId)).toBeUndefined();
  });

  test("AS-031 / C-017: a commenter (cannot manage) → PATCH refused 403, member set unchanged", async () => {
    const { members, activeId } = await seedMembers();
    const before = members.rows();
    const app = buildApp({ members, resolveDocRole: asCommenter, loadShareConfig: shareToggleOn });
    const res = await app.handle(
      req(`/api/w/ws_1/docs/doc-one/members/${activeId}`, {
        method: "PATCH",
        body: JSON.stringify({ role: "editor" }),
      }),
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("FORBIDDEN");
    expect(members.rows()).toEqual(before); // unchanged
  });

  test("AS-031: a commenter (cannot manage) → DELETE refused 403, member set unchanged", async () => {
    const { members, activeId } = await seedMembers();
    const before = members.rows();
    const app = buildApp({ members, resolveDocRole: asCommenter, loadShareConfig: shareToggleOn });
    const res = await app.handle(
      req(`/api/w/ws_1/docs/doc-one/members/${activeId}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("FORBIDDEN");
    expect(members.rows()).toEqual(before); // unchanged
  });

  test("AS-032: PATCH a memberId not on THIS doc (owner / other doc) → 404, nothing changed", async () => {
    const { members, otherDocId } = await seedMembers();
    const before = members.rows();
    const app = buildApp({ members, resolveDocRole: asOwner });
    // a member of doc_OTHER, addressed via doc-one (→ doc_1): repo is docId-scoped → null
    const res = await app.handle(
      req(`/api/w/ws_1/docs/doc-one/members/${otherDocId}`, {
        method: "PATCH",
        body: JSON.stringify({ role: "editor" }),
      }),
    );
    expect(res.status).toBe(404);
    expect(members.rows()).toEqual(before);
    // and a wholly-unknown id (the owner has NO member row to target) → also 404
    const res2 = await app.handle(
      req(`/api/w/ws_1/docs/doc-one/members/dm_owner_has_no_row`, {
        method: "PATCH",
        body: JSON.stringify({ role: "editor" }),
      }),
    );
    expect(res2.status).toBe(404);
  });

  test("AS-032: DELETE a memberId not on THIS doc (owner / other doc) → 404, nothing changed", async () => {
    const { members, otherDocId } = await seedMembers();
    const before = members.rows();
    const app = buildApp({ members, resolveDocRole: asOwner });
    const res = await app.handle(
      req(`/api/w/ws_1/docs/doc-one/members/${otherDocId}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(404);
    expect(members.rows()).toEqual(before);
    const res2 = await app.handle(
      req(`/api/w/ws_1/docs/doc-one/members/dm_owner_has_no_row`, { method: "DELETE" }),
    );
    expect(res2.status).toBe(404);
  });

  test("AS-028: an invalid role (owner) → 400 VALIDATION_ERROR, no change", async () => {
    const { members, activeId } = await seedMembers();
    const before = members.rows();
    const app = buildApp({ members, resolveDocRole: asOwner });
    const res = await app.handle(
      req(`/api/w/ws_1/docs/doc-one/members/${activeId}`, {
        method: "PATCH",
        body: JSON.stringify({ role: "owner" }),
      }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(members.rows()).toEqual(before);
  });

  test("AS-031: no session → 401 (PATCH gated before any change)", async () => {
    const { members, activeId } = await seedMembers();
    const app = buildApp({ members, resolveSession: noSession });
    const res = await app.handle(
      req(`/api/w/ws_1/docs/doc-one/members/${activeId}`, {
        method: "PATCH",
        body: JSON.stringify({ role: "editor" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  test("AS-032: missing/hidden doc → 404 before the manage gate (DELETE)", async () => {
    const { members, activeId } = await seedMembers();
    const app = buildApp({ members, doc: null });
    const res = await app.handle(
      req(`/api/w/ws_1/docs/nope/members/${activeId}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(404);
  });
});
