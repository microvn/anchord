// In-process route tests for the render-publish POST /api/docs mount (no DB).
//
// These exercise the HTTP GLUE only — envelope + auth gate + Zod validation +
// PublishRejected→DomainError mapping — via app.handle(Request)→Response (no port,
// no Postgres). A fake DocRepo is injected so the route→service path runs without
// a DB; the real-Postgres path is covered by test/integration/docs-routes.itest.ts.
//
// AS map (render-publish S-001 / api-core):
//   AS-001  valid publish → 201 { docId, slug, url } in the success envelope.
//   AS-004  over-cap artifact → 413 PAYLOAD_TOO_LARGE.
//   AS-005  declared/sniffed type mismatch → 400 VALIDATION_ERROR.
//   AS-014  empty content → 400 VALIDATION_ERROR.
//   (gate)  no session → 401 UNAUTHENTICATED; bad body shape → 400.

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { DocRepo } from "../../src/publish/service";
import type { SessionResolver, WorkspaceRoleResolver } from "../../src/http/auth-gate";
import { MAX_TEXT_BYTES } from "../../src/publish/sniff";
import type { DocDeleteRepo } from "../../src/workspace/doc-delete";
import type { ActivityRepo, NewActivity } from "../../src/activity/repo";
import type { Role } from "../../src/sharing/roles";

// Every signed-in actor is a member of the path workspace (the gate proves membership).
const asMember: WorkspaceRoleResolver = async () => "member";
const member: SessionResolver = async () => ({ userId: "u_member" });
const noSession: SessionResolver = async () => null;
// A better-auth-shaped TEXT id (NOT a uuid) — proves owner_id/published_by accept
// it (C-007). A uuid-typed column would reject this at the DB layer.
const ownerA: SessionResolver = async () => ({ userId: "u_abc123" });

/** A DocRepo that records the last create and returns a fixed id (no DB). */
function fakeRepo(): DocRepo & { last?: unknown } {
  const r: DocRepo & { last?: unknown } = {
    async createDocWithV1(input) {
      r.last = input;
      return { id: "doc_fake_1" };
    },
  };
  return r;
}

