// In-process route tests for the sharing-permissions /api/docs/:slug/{access,invites,link}
// mounts (no DB). Exercise the HTTP GLUE only — envelope + auth gate + Zod validation +
// existence-hiding (C-006) + owner gate (C-007/AS-014) + the share/invite services — via
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
//   AS-014  non-owner (editor) on a VISIBLE doc → 403 FORBIDDEN
//   (gates) no session → 401; missing/hidden doc → 404

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { SessionResolver } from "../../src/http/auth-gate";
import type { Role } from "../../src/sharing/roles";
import type { DocLookup, DocLookupRepo } from "../../src/routes/versions";
import type { ShareRepo, ResolvedShareSetting } from "../../src/sharing/share";
import { createFakeDocMemberStore } from "../../src/sharing/invite";
import type { EnqueuedInvite } from "../../src/sharing/invite";

const member: SessionResolver = async () => ({ userId: "u_owner" });
const noSession: SessionResolver = async () => null;
const asOwner = async (): Promise<Role | null> => "owner";
const asEditor = async (): Promise<Role | null> => "editor";

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
      const resolved: ResolvedShareSetting = { docId, ...setting };
      calls.push(resolved);
      return resolved;
    },
  };
  return { repo, calls };
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
  doc?: DocLookup | null;
  shareRepo?: ShareRepo;
  findUserByEmail?: (email: string) => { id: string } | null;
  enqueueInvite?: (msg: EnqueuedInvite) => void;
  members?: ReturnType<typeof createFakeDocMemberStore>;
}) {
  return createApp({
    dbCheck: async () => {},
    sharing: {
      shareRepo: opts.shareRepo ?? fakeShareRepo().repo,
      docMemberRepo: opts.members ?? createFakeDocMemberStore(),
      lookupRepo: fakeLookupRepo(opts.doc === undefined ? VISIBLE_DOC : opts.doc),
      findUserByEmail: opts.findUserByEmail ?? (() => null),
      enqueueInvite: opts.enqueueInvite ?? (() => {}),
      resolveSession: opts.resolveSession ?? member,
      resolveDocRole: opts.resolveDocRole ?? asOwner,
      accessDeps: { isInvited: () => true, isWorkspaceMember: () => true },
    },
  });
}

describe("PUT /api/docs/:slug/access (S-001)", () => {
  test("AS-001: owner sets anyone_with_link + commenter → 200 { level, role, guestCommenting }", async () => {
    const share = fakeShareRepo();
    const app = buildApp({ shareRepo: share.repo });
    const res = await app.handle(
      req("/api/docs/doc-one/access", {
        method: "PUT",
        body: JSON.stringify({ level: "anyone_with_link", role: "commenter", guestCommenting: true }),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data).toEqual({ level: "anyone_with_link", role: "commenter", guestCommenting: true });
    expect(share.calls).toHaveLength(1);
    expect(share.calls[0]?.guestCommenting).toBe(true);
  });

  test("AS-018: invalid role → 400 VALIDATION_ERROR (no persist)", async () => {
    const share = fakeShareRepo();
    const app = buildApp({ shareRepo: share.repo });
    const res = await app.handle(
      req("/api/docs/doc-one/access", {
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
      req("/api/docs/doc-one/access", {
        method: "PUT",
        body: JSON.stringify({ level: "restricted", role: "viewer", guestCommenting: true }),
      }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  test("AS-014: editor (non-owner) on a VISIBLE doc → 403 FORBIDDEN", async () => {
    const app = buildApp({ resolveDocRole: asEditor });
    const res = await app.handle(
      req("/api/docs/doc-one/access", {
        method: "PUT",
        body: JSON.stringify({ level: "anyone_with_link", role: "viewer" }),
      }),
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  test("no session → 401 UNAUTHENTICATED", async () => {
    const app = buildApp({ resolveSession: noSession });
    const res = await app.handle(
      req("/api/docs/doc-one/access", {
        method: "PUT",
        body: JSON.stringify({ level: "anyone_with_link", role: "viewer" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  test("missing/hidden doc → 404 (existence-hiding before owner gate)", async () => {
    const app = buildApp({ doc: null });
    const res = await app.handle(
      req("/api/docs/nope/access", {
        method: "PUT",
        body: JSON.stringify({ level: "anyone_with_link", role: "viewer" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("bad body (missing level) → 400 VALIDATION_ERROR", async () => {
    const app = buildApp({});
    const res = await app.handle(
      req("/api/docs/doc-one/access", { method: "PUT", body: JSON.stringify({ role: "viewer" }) }),
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
      req("/api/docs/doc-one/invites", {
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
      req("/api/docs/doc-one/invites", {
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

  test("AS-014: editor (non-owner) → 403", async () => {
    const app = buildApp({ resolveDocRole: asEditor });
    const res = await app.handle(
      req("/api/docs/doc-one/invites", {
        method: "POST",
        body: JSON.stringify({ email: "x@y.com", role: "viewer" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  test("no session → 401", async () => {
    const app = buildApp({ resolveSession: noSession });
    const res = await app.handle(
      req("/api/docs/doc-one/invites", {
        method: "POST",
        body: JSON.stringify({ email: "x@y.com", role: "viewer" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  test("missing doc → 404", async () => {
    const app = buildApp({ doc: null });
    const res = await app.handle(
      req("/api/docs/nope/invites", {
        method: "POST",
        body: JSON.stringify({ email: "x@y.com", role: "viewer" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("invalid email → 400 VALIDATION_ERROR", async () => {
    const app = buildApp({});
    const res = await app.handle(
      req("/api/docs/doc-one/invites", {
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
  test("AS-014: editor (non-owner) → 403 (before any DB write)", async () => {
    const app = buildApp({ resolveDocRole: asEditor });
    const res = await app.handle(
      req("/api/docs/doc-one/link", { method: "PUT", body: JSON.stringify({ viewLimit: 5 }) }),
    );
    expect(res.status).toBe(403);
  });

  test("no session → 401", async () => {
    const app = buildApp({ resolveSession: noSession });
    const res = await app.handle(
      req("/api/docs/doc-one/link", { method: "PUT", body: JSON.stringify({ viewLimit: 5 }) }),
    );
    expect(res.status).toBe(401);
  });

  test("missing doc → 404", async () => {
    const app = buildApp({ doc: null });
    const res = await app.handle(
      req("/api/docs/nope/link", { method: "PUT", body: JSON.stringify({ viewLimit: 5 }) }),
    );
    expect(res.status).toBe(404);
  });

  test("bad body (viewLimit not positive) → 400 VALIDATION_ERROR", async () => {
    const app = buildApp({});
    const res = await app.handle(
      req("/api/docs/doc-one/link", { method: "PUT", body: JSON.stringify({ viewLimit: 0 }) }),
    );
    expect(res.status).toBe(400);
  });
});
