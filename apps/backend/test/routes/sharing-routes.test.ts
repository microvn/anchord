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
//   AS-001  PUT access (anyone_with_link + commenter) → 200 { level, role, editorsCanShare }
//           (the commenter+ link role IS the guest grant — no toggle, reversal 2026-06-20)
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
import { linkBodySchema } from "../../src/routes/sharing";
import type {
  LinkControlsUpdate,
  PersistedLinkControls,
} from "../../src/sharing/link-controls-repo";

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

// AS-025 fixture: anyone-with-link/commenter (the commenter+ link role IS the guest grant —
// no separate toggle, reversal 2026-06-20), editors_can_share ON, one ACTIVE + one PENDING
// invite, a password-protected link with expiry/view controls.
// AS-026: the repo shape carries hasPassword (a boolean) only — never a hash.
const SHARE_STATE_ROW: ShareStateRow = {
  level: "anyone_with_link",
  role: "commenter",
  editorsCanShare: true,
  people: [
    { id: "m-active", email: "active@acme.com", name: "Active Person", role: "editor", status: "active" },
    { id: "m-pending", email: "pending@x.com", role: "viewer", status: "pending" },
  ],
  link: {
    hasPassword: true,
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    viewLimit: 50,
    viewCount: 7,
  },
  // capability-share-link S-005: an anyone_with_link doc carries a capability token → the read
  // surfaces it as the external /s/<token> link (AS-012).
  capabilityToken: "Hk3vQ2pLm8rT5wXyZ0aBcD",
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
  setLinkControls?: (docId: string, update: LinkControlsUpdate) => Promise<PersistedLinkControls>;
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
      setLinkControls: opts.setLinkControls,
      accessDeps: { isInvited: () => true, isWorkspaceMember: () => true },
    },
  });
}

/**
 * In-memory link-controls persister mirroring the real Drizzle setLinkControls contract:
 * stores exactly what the handler writes (passwordHash/expiresAt/viewLimit) and echoes it
 * back, so a route test can assert the handler maps a CLEAR (null) all the way through
 * without a real Postgres. Records the last update the handler asked for.
 */
function fakeLinkControls() {
  const calls: LinkControlsUpdate[] = [];
  const persist = async (
    _docId: string,
    update: LinkControlsUpdate,
  ): Promise<PersistedLinkControls> => {
    calls.push(update);
    return {
      passwordSet: update.passwordHash != null,
      expiresAt: update.expiresAt ?? null,
      viewLimit: update.viewLimit ?? null,
      viewCount: 0,
    };
  };
  return { persist, calls };
}

/**
 * A statefully-merging link-controls persister that mirrors the REAL Drizzle repo's
 * partial-update contract (C-001 / AS-033): only the keys PRESENT in the update mutate
 * their column; an absent key (`undefined`) leaves the column unchanged. Setting a
 * non-null viewLimit resets viewCount to 0 (AS-033). Seeded with an initial row so a
 * route test can assert that touching one control leaves the others intact.
 */
function statefulLinkControls(initial: {
  passwordHash?: string | null;
  expiresAt?: Date | null;
  viewLimit?: number | null;
  viewCount?: number;
} = {}) {
  const state = {
    passwordHash: initial.passwordHash ?? null,
    expiresAt: initial.expiresAt ?? null,
    viewLimit: initial.viewLimit ?? null,
    viewCount: initial.viewCount ?? 0,
  };
  const calls: LinkControlsUpdate[] = [];
  const persist = async (
    _docId: string,
    update: LinkControlsUpdate,
  ): Promise<PersistedLinkControls> => {
    calls.push(update);
    if ("passwordHash" in update) state.passwordHash = update.passwordHash ?? null;
    if ("expiresAt" in update) state.expiresAt = update.expiresAt ?? null;
    if ("viewLimit" in update) {
      state.viewLimit = update.viewLimit ?? null;
      if (update.viewLimit != null) state.viewCount = 0; // AS-033: fresh budget
    }
    return {
      passwordSet: state.passwordHash != null,
      expiresAt: state.expiresAt,
      viewLimit: state.viewLimit,
      viewCount: state.viewCount,
    };
  };
  return { persist, calls, state };
}

