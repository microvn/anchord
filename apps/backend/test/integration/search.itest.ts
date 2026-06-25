// Integration tier (guarded by RUN_INTEGRATION): workspace-project S-005 search over
// REAL Postgres — the FTS query + the SQL access filter the unit/route tests faked.
//
// Proves:
//   AS-009/C-003/H2 — A publishes "Payment Spec" (refund in CONTENT, anyone_in_workspace)
//     + a RESTRICTED doc "Secret Memo" whose only "refund" is in a COMMENT and which X
//     is NOT invited to. X searches "refund" → gets "Payment Spec" ONLY; the restricted
//     doc is fully ABSENT (no id/title/slug leaked) even though its comment matched.
//   C-006 — title / content / comment are each a match SOURCE that surfaces an
//     accessible doc.
//   AS-010 — project-scoped search returns only the accessible matches in that project.
//
// PRODUCTION FIDELITY: SAME createApp(deps) composition as src/index.ts (better-auth,
// the member-on-signup hook ensuring a default project, the gated /api/setup,
// /api/projects, /api/docs, AND /api/search wired to the real betterAuthSessionResolver
// + db-backed repos). The one divergence (per workspace-setup.itest.ts) is
// requireEmailVerification:false so sign-in issues a cookie in-process.
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/search.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { annotations, comments, docs, user as userTable } from "../../src/db/schema";
import { createApp } from "../../src/app";
import { appendVersion, restoreVersion } from "../../src/services/version";
import { createVersionRepo } from "../../src/services/version-repo";
import { betterAuthSessionResolver } from "../../src/http/auth-gate";
import { onUserCreated } from "../../src/auth/auth";
import { createProjectRepo } from "../../src/workspace/repo";
import { createTenancyRepo, createWorkspaceAccess } from "../../src/workspace/tenancy-repo";
import { withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;
const SECRET = "x".repeat(32);
const BASE_URL = "http://localhost";

function makeAuth(db: MigratedDb["db"]) {
  const tenancyRepo = createTenancyRepo(db);
  const projectRepo = createProjectRepo(db);
  return betterAuth({
    secret: SECRET,
    baseURL: BASE_URL,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: { enabled: true, requireEmailVerification: false, minPasswordLength: 8 },
    databaseHooks: {
      user: {
        create: {
          after: async (createdUser: { id: string }) => {
            await onUserCreated(createdUser.id, tenancyRepo, projectRepo);
          },
        },
      },
    },
  });
}

function authPost(path: string, body: unknown): Request {
  return new Request(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function setCookieToCookie(setCookie: string): string {
  return setCookie
    .split(/,(?=[^;]+=[^;]+)/)
    .map((c) => c.split(";")[0]!.trim())
    .join("; ");
}
function withCookie(path: string, cookie: string, method = "GET", body?: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new Request(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Insert an annotation + a comment carrying `body` on `docId` (the comment match source). */
async function addComment(db: MigratedDb["db"], docId: string, body: string) {
  const [an] = await db
    .insert(annotations)
    .values({ docId, type: "doc", anchor: {} })
    .returning({ id: annotations.id });
  await db.insert(comments).values({ annotationId: an!.id, body });
}

describe.skipIf(!RUN)("workspace-project S-005: search (real Postgres)", () => {
  let h: MigratedDb;
  let app: ReturnType<typeof createApp>;
  let A: { userId: string; cookie: string };
  let X: { userId: string; cookie: string };
  let WA = "";
  let billingId: string;

  async function signUpAndIn(email: string, name: string) {
    const password = "correct horse battery staple";
    const up = await app.handle(authPost("/api/auth/sign-up/email", { email, password, name }));
    expect(up.status).toBeLessThan(400);
    const inn = await app.handle(authPost("/api/auth/sign-in/email", { email, password }));
    expect(inn.status).toBeLessThan(400);
    const cookie = setCookieToCookie(inn.headers.get("set-cookie")!);
    const rows = await h.db.select().from(userTable).where(eq(userTable.email, email));
    return { userId: rows[0]!.id, cookie };
  }

  async function publish(cookie: string, body: Record<string, unknown>): Promise<string> {
    const pub = await app.handle(withCookie(`/api/w/${WA}/docs`, cookie, "POST", body));
    expect(pub.status).toBe(201);
    return ((await pub.json()) as any).data.docId;
  }

  async function searchAs(cookie: string, q: string, projectId?: string) {
    const qs = `q=${encodeURIComponent(q)}${projectId ? `&projectId=${projectId}` : ""}`;
    const res = await app.handle(withCookie(`/api/w/${WA}/search?${qs}`, cookie));
    expect(res.status).toBe(200);
    return (await res.json()) as any;
  }

  beforeAll(async () => {
    h = await withMigratedDb();
    const auth = makeAuth(h.db);
    const wsAccess = createWorkspaceAccess(h.db);
    const resolveWorkspaceRole = (wsId: string, userId: string) => wsAccess.workspaceRoleOf(wsId, userId);
    app = createApp({
      dbCheck: async () => {},
      authHandler: auth.handler,
      projects: { db: h.db, resolveSession: betterAuthSessionResolver(auth), resolveWorkspaceRole },
      docs: { db: h.db, resolveSession: betterAuthSessionResolver(auth), resolveWorkspaceRole },
      search: { db: h.db, resolveSession: betterAuthSessionResolver(auth), resolveWorkspaceRole },
    });

    A = await signUpAndIn(`s5a-${process.pid}@itest.local`, "Alice");
    const [waRow] = await h.db
      .select()
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, A.userId));
    WA = waRow!.workspaceId;

    X = await signUpAndIn(`s5x-${process.pid}@itest.local`, "Xavier");
    // X is invited into A's workspace so the anyone_in_workspace docs are visible to X (S-006).
    await h.db
      .insert(schema.workspaceMembers)
      .values({ workspaceId: WA, userId: X.userId, role: "member" });

    // A creates project "Billing".
    const create = await app.handle(withCookie(`/api/w/${WA}/projects`, A.cookie, "POST", { name: "Billing" }));
    expect(create.status).toBe(201);
    billingId = ((await create.json()) as any).data.id;

    // Doc "Payment Spec": "refund" in CONTENT; anyone_in_workspace so X can access it.
    const payId = await publish(A.cookie, {
      content: "# Payment Spec\n\nThe refund policy is described here.",
      title: "Payment Spec",
      projectId: billingId,
    });
    // anyone_in_workspace = workspace axis on, link off (access lives on the share_links row).
    await h.db.insert(schema.shareLinks).values({ docId: payId, workspaceRole: "commenter" }).onConflictDoUpdate({ target: schema.shareLinks.docId, set: { workspaceRole: "commenter", linkRole: null } });

    // Doc "Secret Memo": RESTRICTED, X NOT invited; "refund" ONLY in a COMMENT.
    const secretId = await publish(A.cookie, {
      content: "# Internal\n\nnothing matchable here",
      title: "Secret Memo",
      projectId: billingId,
    });
    // Make it RESTRICTED: clear both axes (the new-doc publish default is workspace_role=
    // commenter, so a restricted doc must be set explicitly — doc-access-two-axis). Then add a
    // comment that DOES contain "refund" (the only "refund" on this doc is in the comment).
    await h.db
      .update(schema.shareLinks)
      .set({ workspaceRole: null, linkRole: null })
      .where(eq(schema.shareLinks.docId, secretId));
    await addComment(h.db, secretId, "we should reconsider the refund clause");

    // Doc "Invoice Guide": title-source match for "invoice"; anyone_in_workspace.
    const invId = await publish(A.cookie, {
      content: "# Guide\n\nbody text",
      title: "Invoice Guide",
      projectId: billingId,
    });
    await h.db.insert(schema.shareLinks).values({ docId: invId, workspaceRole: "commenter" }).onConflictDoUpdate({ target: schema.shareLinks.docId, set: { workspaceRole: "commenter", linkRole: null } });

    // Doc "Shared Notes" (anyone_in_workspace): "refund" ONLY in a COMMENT → comment match
    // on an ACCESSIBLE doc (C-006 comment source surfaces a doc the user CAN access).
    const notesId = await publish(A.cookie, {
      content: "# Shared Notes\n\nmeeting notes",
      title: "Shared Notes",
      projectId: billingId,
    });
    await h.db.insert(schema.shareLinks).values({ docId: notesId, workspaceRole: "commenter" }).onConflictDoUpdate({ target: schema.shareLinks.docId, set: { workspaceRole: "commenter", linkRole: null } });
    await addComment(h.db, notesId, "the refund timeline was agreed");
  });

  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  });

  test("AS-009/C-003/H2: X searches 'refund' → Payment Spec only; restricted comment-match ABSENT (no leak)", async () => {
    const json = await searchAs(X.cookie, "refund");
    const titles = json.data.results.map((r: any) => r.title);
    // "Payment Spec" (content match) + "Shared Notes" (comment match on an accessible doc).
    expect(titles).toContain("Payment Spec");
    expect(titles).toContain("Shared Notes");
    // The restricted doc whose COMMENT matched "refund" is fully absent (existence-hiding).
    expect(titles).not.toContain("Secret Memo");
    const raw = JSON.stringify(json);
    expect(raw).not.toContain("Secret Memo");
    // its slug (derived from title) must not leak either.
    expect(raw.toLowerCase()).not.toContain("secret-memo");
  });

  test("C-006: content match source surfaces Payment Spec", async () => {
    const json = await searchAs(X.cookie, "policy");
    const hit = json.data.results.find((r: any) => r.title === "Payment Spec");
    expect(hit).toBeTruthy();
    expect(hit.matchSource).toBe("content");
  });

  test("C-006: title match source surfaces Invoice Guide", async () => {
    const json = await searchAs(X.cookie, "invoice");
    const hit = json.data.results.find((r: any) => r.title === "Invoice Guide");
    expect(hit).toBeTruthy();
    expect(hit.matchSource).toBe("title");
  });

  test("C-006: comment match source surfaces an accessible doc (Shared Notes)", async () => {
    const json = await searchAs(X.cookie, "timeline");
    const hit = json.data.results.find((r: any) => r.title === "Shared Notes");
    expect(hit).toBeTruthy();
    expect(hit.matchSource).toBe("comment");
  });

  test("AS-010: project-scoped search returns only accessible matches in that project", async () => {
    const json = await searchAs(X.cookie, "refund", billingId);
    const titles = json.data.results.map((r: any) => r.title);
    expect(titles).toContain("Payment Spec");
    expect(titles).not.toContain("Secret Memo");
    // a non-existent project scope → empty.
    const none = await searchAs(X.cookie, "refund", "13359f74-bbe5-4c32-bc43-017fb5b3992a");
    expect(none.data.results).toEqual([]);
  });

  test("special chars in q don't break the tsquery or inject", async () => {
    // websearch_to_tsquery tolerates free text; this must not 500 or error.
    const json = await searchAs(X.cookie, "refund & policy: 'quote' é");
    expect(Array.isArray(json.data.results)).toBe(true);
  });

  test("A (owner) finds the restricted doc by its comment match", async () => {
    // Same comment-match, but A owns the doc → it IS returned (access-gated, not removed).
    const json = await searchAs(A.cookie, "reconsider");
    const titles = json.data.results.map((r: any) => r.title);
    expect(titles).toContain("Secret Memo");
  });

  test("AS-014: a soft-deleted annotation's comment no longer surfaces its doc in search (comment-match exclusion)", async () => {
    // annotation-actions S-005 / C-007: the search comment-match join excludes `deleted_at`
    // rows. A owns this doc, so before delete the unique comment token surfaces it; after
    // soft-delete the comment-match must NOT — the deleted annotation is gone from the search.
    const docId = await publish(A.cookie, {
      content: "# Delete Search\n\nnothing matchable in content here",
      title: "Delete Search Doc",
    });
    await h.db.insert(schema.shareLinks).values({ docId, workspaceRole: "commenter" }).onConflictDoUpdate({ target: schema.shareLinks.docId, set: { workspaceRole: "commenter", linkRole: null } });
    const [an] = await h.db
      .insert(annotations)
      .values({ docId, type: "doc", anchor: {} })
      .returning({ id: annotations.id });
    await h.db.insert(comments).values({ annotationId: an!.id, body: "the deltazeta clause needs review" });

    // Present before delete (comment match).
    let r = await searchAs(A.cookie, "deltazeta");
    expect(r.data.results.map((x: any) => x.title)).toContain("Delete Search Doc");

    // Soft-delete the annotation → its comment match is excluded from search.
    await h.db.update(annotations).set({ deletedAt: new Date() }).where(eq(annotations.id, an!.id));
    r = await searchAs(A.cookie, "deltazeta");
    expect(r.data.results.map((x: any) => x.title)).not.toContain("Delete Search Doc");
  });

  // C-006 REGRESSION (the hole): before this fix, extractText ran ONLY on publish's v1.
  // Appending/restoring a version inserted a doc_versions row with NULL extracted_text,
  // so the NEW (current) content was not searchable. The search index covers the CURRENT
  // (max) version's extracted_text — so once append writes it, the new content matches.
  test("AS-015 / C-006: an edited doc's latest content is searchable (current-version index covers v2)", async () => {
    // Publish v1 with a unique content token; v1 content IS searchable (publish path).
    const docId = await publish(A.cookie, {
      content: "# Edit Saga\n\nThe word zephyralpha appears in version one only.",
      title: "Edit Saga",
    });
    await h.db.insert(schema.shareLinks).values({ docId, workspaceRole: "commenter" }).onConflictDoUpdate({ target: schema.shareLinks.docId, set: { workspaceRole: "commenter", linkRole: null } });

    // Sanity: v1 token is findable while v1 is current.
    let r = await searchAs(X.cookie, "zephyralpha");
    expect(r.data.results.map((x: any) => x.title)).toContain("Edit Saga");

    // Append v2 (the edit path) with a NEW token — this is the path that left
    // extracted_text NULL before the fix.
    const repo = createVersionRepo(h.db);
    const v2 = "# Edit Saga\n\nNow the word zephyrbravo appears in version two.";
    await appendVersion(docId, v2, "hash-v2-zephyr", repo, A.userId, "markdown");

    // THE REGRESSION: searching the NEW current content must surface the doc.
    r = await searchAs(X.cookie, "zephyrbravo");
    expect(r.data.results.map((x: any) => x.title)).toContain("Edit Saga");

    // Current-version semantics: the index covers ONLY the current (max) version's
    // extracted_text, so the now-stale v1 token no longer matches on content.
    r = await searchAs(X.cookie, "zephyralpha");
    expect(r.data.results.map((x: any) => x.title)).not.toContain("Edit Saga");
  });

  test("AS-009: search does not return a soft-deleted doc whose title + body match (C-002 exclusion sweep)", async () => {
    // doc-delete-trash S-002 / C-002: a deleted doc must be absent from search results. Publish
    // a doc whose TITLE and CONTENT both match a unique token, workspace-share it (so it would
    // be visible to X), confirm it surfaces, then soft-delete it (deleted_at) and confirm it is
    // gone — the accessible CTE now filters deleted_at IS NULL, so it never leaves the DB.
    // publish creates the share_links row with the new-doc default (workspace_role=commenter),
    // so the doc is already workspace-shared and visible to X — no extra insert needed.
    const docId = await publish(A.cookie, {
      content: "# Omegainvoice Spec\n\nThe omegainvoice clause covers all omegainvoice cases.",
      title: "Omegainvoice Spec",
    });

    // Visible before delete (title + content match).
    let r = await searchAs(X.cookie, "omegainvoice");
    expect(r.data.results.map((x: any) => x.title)).toContain("Omegainvoice Spec");

    // Soft-delete the doc → it must vanish from search.
    await h.db.update(docs).set({ deletedAt: new Date() }).where(eq(docs.id, docId));
    r = await searchAs(X.cookie, "omegainvoice");
    const titles = r.data.results.map((x: any) => x.title);
    expect(titles).not.toContain("Omegainvoice Spec");
    // existence-hiding: neither id, title, nor slug leaks in the raw payload.
    const raw = JSON.stringify(r);
    expect(raw).not.toContain("Omegainvoice");
    expect(raw).not.toContain(docId);
  });

  test("C-006: restored version content is searchable (restore makes it current)", async () => {
    const docId = await publish(A.cookie, {
      content: "# Restore Saga\n\nThe token gammafox is in version one.",
      title: "Restore Saga",
    });
    await h.db.insert(schema.shareLinks).values({ docId, workspaceRole: "commenter" }).onConflictDoUpdate({ target: schema.shareLinks.docId, set: { workspaceRole: "commenter", linkRole: null } });

    const repo = createVersionRepo(h.db);
    // v2 replaces the content (gammafox no longer current).
    await appendVersion(
      docId,
      "# Restore Saga\n\nThe token deltawolf is in version two.",
      "hash-rs-v2",
      repo,
      A.userId,
      "markdown",
    );
    // v1 token is now stale → not on content.
    let r = await searchAs(X.cookie, "gammafox");
    expect(r.data.results.map((x: any) => x.title)).not.toContain("Restore Saga");

    // Restore v1 → appends v3 (copy of v1, now current) WITH extracted_text → searchable again.
    await restoreVersion(docId, 1, repo, A.userId, "markdown");
    r = await searchAs(X.cookie, "gammafox");
    expect(r.data.results.map((x: any) => x.title)).toContain("Restore Saga");
  });
});
