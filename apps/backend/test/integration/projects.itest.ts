// Integration tier (guarded by RUN_INTEGRATION): workspace-project S-003 over REAL
// Postgres. Proves the parts the unit/route tests deferred to a DB:
//   AS-014/C-009 — sign up A → setup → A has a default project ("<name>'s docs").
//   AS-005       — A creates "Billing" + publishes a doc into it; A is the doc owner.
//   AS-006/C-003 — sign up member X → X browses "Billing" → sees the anyone_in_workspace
//                  doc, NOT the restricted one (existence-hiding on the real access read).
//   AS-007/C-005 — archive "Billing" → gone from the default project list; the doc still
//                  opens by slug (direct link unaffected by archive).
//   C-009 (MCP)  — publish with NO projectId → lands in A's default project.
//
// PRODUCTION FIDELITY: SAME createApp(deps) composition as src/index.ts (better-auth
// mounted; the member-on-signup hook that also ensures a default project; the gated
// /api/setup, /api/projects, and /api/docs wired to the REAL betterAuthSessionResolver
// and db-backed repos). The one divergence (as workspace-setup.itest.ts documents) is
// requireEmailVerification:false so sign-in issues a cookie in-process; the create hook
// fires on sign-up regardless, so the default-project write under test is prod-identical.
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/projects.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { docs, projects, user as userTable } from "../../src/db/schema";
import { createApp } from "../../src/app";
import { betterAuthSessionResolver } from "../../src/http/auth-gate";
import { onUserCreated } from "../../src/auth/auth";
import { createProjectRepo, createProjectsRouteRepo } from "../../src/workspace/repo";
import { createDocRepo } from "../../src/publish/repo";
import { annotations, comments } from "../../src/db/schema";
import { seedWorkspace } from "./harness";
import { createTenancyRepo, createWorkspaceAccess } from "../../src/workspace/tenancy-repo";
import { createResolveAccess } from "../../src/sharing/resolve-access";
import { createResolveDocRole, createIsDocOwner } from "../../src/sharing/resolve-doc-role-repo";
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
            // workspaces S-001: each signup auto-creates its OWN workspace + default project.
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