function buildApp(opts: { resolveSession: SessionResolver; repo?: DocRepo }) {
  return createApp({
    dbCheck: async () => {},
    docs: {
      repo: opts.repo ?? fakeRepo(),
      resolveSession: opts.resolveSession,
      resolveWorkspaceRole: asMember,
    },
  });
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/w/ws_1/docs", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/docs route glue", () => {
  test("AS-001: valid markdown publish → 201 with { docId, slug, url } in envelope", async () => {
    const repo = fakeRepo();
    const app = buildApp({ resolveSession: member, repo });
    const res = await app.handle(post({ content: "# Hello world\n\nbody" }));

    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.statusCode).toBe(201);
    expect(json.data.docId).toBe("doc_fake_1");
    expect(typeof json.data.slug).toBe("string");
    expect(json.data.url).toBe(`/d/${json.data.slug}`);
    // service was actually called with the sniffed kind persisted
    expect((repo as any).last.kind).toBe("markdown");
  });

  test("AS-001: title override is honoured by the service", async () => {
    const repo = fakeRepo();
    const app = buildApp({ resolveSession: member, repo });
    const res = await app.handle(post({ content: "# Auto", title: "My Override" }));
    expect(res.status).toBe(201);
    expect((repo as any).last.title).toBe("My Override");
  });

  test("no session → 401 UNAUTHENTICATED (handler never runs)", async () => {
    const repo = fakeRepo();
    const app = buildApp({ resolveSession: noSession, repo });
    const res = await app.handle(post({ content: "# hi" }));
    expect(res.status).toBe(401);
    const json = (await res.json()) as any;
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("UNAUTHENTICATED");
    expect((repo as any).last).toBeUndefined();
  });

  test("bad body shape (missing content) → 400 VALIDATION_ERROR", async () => {
    const app = buildApp({ resolveSession: member });
    const res = await app.handle(post({ title: "no content" }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(json.error.field).toBe("content");
  });

  test("AS-014: empty content → 400 VALIDATION_ERROR", async () => {
    const app = buildApp({ resolveSession: member });
    const res = await app.handle(post({ content: "" }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(json.error.message).toMatch(/empty/i);
  });

  test("AS-005: type mismatch (declared image, text bytes) → 400 VALIDATION_ERROR", async () => {
    const app = buildApp({ resolveSession: member });
    const res = await app.handle(post({ content: "just text", kind: "image" }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  test("AS-004: over-cap content → 413 PAYLOAD_TOO_LARGE", async () => {
    const app = buildApp({ resolveSession: member });
    const big = "a".repeat(MAX_TEXT_BYTES + 1); // 1 byte over the 5MB text cap
    const res = await app.handle(post({ content: big }));
    expect(res.status).toBe(413);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  test("unknown body fields are stripped (never reach the service)", async () => {
    const repo = fakeRepo();
    const app = buildApp({ resolveSession: member, repo });
    const res = await app.handle(post({ content: "# ok", isAdmin: true, extra: 1 } as any));
    expect(res.status).toBe(201);
    // service only ever saw schema fields; the create input has no forged keys
    expect((repo as any).last).not.toHaveProperty("isAdmin");
  });

  // ── auth-routes S-001: ownership recorded at publish ──────────────────────

  test("AS-001: a signed-in publish records the publisher as the doc owner AND v1 publisher", async () => {
    const repo = fakeRepo();
    const app = buildApp({ resolveSession: ownerA, repo });
    const res = await app.handle(post({ content: "# Owned doc" }));
    expect(res.status).toBe(201);
    // The create input carries the SERVER-resolved session user as ownerId — the
    // repo writes it to BOTH docs.owner_id and doc_versions.published_by (asserted
    // on a real DB in the integration test). Here we assert the route threaded the
    // actor through to the service create-input.
    expect((repo as any).last.ownerId).toBe("u_abc123");
  });

  test("AS-001: the recorded owner is the SESSION user, never a body-supplied userId", async () => {
    const repo = fakeRepo();
    const app = buildApp({ resolveSession: ownerA, repo });
    // A forged ownerId/userId in the body must be ignored — identity is server-only.
    const res = await app.handle(
      post({ content: "# forge", ownerId: "u_attacker", userId: "u_attacker" } as any),
    );
    expect(res.status).toBe(201);
    expect((repo as any).last.ownerId).toBe("u_abc123"); // session, not body
  });

  test("C-007: owner is a better-auth TEXT id (e.g. \"u_abc123\"), not a uuid", async () => {
    const repo = fakeRepo();
    const app = buildApp({ resolveSession: ownerA, repo });
    await app.handle(post({ content: "# text id" }));
    const recorded = (repo as any).last.ownerId as string;
    // Non-uuid shape: a uuid-typed column would reject this; text accepts it.
    expect(recorded).toBe("u_abc123");
    expect(recorded).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  test("AS-002 / C-002: a publish with no session is refused (401) and creates nothing", async () => {
    const repo = fakeRepo();
    const app = buildApp({ resolveSession: noSession, repo });
    const res = await app.handle(post({ content: "# no session" }));
    expect(res.status).toBe(401);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("UNAUTHENTICATED");
    // Nothing reached the repo → no doc and no owner created.
    expect((repo as any).last).toBeUndefined();
  });

  test("C-001: publishDoc exposes no owner-mutation path (owner immutable in v0)", async () => {
    // C-001 immutability is structural: the service surface only creates (ownerId
    // is a create-input field), there is no updateOwner/transferOwner export. Guard
    // against a future regression that adds one.
    const svc = await import("../../src/publish/service");
    const mutators = Object.keys(svc).filter((k) => /owner|transfer/i.test(k));
    expect(mutators).toEqual([]);
  });
});

// ── doc-delete-trash S-001: DELETE /api/w/:workspaceId/docs/:slug ─────────────
//
// In-process route tests for the soft-delete route (no DB). The gate is the composed
// (per-doc role ∈ {owner,editor}) OR (workspace admin) — C-003 — and idempotency is the
// conditional UPDATE returning a row count (C-006). A fake DocDeleteRepo models one doc's
// tombstone state so a double-delete returns 0-changed (no second emit). C-001 preservation
// is STRUCTURAL: the repo surface has no annotation/version removal method — soft-delete only
// writes the tombstone — so the 8 annotations + 2 versions of AS-001 are necessarily kept.
//
// AS map: AS-001 owner delete (tombstone + preservation), AS-002 editor delete, AS-003 admin
// delete, AS-004 commenter refused, AS-005 doc_deleted logged, AS-021 admin-no-per-doc-role,
// AS-022 idempotent double-delete (one tombstone + one activity row).

/** A DocDeleteRepo over an in-memory doc with a tombstone, recording every softDelete call. */
function fakeDeleteRepo(opts?: {
  slug?: string;
  docId?: string;
  workspaceId?: string | null;
}): DocDeleteRepo & {
  tombstonedAt?: Date;
  tombstoneWorkspaceId?: string;
  softDeleteCalls: number;
} {
  const slug = opts?.slug ?? "spec-v1-abc";
  const docId = opts?.docId ?? "doc_del_1";
  const workspaceId = opts?.workspaceId === undefined ? "ws_1" : opts.workspaceId;
  const r: DocDeleteRepo & {
    tombstonedAt?: Date;
    tombstoneWorkspaceId?: string;
    softDeleteCalls: number;
  } = {
    softDeleteCalls: 0,
    async findDocBySlug(s) {
      return s === slug ? { id: docId, slug } : null;
    },
    async workspaceOfDoc() {
      return workspaceId;
    },
    async softDelete(_docId, deletedAt, deletedWorkspaceId) {
      r.softDeleteCalls += 1;
      // Conditional tombstone (C-006): only an ACTIVE doc changes a row. A second call on an
      // already-tombstoned doc changes 0 rows.
      if (r.tombstonedAt) return 0;
      r.tombstonedAt = deletedAt;
      r.tombstoneWorkspaceId = deletedWorkspaceId;
      return 1;
    },
    // S-003 restore/Trash ports — unused by the S-001 DELETE tests (stubs to satisfy the port).
    async listTrash() {
      return [];
    },
    async findDeletedById() {
      return null;
    },
    async restore() {
      return 0;
    },
    async resetShareAxesPrivate() {},
    async ensureDefaultProject() {
      return "proj_default";
    },
    async projectExists() {
      return true;
    },
    async purgeDeleted() {
      return 0;
    },
  };
  return r;
}

/** An ActivityRepo that records every appended row (read side is unused here). */
function recordingActivityRepo(): ActivityRepo & { rows: NewActivity[] } {
  const rows: NewActivity[] = [];
  return {
    rows,
    async insertActivity(row) {
      rows.push(row);
      return { id: `act_${rows.length}` };
    },
    async countActivity() {
      return rows.length;
    },
    async listActivity() {
      return [];
    },
    async listAllActivity() {
      return [];
    },
    async getActivityById() {
      return null;
    },
    async listRelatedByDoc() {
      return [];
    },
  };
}

function buildDeleteApp(opts: {
  resolveSession: SessionResolver;
  resolveWorkspaceRole?: WorkspaceRoleResolver;
  deleteRepo: DocDeleteRepo;
  resolveDocRole: (docId: string, userId: string) => Promise<Role | null>;
  isWorkspaceAdmin?: (workspaceId: string, userId: string) => boolean | Promise<boolean>;
  activityRepo?: ActivityRepo;
}) {
  return createApp({
    dbCheck: async () => {},
    docs: {
      repo: fakeRepo(),
      deleteRepo: opts.deleteRepo,
      resolveSession: opts.resolveSession,
      resolveWorkspaceRole: opts.resolveWorkspaceRole ?? asMember,
      resolveDocRole: opts.resolveDocRole,
      isWorkspaceAdmin: opts.isWorkspaceAdmin,
      deleteActivity: opts.activityRepo
        ? { repo: opts.activityRepo, resolveActorName: async () => "Mai" }
        : undefined,
    },
  });
}

function del(slug: string, headers: Record<string, string> = {}) {
  return new Request(`http://localhost/api/w/ws_1/docs/${slug}`, {
    method: "DELETE",
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("DELETE /api/w/:workspaceId/docs/:slug — soft-delete into Trash", () => {
  const owner: SessionResolver = async () => ({ userId: "u_mai" });

  test("AS-001: owner deletes a doc → tombstoned, leaves grid; annotations + versions preserved", async () => {
    const repo = fakeDeleteRepo();
    const app = buildDeleteApp({
      resolveSession: owner,
      deleteRepo: repo,
      // The owner's effective per-doc role is `owner`.
      resolveDocRole: async () => "owner",
    });
    const res = await app.handle(del("spec-v1-abc"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.data.deleted).toBe(true);
    expect(json.data.docId).toBe("doc_del_1");
    // Tombstoned: deleted_at captured, deleted_workspace_id captured (C-005).
    expect(repo.tombstonedAt).toBeInstanceOf(Date);
    expect(repo.tombstoneWorkspaceId).toBe("ws_1");
    // C-001 preservation is STRUCTURAL: the SOFT-DELETE path never removes annotations/versions —
    // its only write is the tombstone — so a doc's 8 annotations + 2 versions are necessarily kept.
    // Guard against a regression that lets soft-delete clear them. (S-007's purgeDeleted is the
    // deliberate permanent-delete escape hatch, NOT on the soft-delete path, so it is excluded.)
    const repoMethods = Object.keys(repo).filter((k) => !/^purge/i.test(k));
    expect(repoMethods.some((k) => /annotation|version|comment|hardDelete|remove/i.test(k))).toBe(
      false,
    );
  });

  test("AS-002: a per-doc editor (not owner) can delete → tombstoned", async () => {
    const repo = fakeDeleteRepo();
    const app = buildDeleteApp({
      resolveSession: async () => ({ userId: "u_lan" }),
      deleteRepo: repo,
      resolveDocRole: async () => "editor", // editor carries `edit` capability → admitted
    });
    const res = await app.handle(del("spec-v1-abc"));
    expect(res.status).toBe(200);
    expect(repo.tombstonedAt).toBeInstanceOf(Date);
  });

  test("AS-003: a workspace admin (not owner, not per-doc editor) can delete → tombstoned", async () => {
    const repo = fakeDeleteRepo();
    const app = buildDeleteApp({
      resolveSession: async () => ({ userId: "u_huy" }),
      deleteRepo: repo,
      // Huy holds only a commenter per-doc role, but is a workspace admin → the admin arm admits.
      resolveDocRole: async () => "commenter",
      isWorkspaceAdmin: async () => true,
    });
    const res = await app.handle(del("spec-v1-abc"));
    expect(res.status).toBe(200);
    expect(repo.tombstonedAt).toBeInstanceOf(Date);
  });

  test("C-007: an admin of the PATH workspace cannot delete a doc that lives in ANOTHER workspace (cross-tenant bind)", async () => {
    // The slug lookup is global; the doc resolves to workspace ws_OTHER while the request targets
    // /api/w/ws_1/... and the caller is an admin of ws_1 with NO per-doc role. Without the workspace
    // bind, the admin arm would admit and tombstone a foreign-workspace doc. The bind makes the doc
    // indistinguishable from a non-existent one → 404, no tombstone.
    const repo = fakeDeleteRepo({ workspaceId: "ws_OTHER" });
    const app = buildDeleteApp({
      resolveSession: async () => ({ userId: "u_huy" }),
      deleteRepo: repo,
      resolveDocRole: async () => null, // not a member of the doc's own workspace
      isWorkspaceAdmin: async () => true, // admin of the PATH workspace (ws_1)
    });
    const res = await app.handle(del("spec-v1-abc"));
    expect(res.status).toBe(404);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("NOT_FOUND");
    // No tombstone — the foreign doc is untouched.
    expect(repo.tombstonedAt).toBeUndefined();
    expect(repo.softDeleteCalls).toBe(0);
  });

  test("AS-004: a commenter is refused → 403 insufficient permission; doc stays active", async () => {
    const repo = fakeDeleteRepo();
    const app = buildDeleteApp({
      resolveSession: async () => ({ userId: "u_nam" }),
      deleteRepo: repo,
      resolveDocRole: async () => "commenter", // no `edit` capability
      isWorkspaceAdmin: async () => false, // and not an admin
    });
    const res = await app.handle(del("spec-v1-abc"));
    expect(res.status).toBe(403);
    const json = (await res.json()) as any;
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("FORBIDDEN");
    expect(json.error.message).toMatch(/insufficient permission/i);
    // The doc stays ACTIVE — no tombstone written.
    expect(repo.tombstonedAt).toBeUndefined();
  });

  test("AS-005: a successful delete logs ONE doc_deleted activity with the actor + the doc as subject", async () => {
    const repo = fakeDeleteRepo();
    const activity = recordingActivityRepo();
    const app = buildDeleteApp({
      resolveSession: owner,
      deleteRepo: repo,
      resolveDocRole: async () => "owner",
      activityRepo: activity,
    });
    const res = await app.handle(del("spec-v1-abc"));
    expect(res.status).toBe(200);
    expect(activity.rows).toHaveLength(1);
    const row = activity.rows[0]!;
    expect(row.type).toBe("doc_deleted");
    expect(row.actorUserId).toBe("u_mai");
    expect(row.docId).toBe("doc_del_1");
    expect(row.workspaceId).toBe("ws_1");
  });

  test("AS-021: a workspace admin whose per-doc role is null → admitted via the workspace-admin arm", async () => {
    const repo = fakeDeleteRepo();
    const app = buildDeleteApp({
      resolveSession: async () => ({ userId: "u_huy" }),
      deleteRepo: repo,
      // resolveAccess returns null (neither owner, invited, nor workspace-axis shared)…
      resolveDocRole: async () => null,
      // …but Huy is a workspace admin → the admin arm of the composed gate admits him.
      isWorkspaceAdmin: async () => true,
    });
    const res = await app.handle(del("spec-v1-abc"));
    expect(res.status).toBe(200);
    expect(repo.tombstonedAt).toBeInstanceOf(Date);
  });

  test("AS-022: double-delete is idempotent — one tombstone, one doc_deleted activity row", async () => {
    const repo = fakeDeleteRepo();
    const activity = recordingActivityRepo();
    const app = buildDeleteApp({
      resolveSession: owner,
      deleteRepo: repo,
      resolveDocRole: async () => "owner",
      activityRepo: activity,
    });

    const first = await app.handle(del("spec-v1-abc"));
    expect(first.status).toBe(200);
    const firstAt = repo.tombstonedAt;

    // Second delete (double-click / retry): the conditional UPDATE changes 0 rows.
    const second = await app.handle(del("spec-v1-abc"));
    expect(second.status).toBe(200); // idempotent success, not an error

    // Exactly ONE tombstone: deleted_at was NOT overwritten by the second call.
    expect(repo.tombstonedAt).toBe(firstAt);
    // softDelete ran twice (both requests reached the conditional write)…
    expect(repo.softDeleteCalls).toBe(2);
    // …but exactly ONE doc_deleted activity row exists (emit only when a row changed — C-006).
    expect(activity.rows).toHaveLength(1);
    expect(activity.rows[0]!.type).toBe("doc_deleted");
  });

  test("a missing / inaccessible doc → 404 (existence-hiding)", async () => {
    const repo = fakeDeleteRepo();
    const app = buildDeleteApp({
      resolveSession: owner,
      deleteRepo: repo,
      resolveDocRole: async () => "owner",
    });
    const res = await app.handle(del("no-such-slug"));
    expect(res.status).toBe(404);
    expect(repo.tombstonedAt).toBeUndefined();
  });

  test("no session → 401 (handler never runs, nothing tombstoned)", async () => {
    const repo = fakeDeleteRepo();
    const app = buildDeleteApp({
      resolveSession: noSession,
      deleteRepo: repo,
      resolveDocRole: async () => "owner",
    });
    const res = await app.handle(del("spec-v1-abc"));
    expect(res.status).toBe(401);
    expect(repo.tombstonedAt).toBeUndefined();
  });
});

// ── doc-delete-trash S-003: Trash list + restore ──────────────────────────────────────────────
//
// In-process route tests for GET /api/w/:workspaceId/trash and POST .../docs/:id/restore (no DB).
// A fake restore repo models a workspace-scoped Trash + per-doc share axes + project existence, so:
//   - C-007 scoping: a doc in another workspace's Trash is unreachable (findDeletedById scopes on
//     deleted_workspace_id) → 404 / absent from the list.
//   - C-004 fallback: when the original project is gone OR project_id is null, restore targets the
//     RESTORING actor's default project (ensureDefaultProject), recorded with the restorer's id.
//   - C-008 private-on-restore: resetShareAxesPrivate is invoked → both axes null + token rotated.
//   - C-006 idempotency: restore returns rows-changed; an already-active doc changes 0 rows → no
//     doc_restored emit (AS-027).
//
// AS map: AS-010 restore→original project (data intact), AS-011 fallback→restorer default,
// AS-012 doc_restored logged, AS-013 empty Trash, AS-020 commenter refused, AS-023 private+rotated,
// AS-024 owner+project gone → restorer default, AS-025 cross-workspace refused, AS-026 list scoped,
// AS-027 idempotent no-op.

interface TrashDoc {
  id: string;
  slug: string;
  title: string;
  workspaceId: string; // deleted_workspace_id
  deletedAt: Date | null; // null = active (the AS-027 stale-active case)
  projectId: string | null;
  ownerId: string | null;
}

/** A restore/Trash repo over an in-memory set of (possibly deleted) docs across workspaces. */
function fakeRestoreRepo(opts: {
  docs: TrashDoc[];
  /** Project ids that still exist, keyed "ws:project". A project not listed has been deleted. */
  existingProjects?: Set<string>;
}): DocDeleteRepo & {
  restoreCalls: number;
  resetCalls: number;
  ensureDefaultCalls: { workspaceId: string; ownerId: string; userName: string }[];
  lastRestoredProjectId?: string;
  purgeCalls: { workspaceId: string; docId: string }[];
} {
  const existing = opts.existingProjects ?? new Set<string>();
  const r: DocDeleteRepo & {
    restoreCalls: number;
    resetCalls: number;
    ensureDefaultCalls: { workspaceId: string; ownerId: string; userName: string }[];
    lastRestoredProjectId?: string;
    purgeCalls: { workspaceId: string; docId: string }[];
  } = {
    restoreCalls: 0,
    resetCalls: 0,
    ensureDefaultCalls: [],
    purgeCalls: [],
    // Unused S-001 delete ports (stubs).
    async findDocBySlug() {
      return null;
    },
    async workspaceOfDoc() {
      return null;
    },
    async softDelete() {
      return 0;
    },
    async listTrash(workspaceId) {
      // C-007: only THIS workspace's tombstones (AS-026).
      return opts.docs
        .filter((d) => d.deletedAt != null && d.workspaceId === workspaceId)
        .map((d) => ({
          id: d.id,
          slug: d.slug,
          title: d.title,
          deletedAt: d.deletedAt!,
          ownerId: d.ownerId,
        }));
    },
    async findDeletedById(workspaceId, docId) {
      // C-007: a DELETED doc in THIS workspace's Trash only (AS-025).
      const d = opts.docs.find(
        (x) => x.id === docId && x.deletedAt != null && x.workspaceId === workspaceId,
      );
      if (!d) return null;
      return {
        id: d.id,
        slug: d.slug,
        projectId: d.projectId,
        ownerId: d.ownerId,
        deletedWorkspaceId: d.workspaceId,
      };
    },
    async restore(docId, targetProjectId) {
      r.restoreCalls += 1;
      const d = opts.docs.find((x) => x.id === docId);
      // C-006: only a DELETED doc changes a row.
      if (!d || d.deletedAt == null) return 0;
      d.deletedAt = null;
      d.projectId = targetProjectId;
      r.lastRestoredProjectId = targetProjectId;
      return 1;
    },
    async resetShareAxesPrivate() {
      r.resetCalls += 1;
    },
    async ensureDefaultProject(input) {
      r.ensureDefaultCalls.push(input);
      return `default:${input.workspaceId}:${input.ownerId}`;
    },
    async projectExists(workspaceId, projectId) {
      return existing.has(`${workspaceId}:${projectId}`);
    },
    async purgeDeleted(workspaceId, docId) {
      r.purgeCalls.push({ workspaceId, docId });
      // C-007: only a DELETED doc in THIS workspace is purgeable. Hard-remove it from the set so a
      // subsequent listTrash no longer returns it (gone + unrecoverable).
      const idx = opts.docs.findIndex(
        (x) => x.id === docId && x.deletedAt != null && x.workspaceId === workspaceId,
      );
      if (idx === -1) return 0;
      opts.docs.splice(idx, 1);
      return 1;
    },
  };
  return r;
}

function buildRestoreApp(opts: {
  resolveSession: SessionResolver;
  resolveWorkspaceRole?: WorkspaceRoleResolver;
  deleteRepo: DocDeleteRepo;
  resolveDocRole: (docId: string, userId: string) => Promise<Role | null>;
  isWorkspaceAdmin?: (workspaceId: string, userId: string) => boolean | Promise<boolean>;
  activityRepo?: ActivityRepo;
  actorName?: string;
}) {
  return createApp({
    dbCheck: async () => {},
    docs: {
      repo: fakeRepo(),
      deleteRepo: opts.deleteRepo,
      resolveSession: opts.resolveSession,
      resolveWorkspaceRole: opts.resolveWorkspaceRole ?? asMember,
      resolveDocRole: opts.resolveDocRole,
      isWorkspaceAdmin: opts.isWorkspaceAdmin,
      // Both doc_deleted and doc_restored route through this one activity block.
      deleteActivity:
        opts.activityRepo || opts.actorName
          ? {
              repo: opts.activityRepo,
              resolveActorName: async () => opts.actorName ?? "Mai",
            }
          : undefined,
    },
  });
}

function getTrash(workspaceId: string) {
  return new Request(`http://localhost/api/w/${workspaceId}/trash`, { method: "GET" });
}
function restore(workspaceId: string, docId: string) {
  return new Request(`http://localhost/api/w/${workspaceId}/trash/${docId}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
}
function permanent(workspaceId: string, docId: string) {
  return new Request(`http://localhost/api/w/${workspaceId}/trash/${docId}/permanent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
}

describe("GET /api/w/:workspaceId/trash + POST .../docs/:id/restore — Trash list + restore", () => {
  const mai: SessionResolver = async () => ({ userId: "u_mai" });

  test("AS-010: owner restores → doc returns to its original project; data intact (lossless)", async () => {
    const repo = fakeRestoreRepo({
      docs: [
        {
          id: "doc_spec",
          slug: "spec-v1-abc",
          title: "Spec v1",
          workspaceId: "ws_1",
          deletedAt: new Date(),
          projectId: "proj_billing",
          ownerId: "u_mai",
        },
      ],
      // "Billing" still exists → restore targets the ORIGINAL project, not the fallback.
      existingProjects: new Set(["ws_1:proj_billing"]),
    });
    const app = buildRestoreApp({
      resolveSession: mai,
      deleteRepo: repo,
      resolveDocRole: async () => "owner",
    });
    const res = await app.handle(restore("ws_1", "doc_spec"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.restored).toBe(true);
    expect(json.data.docId).toBe("doc_spec");
    // Returned to its ORIGINAL project (no fallback used).
    expect(json.data.projectId).toBe("proj_billing");
    expect(repo.ensureDefaultCalls).toHaveLength(0);
    // C-001 lossless is STRUCTURAL: RESTORE never clears annotations/versions/comments — it only
    // un-tombstones + reparents + resets axes — so the 8 annotations + 2 versions are necessarily
    // kept. Guard against a regression that lets the RESTORE path clear them. (S-007's purgeDeleted
    // is the deliberate permanent-delete escape hatch and is excluded — it is NOT on the restore path.)
    const methods = Object.keys(repo).filter((k) => !/^purge/i.test(k));
    expect(methods.some((k) => /annotation|version|comment|clearAnno/i.test(k))).toBe(false);
  });

  test("AS-011: original project gone → restore falls back to the RESTORING actor's default project", async () => {
    const repo = fakeRestoreRepo({
      docs: [
        {
          id: "doc_orphan",
          slug: "orphan-abc",
          title: "Orphan",
          workspaceId: "ws_1",
          deletedAt: new Date(),
          projectId: "proj_gone", // the original project no longer exists…
          ownerId: "u_owner_other",
        },
      ],
      existingProjects: new Set(), // …projectExists → false → fallback path
    });
    // The RESTORER is Lan (a per-doc editor), NOT the original owner.
    const app = buildRestoreApp({
      resolveSession: async () => ({ userId: "u_lan" }),
      deleteRepo: repo,
      resolveDocRole: async () => "editor",
    });
    const res = await app.handle(restore("ws_1", "doc_orphan"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    // ensureDefaultProject was called with the RESTORER's id (Lan), in the doc's workspace.
    expect(repo.ensureDefaultCalls).toEqual([
      { workspaceId: "ws_1", ownerId: "u_lan", userName: expect.any(String) },
    ]);
    expect(json.data.projectId).toBe("default:ws_1:u_lan");
  });

  test("AS-012: a successful restore logs ONE doc_restored activity with the actor + the doc", async () => {
    const repo = fakeRestoreRepo({
      docs: [
        {
          id: "doc_spec",
          slug: "spec-v1-abc",
          title: "Spec v1",
          workspaceId: "ws_1",
          deletedAt: new Date(),
          projectId: "proj_billing",
          ownerId: "u_mai",
        },
      ],
      existingProjects: new Set(["ws_1:proj_billing"]),
    });
    const activity = recordingActivityRepo();
    const app = buildRestoreApp({
      resolveSession: mai,
      deleteRepo: repo,
      resolveDocRole: async () => "owner",
      activityRepo: activity,
    });
    const res = await app.handle(restore("ws_1", "doc_spec"));
    expect(res.status).toBe(200);
    expect(activity.rows).toHaveLength(1);
    const row = activity.rows[0]!;
    expect(row.type).toBe("doc_restored");
    expect(row.actorUserId).toBe("u_mai");
    expect(row.docId).toBe("doc_spec");
    expect(row.workspaceId).toBe("ws_1");
  });

  test("AS-013: empty Trash → empty list (the empty-state source)", async () => {
    const repo = fakeRestoreRepo({ docs: [] });
    const app = buildRestoreApp({
      resolveSession: mai,
      deleteRepo: repo,
      resolveDocRole: async () => "owner",
    });
    const res = await app.handle(getTrash("ws_1"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.docs).toEqual([]);
  });

  test("AS-020: a commenter is refused restore → 403; the doc stays in Trash", async () => {
    const repo = fakeRestoreRepo({
      docs: [
        {
          id: "doc_spec",
          slug: "spec-v1-abc",
          title: "Spec v1",
          workspaceId: "ws_1",
          deletedAt: new Date(),
          projectId: "proj_billing",
          ownerId: "u_mai",
        },
      ],
      existingProjects: new Set(["ws_1:proj_billing"]),
    });
    const app = buildRestoreApp({
      resolveSession: async () => ({ userId: "u_nam" }),
      deleteRepo: repo,
      resolveDocRole: async () => "commenter", // no edit capability
      isWorkspaceAdmin: async () => false, // and not an admin
    });
    const res = await app.handle(restore("ws_1", "doc_spec"));
    expect(res.status).toBe(403);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("FORBIDDEN");
    expect(json.error.message).toMatch(/insufficient permission/i);
    // The doc stays in Trash — no un-tombstone, no axis reset.
    expect(repo.restoreCalls).toBe(0);
    expect(repo.resetCalls).toBe(0);
    const stillDeleted = (await (await app.handle(getTrash("ws_1"))).json()) as any;
    expect(stillDeleted.data.docs).toHaveLength(1);
  });

  test("AS-023: restore comes back PRIVATE — both axes reset + capability token rotated", async () => {
    // The doc was anyone-with-link (link_role=commenter) before delete. After restore the route
    // MUST invoke resetShareAxesPrivate (both axes null + token rotated) so the old /s/<token> dies.
    const repo = fakeRestoreRepo({
      docs: [
        {
          id: "doc_pub",
          slug: "public-abc",
          title: "Public Spec",
          workspaceId: "ws_1",
          deletedAt: new Date(),
          projectId: "proj_billing",
          ownerId: "u_mai",
        },
      ],
      existingProjects: new Set(["ws_1:proj_billing"]),
    });
    const app = buildRestoreApp({
      resolveSession: mai,
      deleteRepo: repo,
      resolveDocRole: async () => "owner",
    });
    const res = await app.handle(restore("ws_1", "doc_pub"));
    expect(res.status).toBe(200);
    // resetShareAxesPrivate fired exactly once on the un-tombstone (C-008).
    expect(repo.resetCalls).toBe(1);
    expect(repo.restoreCalls).toBe(1);
  });

  test("AS-024: owner removed (owner_id null) AND original project deleted → lands in admin's default, no orphan", async () => {
    const repo = fakeRestoreRepo({
      docs: [
        {
          id: "doc_orphan2",
          slug: "orphan2-abc",
          title: "Orphan 2",
          workspaceId: "ws_1",
          deletedAt: new Date(),
          projectId: null, // original project deleted (set null)
          ownerId: null, // owner was removed
        },
      ],
      existingProjects: new Set(),
    });
    // Admin Huy restores (no per-doc role → admitted via the admin arm).
    const app = buildRestoreApp({
      resolveSession: async () => ({ userId: "u_huy" }),
      deleteRepo: repo,
      resolveDocRole: async () => null,
      isWorkspaceAdmin: async () => true,
    });
    const res = await app.handle(restore("ws_1", "doc_orphan2"));
    expect(res.status).toBe(200); // no 500, no orphan
    const json = (await res.json()) as any;
    // Lands in HUY's default project in ws_1.
    expect(json.data.projectId).toBe("default:ws_1:u_huy");
    expect(repo.ensureDefaultCalls).toEqual([
      { workspaceId: "ws_1", ownerId: "u_huy", userName: expect.any(String) },
    ]);
  });

  test("AS-025: cross-workspace restore is refused as not-found; the Y doc stays in Y's Trash", async () => {
    // The deleted doc lives in workspace Y; Huy (admin of X) issues restore through X's route.
    const repo = fakeRestoreRepo({
      docs: [
        {
          id: "doc_y",
          slug: "y-doc-abc",
          title: "Y doc",
          workspaceId: "ws_Y",
          deletedAt: new Date(),
          projectId: "proj_y",
          ownerId: "u_someone",
        },
      ],
      existingProjects: new Set(["ws_Y:proj_y"]),
    });
    const app = buildRestoreApp({
      resolveSession: async () => ({ userId: "u_huy" }),
      deleteRepo: repo,
      resolveDocRole: async () => "owner",
      isWorkspaceAdmin: async () => true, // admin of X, but the doc is in Y
    });
    // Restore through X's route — findDeletedById("ws_X", …) finds nothing → 404.
    const res = await app.handle(restore("ws_X", "doc_y"));
    expect(res.status).toBe(404);
    expect(repo.restoreCalls).toBe(0);
    // The Y doc is untouched — still in Y's Trash.
    const yTrash = (await (await app.handle(getTrash("ws_Y"))).json()) as any;
    expect(yTrash.data.docs).toHaveLength(1);
    expect(yTrash.data.docs[0].id).toBe("doc_y");
  });

  test("AS-026: the Trash list never includes another workspace's deleted docs", async () => {
    // X has 1 deleted doc, Y has 2; the caller is a member of both.
    const repo = fakeRestoreRepo({
      docs: [
        { id: "x1", slug: "x1", title: "X one", workspaceId: "ws_X", deletedAt: new Date(), projectId: null, ownerId: "u_mai" },
        { id: "y1", slug: "y1", title: "Y one", workspaceId: "ws_Y", deletedAt: new Date(), projectId: null, ownerId: "u_mai" },
        { id: "y2", slug: "y2", title: "Y two", workspaceId: "ws_Y", deletedAt: new Date(), projectId: null, ownerId: "u_mai" },
      ],
    });
    const app = buildRestoreApp({
      resolveSession: mai,
      deleteRepo: repo,
      resolveDocRole: async () => "owner",
    });
    const res = await app.handle(getTrash("ws_X"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    // Only X's 1 deleted doc; Y's 2 are absent.
    expect(json.data.docs).toHaveLength(1);
    expect(json.data.docs[0].id).toBe("x1");
  });

  test("AS-027: restore is idempotent — restoring an already-active doc is a no-op, no doc_restored", async () => {
    const repo = fakeRestoreRepo({
      docs: [
        {
          id: "doc_spec",
          slug: "spec-v1-abc",
          title: "Spec v1",
          workspaceId: "ws_1",
          deletedAt: new Date(),
          projectId: "proj_billing",
          ownerId: "u_mai",
        },
      ],
      existingProjects: new Set(["ws_1:proj_billing"]),
    });
    const activity = recordingActivityRepo();
    const app = buildRestoreApp({
      resolveSession: mai,
      deleteRepo: repo,
      resolveDocRole: async () => "owner",
      activityRepo: activity,
    });

    const first = await app.handle(restore("ws_1", "doc_spec"));
    expect(first.status).toBe(200);
    expect(activity.rows).toHaveLength(1); // one doc_restored on the real un-tombstone

    // Second restore: the doc is now active. findDeletedById no longer finds it (deleted_at IS
    // NOT NULL filter) → 404, the existence-hiding shape for a stale Trash retry. No second emit.
    const second = await app.handle(restore("ws_1", "doc_spec"));
    expect(second.status).toBe(404);
    expect(activity.rows).toHaveLength(1); // still exactly one — no double-emit (C-006)
  });
});

// ── doc-delete-trash S-007: permanent (hard) delete from Trash ─────────────────────────────────
//
// In-process route tests for DELETE /api/w/:workspaceId/docs/:id/permanent (no DB). The purge gate
// is NARROWER than soft-delete/restore: OWNER-OR-ADMIN only (C-003 narrowed) — a per-doc EDITOR is
// refused (AS-035), even though an editor CAN soft-delete/restore. Scoping is C-007 (findDeletedById
// + purgeDeleted both keyed on deleted_workspace_id; an active doc has deleted_at IS NULL so it is
// unreachable here). The fake repo's purgeDeleted REMOVES the doc from its in-memory Trash set, so a
// follow-up listTrash proves the doc is gone + unrecoverable. The actual cascade of versions/
// annotations/comments/share_links is FK on-delete-cascade in the schema and is asserted over real
// Postgres in test/integration/workspace-docs.itest.ts (AS-034 cascade) — here the route test proves
// the gate + scoping + that the purge runs.
//
// AS map: AS-034 owner/admin purge (gone + unrecoverable), AS-035 editor(non-owner)/commenter refused.

describe("DELETE /api/w/:workspaceId/docs/:id/permanent — permanent (hard) delete from Trash", () => {
  function deletedDoc(over?: Partial<TrashDoc>): TrashDoc {
    return {
      id: "doc_spec",
      slug: "spec-v1-abc",
      title: "Spec v1",
      workspaceId: "ws_1",
      deletedAt: new Date(),
      projectId: "proj_billing",
      ownerId: "u_mai",
      ...over,
    };
  }

  test("AS-034: owner permanently deletes a doc from Trash → purged, gone from Trash, unrecoverable", async () => {
    const repo = fakeRestoreRepo({ docs: [deletedDoc()] });
    const app = buildRestoreApp({
      resolveSession: async () => ({ userId: "u_mai" }), // the owner
      deleteRepo: repo,
      resolveDocRole: async () => "owner",
    });
    const res = await app.handle(permanent("ws_1", "doc_spec"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.purged).toBe(true);
    expect(json.data.docId).toBe("doc_spec");
    // The purge ran, scoped to the path workspace + doc id (C-007).
    expect(repo.purgeCalls).toEqual([{ workspaceId: "ws_1", docId: "doc_spec" }]);
    // Gone from Trash + unrecoverable: a follow-up Trash list no longer shows it, and a restore 404s.
    const trash = (await (await app.handle(getTrash("ws_1"))).json()) as any;
    expect(trash.data.docs).toEqual([]);
    const reRestore = await app.handle(restore("ws_1", "doc_spec"));
    expect(reRestore.status).toBe(404);
    // STRUCTURAL lossY guard: the doc is hard-removed via a single purgeDeleted call; the schema FKs
    // cascade versions/annotations/comments/share_links (asserted over real Postgres in the itest).
  });

  test("AS-034: a workspace ADMIN with no per-doc role permanently deletes a doc from Trash", async () => {
    const repo = fakeRestoreRepo({ docs: [deletedDoc({ ownerId: "u_someone_else" })] });
    const app = buildRestoreApp({
      resolveSession: async () => ({ userId: "u_huy" }),
      deleteRepo: repo,
      resolveDocRole: async () => null, // no per-doc grant…
      isWorkspaceAdmin: async () => true, // …admitted via the workspace-admin arm
    });
    const res = await app.handle(permanent("ws_1", "doc_spec"));
    expect(res.status).toBe(200);
    expect(repo.purgeCalls).toHaveLength(1);
  });

  test("AS-035: a per-doc EDITOR (non-owner) cannot permanently delete → 403; the doc stays in Trash", async () => {
    // The editor CAN soft-delete/restore, but permanent delete is owner-or-admin only — refused.
    const repo = fakeRestoreRepo({ docs: [deletedDoc({ ownerId: "u_someone_else" })] });
    const app = buildRestoreApp({
      resolveSession: async () => ({ userId: "u_lan" }),
      deleteRepo: repo,
      resolveDocRole: async () => "editor", // carries `edit` but is NOT owner
      isWorkspaceAdmin: async () => false, // and not an admin
    });
    const res = await app.handle(permanent("ws_1", "doc_spec"));
    expect(res.status).toBe(403);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("FORBIDDEN");
    expect(json.error.message).toMatch(/insufficient permission/i);
    // The doc stays in Trash — nothing purged.
    expect(repo.purgeCalls).toHaveLength(0);
    const trash = (await (await app.handle(getTrash("ws_1"))).json()) as any;
    expect(trash.data.docs).toHaveLength(1);
  });

  test("AS-035: a commenter cannot permanently delete → 403; the doc stays in Trash", async () => {
    const repo = fakeRestoreRepo({ docs: [deletedDoc({ ownerId: "u_someone_else" })] });
    const app = buildRestoreApp({
      resolveSession: async () => ({ userId: "u_nam" }),
      deleteRepo: repo,
      resolveDocRole: async () => "commenter",
      isWorkspaceAdmin: async () => false,
    });
    const res = await app.handle(permanent("ws_1", "doc_spec"));
    expect(res.status).toBe(403);
    expect(repo.purgeCalls).toHaveLength(0);
    const trash = (await (await app.handle(getTrash("ws_1"))).json()) as any;
    expect(trash.data.docs).toHaveLength(1);
  });

  test("AS-034: C-007 — purge through another workspace's route is refused as not-found", async () => {
    // The doc is in Y's Trash; the caller is admin of X. The X-scoped route can't reach it.
    const repo = fakeRestoreRepo({
      docs: [deletedDoc({ id: "doc_y", workspaceId: "ws_Y" })],
    });
    const app = buildRestoreApp({
      resolveSession: async () => ({ userId: "u_huy" }),
      deleteRepo: repo,
      resolveDocRole: async () => "owner",
      isWorkspaceAdmin: async () => true, // admin of X, but the doc lives in Y
    });
    const res = await app.handle(permanent("ws_X", "doc_y"));
    expect(res.status).toBe(404);
    expect(repo.purgeCalls).toHaveLength(0);
    // The Y doc is untouched — still in Y's Trash.
    const yTrash = (await (await app.handle(getTrash("ws_Y"))).json()) as any;
    expect(yTrash.data.docs).toHaveLength(1);
  });

  test("AS-034: an ACTIVE (not-in-Trash) doc cannot be purged via this route → 404", async () => {
    // deletedAt null = active. findDeletedById requires deleted_at IS NOT NULL → unreachable here.
    const repo = fakeRestoreRepo({ docs: [deletedDoc({ deletedAt: null })] });
    const app = buildRestoreApp({
      resolveSession: async () => ({ userId: "u_mai" }),
      deleteRepo: repo,
      resolveDocRole: async () => "owner",
    });
    const res = await app.handle(permanent("ws_1", "doc_spec"));
    expect(res.status).toBe(404);
    expect(repo.purgeCalls).toHaveLength(0);
  });
});