describe("PUT /api/docs/:slug/access (S-001)", () => {
  test("AS-001: owner sets anyone_with_link + commenter → 200 { level, role, editorsCanShare } (commenter link IS the guest grant, no toggle)", async () => {
    const share = fakeShareRepo();
    const app = buildApp({ shareRepo: share.repo });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/access", {
        method: "PUT",
        body: JSON.stringify({ level: "anyone_with_link", role: "commenter" }),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data).toEqual({
      level: "anyone_with_link",
      role: "commenter",
      editorsCanShare: true,
    });
    // No guest-commenting field is persisted or echoed (reversal 2026-06-20).
    expect(json.data).not.toHaveProperty("guestCommenting");
    expect(share.calls).toHaveLength(1);
    expect(share.calls[0]).not.toHaveProperty("guestCommenting");
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

  // AS-003 (guest-on-restricted → 400) was REMOVED from the spec on 2026-06-20: there is no
  // guest-commenting toggle, so there is no guest-on-restricted combination to reject. Guest
  // access is decided by the link role alone (a commenter+ link on anyone_with_link).

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

// S-004 (AS-009/010/011 + C-001 "each control independently clearable"). The FE sends
// `null` to CLEAR a control. The schema must (a) ACCEPT null (not 400) and (b) pass
// `expiresAt: null` through as null, NOT coerce it to new Date(null) = epoch-0
// (1970-01-01), which would silently make "clear the expiry" mean "born expired".
// Spec note (S1): the spec has no explicit "clear a link control" AS — tagged to the
// S-004 controls (AS-009/010/011) + C-001 independence. The two defects below are
// distinct: null→400 (password/viewLimit) and null→epoch (expiresAt coercion).
describe("PUT /api/docs/:slug/link (S-004) — clear controls with null (AS-009/010/011, C-001)", () => {
  describe("schema (linkBodySchema) — root cause", () => {
    test("DEFECT-1: password:null & viewLimit:null must PARSE (not be rejected)", () => {
      // RED before the fix: z.string().optional() / z.number().optional() reject null →
      // .safeParse({ password: null, viewLimit: null }).success === false (→ route 400).
      const parsed = linkBodySchema.safeParse({ password: null, viewLimit: null });
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.password).toBeNull();
      expect(parsed.success && parsed.data.viewLimit).toBeNull();
    });

    test("DEFECT-2: expiresAt:null parses to null, NOT new Date(null) (epoch-0)", () => {
      // RED before the fix: z.coerce.date() coerces null → new Date(null) = 1970-01-01
      // (epoch-0), so a "clear" silently becomes an already-expired link.
      const parsed = linkBodySchema.safeParse({ expiresAt: null });
      expect(parsed.success).toBe(true);
      const v = parsed.success ? parsed.data.expiresAt : undefined;
      expect(v).toBeNull(); // NOT a Date
      expect(v instanceof Date).toBe(false); // explicitly not new Date(null)
    });
  });

  test("AS-009/010/011 (clear): PUT { password:null, expiresAt:null, viewLimit:null } → 200 + all cleared (no epoch)", async () => {
    // RED before the fix: the schema rejects null → 400 VALIDATION_ERROR; the control can
    // never be cleared. After: 200, and the handler maps each null straight through.
    const link = fakeLinkControls();
    const app = buildApp({ setLinkControls: link.persist });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/link", {
        method: "PUT",
        body: JSON.stringify({ password: null, expiresAt: null, viewLimit: null }),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    // The persisted/echoed state is CLEARED — password not set, no expiry, no limit.
    expect(json.data.passwordSet).toBe(false);
    expect(json.data.expiresAt).toBeNull(); // NOT "1970-01-01T00:00:00.000Z"
    expect(json.data.viewLimit).toBeNull();
    // And the handler asked the persister to write nulls (never an epoch Date).
    expect(link.calls).toHaveLength(1);
    expect(link.calls[0]?.passwordHash).toBeNull();
    expect(link.calls[0]?.expiresAt).toBeNull();
    expect(link.calls[0]?.expiresAt instanceof Date).toBe(false);
    expect(link.calls[0]?.viewLimit).toBeNull();
  });

  test("AS-009/010/011 (set — regression): a real password + future expiry + viewLimit still persists", async () => {
    const link = fakeLinkControls();
    const app = buildApp({ setLinkControls: link.persist });
    const future = "2030-01-01T00:00:00.000Z";
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/link", {
        method: "PUT",
        body: JSON.stringify({ password: "s3cret", expiresAt: future, viewLimit: 25 }),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.passwordSet).toBe(true);
    expect(new Date(json.data.expiresAt).toISOString()).toBe(future);
    expect(json.data.viewLimit).toBe(25);
    // The handler hashed the password (argon2, not plaintext) and passed the real date through.
    expect(link.calls[0]?.passwordHash).toBeTruthy();
    expect(link.calls[0]?.passwordHash).not.toBe("s3cret");
    expect(link.calls[0]?.expiresAt instanceof Date).toBe(true);
    expect(link.calls[0]?.expiresAt?.toISOString()).toBe(future);
    expect(link.calls[0]?.viewLimit).toBe(25);
  });
});

describe("PUT /api/docs/:slug/link (S-004) — independent controls + view-limit reset (C-001, AS-033)", () => {
  test("C-001: changing ONE control (viewLimit) leaves password + expiry intact", async () => {
    // Seed: a link already has a password + a future expiry, no view limit.
    const expiry = new Date("2030-01-01T00:00:00.000Z");
    const link = statefulLinkControls({ passwordHash: "$argon2id$seeded", expiresAt: expiry });
    const app = buildApp({ setLinkControls: link.persist });
    // PUT only viewLimit — password/expiry are ABSENT, must NOT be touched.
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/link", { method: "PUT", body: JSON.stringify({ viewLimit: 5 }) }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.passwordSet).toBe(true); // STILL set
    expect(new Date(json.data.expiresAt).toISOString()).toBe(expiry.toISOString()); // STILL set
    expect(json.data.viewLimit).toBe(5);
    // The handler must have sent a PARTIAL update — no passwordHash/expiresAt keys.
    expect(link.calls).toHaveLength(1);
    expect("passwordHash" in link.calls[0]!).toBe(false);
    expect("expiresAt" in link.calls[0]!).toBe(false);
    expect(link.state.passwordHash).toBe("$argon2id$seeded");
    expect(link.state.expiresAt?.toISOString()).toBe(expiry.toISOString());
  });

  test("C-001: clearing ONE control with null (password) leaves expiry + viewLimit intact", async () => {
    const expiry = new Date("2030-01-01T00:00:00.000Z");
    const link = statefulLinkControls({
      passwordHash: "$argon2id$seeded",
      expiresAt: expiry,
      viewLimit: 50,
      viewCount: 3,
    });
    const app = buildApp({ setLinkControls: link.persist });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/link", { method: "PUT", body: JSON.stringify({ password: null }) }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.passwordSet).toBe(false); // CLEARED
    expect(new Date(json.data.expiresAt).toISOString()).toBe(expiry.toISOString()); // untouched
    expect(json.data.viewLimit).toBe(50); // untouched
    expect(json.data.viewCount).toBe(3); // untouched (clearing password is not a viewLimit set)
    expect("passwordHash" in link.calls[0]!).toBe(true);
    expect(link.calls[0]?.passwordHash).toBeNull();
    expect("expiresAt" in link.calls[0]!).toBe(false);
    expect("viewLimit" in link.calls[0]!).toBe(false);
  });

  test("AS-033: setting a view limit resets the open count to 0", async () => {
    // A link opened 30× then given a limit of 20 must start a FRESH budget (count → 0).
    const link = statefulLinkControls({ viewLimit: null, viewCount: 30 });
    const app = buildApp({ setLinkControls: link.persist });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/link", { method: "PUT", body: JSON.stringify({ viewLimit: 20 }) }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.viewLimit).toBe(20);
    expect(json.data.viewCount).toBe(0); // RESET (was 30)
    expect(link.state.viewCount).toBe(0);
  });

  test("AS-033 edge: clearing the view limit (null) does NOT reset the count", async () => {
    const link = statefulLinkControls({ viewLimit: 10, viewCount: 10 });
    const app = buildApp({ setLinkControls: link.persist });
    const res = await app.handle(
      req("/api/w/ws_1/docs/doc-one/link", { method: "PUT", body: JSON.stringify({ viewLimit: null }) }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.viewLimit).toBeNull(); // no limit
    expect(json.data.viewCount).toBe(10); // left as-is (clearing is not "setting a limit")
    expect(link.state.viewCount).toBe(10);
  });
});

describe("GET /api/w/:workspaceId/docs/:slug/share (S-006 — read share state)", () => {
  test("AS-025: owner reads full share state → level, role, editorsCanShare, people[], link controls (no guestCommenting field)", async () => {
    const app = buildApp({ resolveDocRole: asOwner });
    const res = await app.handle(req("/api/w/ws_1/docs/doc-one/share"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    const d = json.data;
    // AS-025.T1 level · T2 role · T3 editorsCanShare
    expect(d.level).toBe("anyone_with_link");
    expect(d.role).toBe("commenter");
    expect(d.editorsCanShare).toBe(true);
    // No guest-commenting field is returned (reversal 2026-06-20).
    expect(d).not.toHaveProperty("guestCommenting");
    // AS-025.T5 people[] — each with member id, email/name, role, active|pending
    expect(d.people).toHaveLength(2);
    expect(d.people[0]).toEqual({
      id: "m-active",
      email: "active@acme.com",
      name: "Active Person",
      role: "editor",
      status: "active",
    });
    const pending = d.people.find((p: any) => p.status === "pending");
    expect(pending.id).toBe("m-pending"); // member id lets the dialog target change/remove (S-007)
    expect(pending.email).toBe("pending@x.com");
    expect(pending.role).toBe("viewer");
    expect(pending.name).toBeUndefined(); // pending invite has no account name
    // AS-025.T6 link{ expiresAt, viewLimit, viewCount, url, hasPassword }
    expect(d.link.hasPassword).toBe(true);
    expect(new Date(d.link.expiresAt).toISOString()).toBe("2030-01-01T00:00:00.000Z");
    expect(d.link.viewLimit).toBe(50);
    expect(d.link.viewCount).toBe(7);
    expect(d.link.url).toBe("/d/doc-one"); // shareable viewer path
    // capability-share-link S-005 / AS-012: anyone_with_link → the external /s/<token> capability
    // link, distinct from the in-app /d/<slug> address above.
    expect(d.capabilityUrl).toBe("/s/Hk3vQ2pLm8rT5wXyZ0aBcD");
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