describe.skipIf(!RUN)("workspace-project S-003: projects + browse (real Postgres)", () => {
  let h: MigratedDb;
  let app: ReturnType<typeof createApp>;
  let A: { userId: string; cookie: string };
  let X: { userId: string; cookie: string };
  let WA = ""; // A's auto-created workspace
  let billingId: string;
  let billingDefaultDocSlug: string;

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

  beforeAll(async () => {
    h = await withMigratedDb();
    const auth = makeAuth(h.db);
    const wsAccess = createWorkspaceAccess(h.db);
    const resolveWorkspaceRole = (wsId: string, userId: string) => wsAccess.workspaceRoleOf(wsId, userId);
    const resolveSession = betterAuthSessionResolver(auth);
    // doc-access-routing S-006: the bare /d/:slug server page is gone. The surviving
    // doc-scoped read is GET /api/docs/:slug (docViewer) — gated by the single resolveAccess
    // over the doc's OWN workspace, anon-capable. Wire it with the REAL access deps so the
    // "archive doesn't gate the direct link" assertion exercises the production read path.
    const resolveDocRole = createResolveDocRole(h.db, {
      isOwner: createIsDocOwner(h.db),
      isWorkspaceMember: async (docId: string, userId: string) => {
        const wsId = await wsAccess.workspaceOfDoc(docId);
        return wsId ? wsAccess.isWorkspaceMember(wsId, userId) : false;
      },
    });
    const resolveAccess = createResolveAccess(h.db, { resolveDocRole });
    const resolveViewerSession = async (request: Request): Promise<{ userId: string } | null> => {
      const actor = await resolveSession(request.headers);
      return actor ? { userId: actor.userId } : null;
    };
    app = createApp({
      dbCheck: async () => {},
      authHandler: auth.handler,
      projects: { db: h.db, resolveSession, resolveWorkspaceRole },
      docs: { db: h.db, resolveSession, resolveWorkspaceRole },
      docViewer: { resolveViewerSession, loaderDeps: { db: h.db, resolveAccess } },
    });

    // workspaces S-001: A signs up → A auto-gets its OWN workspace WA (admin) + default project.
    A = await signUpAndIn(`s3a-${process.pid}@itest.local`, "Alice");
    const [waRow] = await h.db
      .select()
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, A.userId));
    WA = waRow!.workspaceId;

    // X signs up (gets its OWN workspace too) and is then invited into WA as a member, so the
    // cross-member browse test (AS-006/C-003) runs inside A's workspace.
    X = await signUpAndIn(`s3x-${process.pid}@itest.local`, "Xavier");
    await h.db
      .insert(schema.workspaceMembers)
      .values({ workspaceId: WA, userId: X.userId, role: "member" });
  });

  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  });

  test("AS-014/C-009: setup gives the installer A a default project '<name>\\'s docs'", async () => {
    const def = await h.db
      .select()
      .from(projects)
      .where(and(eq(projects.ownerId, A.userId), eq(projects.isDefault, true)));
    expect(def).toHaveLength(1);
    expect(def[0]!.name).toBe("Alice's docs");
  });

  test("AS-014/C-009: member X gets exactly ONE default project on joining (idempotent)", async () => {
    const def = await h.db
      .select()
      .from(projects)
      .where(and(eq(projects.ownerId, X.userId), eq(projects.isDefault, true)));
    expect(def).toHaveLength(1);
    expect(def[0]!.name).toBe("Xavier's docs");
  });

  test("AS-005: A creates 'Billing' and publishes a doc into it; A is the doc owner", async () => {
    const create = await app.handle(
      withCookie(`/api/w/${WA}/projects`, A.cookie, "POST", { name: "Billing" }),
    );
    expect(create.status).toBe(201);
    billingId = ((await create.json()) as any).data.id;

    // Doc B: anyone_in_workspace, published INTO Billing.
    const pub = await app.handle(
      withCookie(`/api/w/${WA}/docs`, A.cookie, "POST", {
        content: "# Shared B\nrefund policy",
        title: "Shared B",
        projectId: billingId,
      }),
    );
    expect(pub.status).toBe(201);
    const docId = ((await pub.json()) as any).data.docId;
    const [row] = await h.db.select().from(docs).where(eq(docs.id, docId));
    expect(row!.projectId).toBe(billingId);
    expect(row!.ownerId).toBe(A.userId); // AS-005: the member is the doc owner
    // Make it anyone_in_workspace so X can browse it.
    await h.db.update(docs).set({ generalAccess: "anyone_in_workspace" }).where(eq(docs.id, docId));
  });

  test("AS-006/C-003: X browses 'Billing' → sees doc B (anyone_in_workspace), NOT doc A (restricted)", async () => {
    // Doc A: restricted, published into Billing by A; X is NOT invited.
    const pubA = await app.handle(
      withCookie(`/api/w/${WA}/docs`, A.cookie, "POST", {
        content: "# Secret A",
        title: "Secret A",
        projectId: billingId,
      }),
    );
    const docAId = ((await pubA.json()) as any).data.docId;
    // shared-workspace model (workspaces:C-007): a published doc now defaults to anyone_in_workspace,
    // so to test the restricted-hidden path doc A must be set restricted EXPLICITLY (the
    // per-doc opt-in) — it is no longer the publish default.
    await h.db.update(docs).set({ generalAccess: "restricted" }).where(eq(docs.id, docAId));

    const browse = await app.handle(withCookie(`/api/w/${WA}/projects/${billingId}/docs`, X.cookie));
    expect(browse.status).toBe(200);
    const body = await browse.json();
    const titles = (body as any).data.docs.map((d: any) => d.title);
    expect(titles).toContain("Shared B");
    expect(titles).not.toContain("Secret A");
    // Existence-hiding: no metadata of doc A leaks anywhere in the response.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(docAId);
    expect(raw).not.toContain("Secret A");
  });

  test("C-009 (MCP fallback): A publishes with NO projectId → lands in A's default project", async () => {
    const pub = await app.handle(
      withCookie(`/api/w/${WA}/docs`, A.cookie, "POST", { content: "# No project", title: "Orphan" }),
    );
    expect(pub.status).toBe(201);
    billingDefaultDocSlug = ((await pub.json()) as any).data.slug;
    const [row] = await h.db.select().from(docs).where(eq(docs.slug, billingDefaultDocSlug));
    const [def] = await h.db
      .select()
      .from(projects)
      .where(and(eq(projects.ownerId, A.userId), eq(projects.isDefault, true)));
    expect(row!.projectId).toBe(def!.id);
  });

  // workspace-project-ui S-007 (AS-019 / C-006): docsInProject must count a doc's ACTIVE
  // annotations (deletedAt IS NULL), NOT the comment total across its annotation threads.
  // Seed: 3 active annotations on one doc, one of which carries 4 reply comments (7 comments
  // total), PLUS 1 soft-deleted annotation. The row's annotationCount must read 3.
  test("AS-019/C-006: docsInProject counts ACTIVE annotations (3), not comments (7), excluding soft-deleted", async () => {
    // A standalone user + workspace + project + doc seeded directly (no auth round-trip needed
    // to exercise the repo's aggregation SQL).
    const [u] = await h.db
      .insert(userTable)
      .values({
        id: `u-s007-${process.pid}`,
        name: "Counter",
        email: `s007-${process.pid}@itest.local`,
        emailVerified: true,
      })
      .returning({ id: userTable.id });
    const seeded = await seedWorkspace(h.db, { userId: u!.id, withProject: true });
    const projectId = seeded.projectId!;

    const { id: docId } = await createDocRepo(h.db).createDocWithV1({
      slug: `s007-doc-${process.pid}`,
      title: "Annotation Count Doc",
      kind: "markdown",
      content: "# body",
      contentHash: `hash-s007-${process.pid}`,
      ownerId: u!.id,
      projectId,
    });

    // 3 ACTIVE annotations (deletedAt null).
    const active = await h.db
      .insert(annotations)
      .values([
        { docId, type: "range", anchor: {} },
        { docId, type: "range", anchor: {} },
        { docId, type: "range", anchor: {} },
      ])
      .returning({ id: annotations.id });
    // 1 SOFT-DELETED annotation (deletedAt set) — must NOT be counted.
    await h.db
      .insert(annotations)
      .values({ docId, type: "range", anchor: {}, deletedAt: new Date() });

    // Pile 7 comments onto the FIRST active annotation (a root + replies) so the old
    // comment-count metric would read 7 — proving the new metric is annotations, not comments.
    const a0 = active[0]!.id;
    await h.db.insert(comments).values(
      Array.from({ length: 7 }, (_, i) => ({ annotationId: a0, body: `c${i}` })),
    );

    const rows = await createProjectsRouteRepo(h.db).docsInProject(projectId);
    const row = rows.find((r) => r.id === docId);
    expect(row).toBeTruthy();
    // AS-019.T1: active-annotation count, not the 7 comment total.
    expect(row!.annotationCount).toBe(3);
    // AS-019.T2: the soft-deleted annotation is excluded (else this would be 4).
    expect(row!.annotationCount).not.toBe(4);
  });

  // workspace-project-ui S-007 (AS-027 / C-006): a DISMISSED detached annotation
  // (annotation-core S-008/C-013, dismissedAt set) must also be excluded from the count, so the
  // browse/overview count matches the viewer rail's active read. Seed: 3 active + 1 dismissed → 3.
  test("AS-027/C-006: docsInProject excludes a dismissed annotation from the count (3 active + 1 dismissed → 3)", async () => {
    const [u] = await h.db
      .insert(userTable)
      .values({
        id: `u-s007d-${process.pid}`,
        name: "Dismiss Counter",
        email: `s007d-${process.pid}@itest.local`,
        emailVerified: true,
      })
      .returning({ id: userTable.id });
    const seeded = await seedWorkspace(h.db, { userId: u!.id, withProject: true });
    const projectId = seeded.projectId!;

    const { id: docId } = await createDocRepo(h.db).createDocWithV1({
      slug: `s007d-doc-${process.pid}`,
      title: "Dismiss Count Doc",
      kind: "markdown",
      content: "# body",
      contentHash: `hash-s007d-${process.pid}`,
      ownerId: u!.id,
      projectId,
    });

    // 3 ACTIVE annotations.
    await h.db.insert(annotations).values([
      { docId, type: "range", anchor: {} },
      { docId, type: "range", anchor: {} },
      { docId, type: "range", anchor: {} },
    ]);
    // 1 DISMISSED detached annotation (dismissedAt set, deletedAt null) — must NOT be counted.
    await h.db
      .insert(annotations)
      .values({ docId, type: "range", anchor: {}, isOrphaned: true, dismissedAt: new Date() });

    const rows = await createProjectsRouteRepo(h.db).docsInProject(projectId);
    const row = rows.find((r) => r.id === docId);
    expect(row).toBeTruthy();
    // The dismissed annotation is excluded (else this would be 4) — matches the rail's active read.
    expect(row!.annotationCount).toBe(3);
    expect(row!.annotationCount).not.toBe(4);
  });

  // S-003/AS-028 + C-003: the projects-list read carries each project's ACCESSIBLE-doc count,
  // computed in ONE GROUP BY behind the same access predicate as the browse. The access filter
  // is what this real-DB test proves: X gets a count of ONLY the docs X can browse — a restricted
  // doc X is not invited to is NOT counted (it must never leak into the count, C-003). At this
  // point Billing holds: doc B (anyone_in_workspace, browsable by X) + doc A (restricted, X
  // uninvited). So X's count for Billing is 1, NOT 2 — the restricted doc is access-filtered out.
  test("AS-028/C-003: projects-list docCount is access-filtered — X counts the workspace doc, NOT the restricted one", async () => {
    const list = await app.handle(withCookie(`/api/w/${WA}/projects`, X.cookie));
    expect(list.status).toBe(200);
    const projects = ((await list.json()) as any).data.projects as { id: string; docCount: number }[];
    const billing = projects.find((p) => p.id === billingId);
    expect(billing).toBeTruthy();
    // Billing has 2 docs total (B shared + A restricted); X can access only B → count 1, not 2.
    expect(billing!.docCount).toBe(1);

    // And A (the owner) counts BOTH (owner sees its own restricted doc) → 2.
    const listA = await app.handle(withCookie(`/api/w/${WA}/projects`, A.cookie));
    const projectsA = ((await listA.json()) as any).data.projects as { id: string; docCount: number }[];
    expect(projectsA.find((p) => p.id === billingId)!.docCount).toBe(2);
  });

  test("publish with a supplied-but-invalid projectId → 404 (never silent-default)", async () => {
    const bogus = "00000000-0000-0000-0000-000000000000";
    const pub = await app.handle(
      withCookie(`/api/w/${WA}/docs`, A.cookie, "POST", {
        content: "# Bad project",
        title: "Bad",
        projectId: bogus,
      }),
    );
    expect(pub.status).toBe(404);
  });

  test("AS-007/C-005: archiving 'Billing' hides it from the list; its doc still opens by slug", async () => {
    // Find the slug of the anyone_in_workspace doc in Billing (published earlier).
    const [sharedDoc] = await h.db
      .select()
      .from(docs)
      .where(and(eq(docs.projectId, billingId), eq(docs.generalAccess, "anyone_in_workspace")));
    expect(sharedDoc).toBeTruthy();

    const archive = await app.handle(
      withCookie(`/api/w/${WA}/projects/${billingId}/archive`, A.cookie, "POST"),
    );
    expect(archive.status).toBe(200);

    const list = await app.handle(withCookie(`/api/w/${WA}/projects`, A.cookie));
    const ids = ((await list.json()) as any).data.projects.map((p: any) => p.id);
    expect(ids).not.toContain(billingId); // hidden from the default list

    // Direct link still works (archive does not gate the doc read). doc-access-routing S-006:
    // the bare /d/:slug server page is gone; the doc-scoped read GET /api/docs/:slug is the
    // surviving surface the in-app viewer loads, so the assertion targets it now.
    const viewer = await app.handle(withCookie(`/api/docs/${sharedDoc!.slug}`, A.cookie));
    expect(viewer.status).toBe(200);

    // Unarchive → it reappears.
    const unarchive = await app.handle(
      withCookie(`/api/w/${WA}/projects/${billingId}/unarchive`, A.cookie, "POST"),
    );
    expect(unarchive.status).toBe(200);
    const list2 = await app.handle(withCookie(`/api/w/${WA}/projects`, A.cookie));
    const ids2 = ((await list2.json()) as any).data.projects.map((p: any) => p.id);
    expect(ids2).toContain(billingId);
  });
});
