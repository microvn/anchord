// Integration tier (guarded by RUN_INTEGRATION): workspace-project S-004 over REAL
// Postgres. Proves the parts the unit/route tests deferred to a DB:
//   AS-008 — MOVE a doc (3 versions + an annotation + a sharing config) Billing →
//            Payments: project_id changes; slug/id/versions/annotation/sharing all kept.
//   AS-013 — COPY a 3-version doc → a NEW doc in Payments with a NEW slug, exactly ONE
//            version whose content = the source's CURRENT (v3) content, ZERO annotations;
//            the SOURCE still has 3 versions + its annotation (unchanged).
//   C-008  — copy = clean new doc; move = doc as-is.
//
// PRODUCTION FIDELITY: SAME createApp(deps) composition as src/index.ts (better-auth
// mounted; the member-on-signup hook ensuring a default project; gated /api/setup,
// /api/projects, /api/docs, /api/docs/:slug/versions, and /api/docs/:slug/{move,copy}
// wired to the REAL betterAuthSessionResolver + db-backed repos + the concrete
// resolveDocRole/isWorkspaceAdmin). The one divergence (per workspace-setup.itest.ts)
// is requireEmailVerification:false so sign-in issues a cookie in-process.
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/doc-move.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { docs, docVersions, annotations, comments, shareLinks, user as userTable } from "../../src/db/schema";
import { createApp } from "../../src/app";
import { betterAuthSessionResolver } from "../../src/http/auth-gate";
import { onUserCreated } from "../../src/auth/auth";
import { createProjectRepo } from "../../src/workspace/repo";
import { createTenancyRepo, createWorkspaceAccess } from "../../src/workspace/tenancy-repo";
import {
  createResolveDocRole,
  createIsDocOwner,
} from "../../src/sharing/resolve-doc-role-repo";
import { createResolveAccess } from "../../src/sharing/resolve-access";
import { deriveLevel } from "../../src/sharing/derive-level";
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

describe.skipIf(!RUN)("workspace-project S-004: move/copy a doc (real Postgres)", () => {
  let h: MigratedDb;
  let app: ReturnType<typeof createApp>;
  let A: { userId: string; cookie: string };
  let WA = "";
  let billingId: string;
  let paymentsId: string;
  let docSlug: string;
  let docId: string;

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
    const resolveSession = betterAuthSessionResolver(auth);
    const wsAccess = createWorkspaceAccess(h.db);
    const resolveWorkspaceRole = (wsId: string, userId: string) => wsAccess.workspaceRoleOf(wsId, userId);
    const isWorkspaceAdmin = (wsId: string, userId: string) => wsAccess.isWorkspaceAdminFor(wsId, userId);
    const isWorkspaceMemberOfDoc = async (docId: string, userId: string) => {
      const wsId = await wsAccess.workspaceOfDoc(docId);
      return wsId ? wsAccess.isWorkspaceMember(wsId, userId) : false;
    };
    const resolveDocRole = createResolveDocRole(h.db, {
      isOwner: createIsDocOwner(h.db),
      isWorkspaceMember: isWorkspaceMemberOfDoc,
    });
    // S-001: the single read gate the version routes consult, built on the real resolver.
    const resolveAccess = createResolveAccess(h.db, { resolveDocRole });

    app = createApp({
      dbCheck: async () => {},
      authHandler: auth.handler,
      projects: { db: h.db, resolveSession, resolveWorkspaceRole },
      docs: { db: h.db, resolveSession, resolveWorkspaceRole },
      versions: {
        db: h.db,
        resolveSession,
        resolveWorkspaceRole,
        resolveDocRole,
        resolveAccess,
      },
      docMove: { db: h.db, resolveSession, resolveWorkspaceRole, resolveDocRole, isWorkspaceAdmin },
      // doc-access-routing S-006: the bare /d/:slug server viewer was removed; this suite
      // never exercised it (move/copy only), so the dead loadViewer stub is dropped.
    });

    A = await signUpAndIn(`s4a-${process.pid}@itest.local`, "Alice");
    // workspaces S-001: A's own workspace was auto-created on signup.
    const [waRow] = await h.db
      .select()
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, A.userId));
    WA = waRow!.workspaceId;

    // Two projects: Billing (source) + Payments (target).
    const cb = await app.handle(withCookie(`/api/w/${WA}/projects`, A.cookie, "POST", { name: "Billing" }));
    billingId = ((await cb.json()) as any).data.id;
    const cp = await app.handle(withCookie(`/api/w/${WA}/projects`, A.cookie, "POST", { name: "Payments" }));
    paymentsId = ((await cp.json()) as any).data.id;

    // Publish a doc into Billing, then append v2 + v3 (a 3-version doc).
    const pub = await app.handle(
      withCookie(`/api/w/${WA}/docs`, A.cookie, "POST", {
        content: "# Billing v1",
        title: "Billing Spec",
        projectId: billingId,
      }),
    );
    expect(pub.status).toBe(201);
    const pubBody = (await pub.json()) as any;
    docSlug = pubBody.data.slug;
    docId = pubBody.data.docId;
    for (const body of ["# Billing v2", "# Billing v3 current"]) {
      const v = await app.handle(
        withCookie(`/api/w/${WA}/docs/${docSlug}/versions`, A.cookie, "POST", { content: body }),
      );
      expect(v.status).toBe(201);
    }

    // Attach a sharing config + an annotation with a comment to the source. The publish path
    // (project-visibility S-004) ALREADY created the source's share_links row when it derived the
    // new-doc access from its project, so this UPDATEs that row (a second INSERT would violate the
    // share_links.doc_id unique constraint) — it overlays a link_role + guest commenting on top.
    await h.db
      .update(shareLinks)
      .set({ linkRole: "commenter", guestCommenting: true })
      .where(eq(shareLinks.docId, docId));
    const [an] = await h.db
      .insert(annotations)
      .values({ docId, type: "range", anchor: { block_id: "b1", text_snippet: "x" } })
      .returning({ id: annotations.id });
    await h.db.insert(comments).values({ annotationId: an!.id, authorId: A.userId, body: "a note" });
  });

  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  });

  test("AS-008: MOVE Billing → Payments — project_id changes; slug/id/versions/annotation/sharing kept", async () => {
    const versionsBefore = await h.db.select().from(docVersions).where(eq(docVersions.docId, docId));
    const annBefore = await h.db.select().from(annotations).where(eq(annotations.docId, docId));
    expect(versionsBefore).toHaveLength(3);
    expect(annBefore).toHaveLength(1);

    const move = await app.handle(
      withCookie(`/api/w/${WA}/docs/${docSlug}/move`, A.cookie, "POST", { projectId: paymentsId }),
    );
    expect(move.status).toBe(200);
    const body = (await move.json()) as any;
    expect(body.data.slug).toBe(docSlug); // same slug
    expect(body.data.docId).toBe(docId); // same id
    expect(body.data.projectId).toBe(paymentsId);

    const [after] = await h.db.select().from(docs).where(eq(docs.id, docId));
    expect(after!.projectId).toBe(paymentsId); // relocated
    expect(after!.slug).toBe(docSlug); // unchanged
    expect(after!.ownerId).toBe(A.userId); // owner unchanged

    // Versions + annotation + sharing all intact (the doc is the SAME doc, relocated).
    const versionsAfter = await h.db.select().from(docVersions).where(eq(docVersions.docId, docId));
    expect(versionsAfter).toHaveLength(3);
    const annAfter = await h.db.select().from(annotations).where(eq(annotations.docId, docId));
    expect(annAfter).toHaveLength(1);
    const [link] = await h.db.select().from(shareLinks).where(eq(shareLinks.docId, docId));
    expect(link!.linkRole).toBe("commenter");
    expect(link!.guestCommenting).toBe(true);
  });

  test("AS-013/C-008: COPY a 3-version doc → NEW doc in Payments, new slug, 1 version = source v3, 0 annotations; source unchanged", async () => {
    const copy = await app.handle(
      withCookie(`/api/w/${WA}/docs/${docSlug}/copy`, A.cookie, "POST", { projectId: paymentsId }),
    );
    expect(copy.status).toBe(201);
    const cbody = (await copy.json()) as any;
    const copyId = cbody.data.docId;
    const copySlug = cbody.data.slug;

    expect(copyId).not.toBe(docId); // a NEW doc
    expect(copySlug).not.toBe(docSlug); // a NEW slug

    const [copyDocRow] = await h.db.select().from(docs).where(eq(docs.id, copyId));
    expect(copyDocRow!.projectId).toBe(paymentsId);
    expect(copyDocRow!.ownerId).toBe(A.userId); // owner = the copier
    // project-visibility S-004 (C-007): a copy's access DERIVES from the COPY TARGET project,
    // like a fresh publish — Payments is a non-default PUBLIC project (created via the route →
    // public by default) → {commenter,null} → anyone_in_workspace. (The non-default-PRIVATE copy
    // path → restricted is AS-020 below.) Access lives on the share_links row as the two axes.
    const [copyShare] = await h.db
      .select({ workspaceRole: shareLinks.workspaceRole, linkRole: shareLinks.linkRole })
      .from(shareLinks)
      .where(eq(shareLinks.docId, copyId));
    expect(deriveLevel(copyShare?.workspaceRole ?? null, copyShare?.linkRole ?? null)).toBe(
      "anyone_in_workspace",
    );
    expect(copyDocRow!.title).toBe("Billing Spec"); // source title kept

    // Exactly ONE version, and its content = the source's CURRENT (v3) content.
    const copyVersions = await h.db.select().from(docVersions).where(eq(docVersions.docId, copyId));
    expect(copyVersions).toHaveLength(1);
    expect(copyVersions[0]!.version).toBe(1);
    expect(copyVersions[0]!.content).toBe("# Billing v3 current");

    // ZERO annotations/comments on the copy (clean copy, C-008).
    const copyAnn = await h.db.select().from(annotations).where(eq(annotations.docId, copyId));
    expect(copyAnn).toHaveLength(0);

    // The SOURCE is unchanged: still 3 versions + its 1 annotation.
    const srcVersions = await h.db.select().from(docVersions).where(eq(docVersions.docId, docId));
    expect(srcVersions).toHaveLength(3);
    const srcAnn = await h.db.select().from(annotations).where(eq(annotations.docId, docId));
    expect(srcAnn).toHaveLength(1);
  });

  test("AS-020: COPY into a non-default PRIVATE project → the COPY's share_links is {null, null} (restricted, derived from the target)", async () => {
    // A owns a non-default PRIVATE project (A can SEE it as its owner → a valid copy target).
    const [priv] = await h.db
      .insert(schema.projects)
      .values({ workspaceId: WA, name: "Vault", ownerId: A.userId, isDefault: false, visibility: "private" })
      .returning({ id: schema.projects.id });

    const copy = await app.handle(
      withCookie(`/api/w/${WA}/docs/${docSlug}/copy`, A.cookie, "POST", { projectId: priv!.id }),
    );
    expect(copy.status).toBe(201);
    const copyId = ((await copy.json()) as any).data.docId;

    // The copy DERIVES restricted from the private target (no silent over-share, AS-020).
    const [copyShare] = await h.db
      .select({ workspaceRole: shareLinks.workspaceRole, linkRole: shareLinks.linkRole })
      .from(shareLinks)
      .where(eq(shareLinks.docId, copyId));
    expect(copyShare!.workspaceRole).toBeNull();
    expect(copyShare!.linkRole).toBeNull();
    expect(deriveLevel(copyShare!.workspaceRole, copyShare!.linkRole)).toBe("restricted");
  });

  // ── project-visibility S-005 / C-009: boundary-crossing move (real Postgres) ──────────────
  // Helper: publish a fresh workspace-shared doc into Billing (a public project) so each
  // crossing test starts from a known {commenter,null} access, then move it into a NON-DEFAULT
  // PRIVATE project A owns (A can see it → a valid move target; the boundary is the visibility
  // mismatch, not viewability).
  async function freshSharedDocAndPrivateTarget(label: string) {
    const pub = await app.handle(
      withCookie(`/api/w/${WA}/docs`, A.cookie, "POST", {
        content: `# ${label}`,
        title: label,
        projectId: billingId,
      }),
    );
    expect(pub.status).toBe(201);
    const slug = ((await pub.json()) as any).data.slug;
    const [doc] = await h.db.select().from(docs).where(eq(docs.slug, slug));
    const [priv] = await h.db
      .insert(schema.projects)
      .values({ workspaceId: WA, name: label + " Vault", ownerId: A.userId, isDefault: false, visibility: "private" })
      .returning({ id: schema.projects.id });
    return { slug, docId: doc!.id, privateId: priv!.id };
  }

  test("AS-021: a boundary-crossing MOVE with no accessChoice → 409, doc NOT moved, share_links unchanged", async () => {
    const { slug, docId, privateId } = await freshSharedDocAndPrivateTarget("Crossing No-Choice");
    const move = await app.handle(
      withCookie(`/api/w/${WA}/docs/${slug}/move`, A.cookie, "POST", { projectId: privateId }),
    );
    expect(move.status).toBe(409);
    // Nothing moved: still in Billing; share_links still {commenter,null} (workspace-shared).
    const [after] = await h.db.select().from(docs).where(eq(docs.id, docId));
    expect(after!.projectId).toBe(billingId);
    const [link] = await h.db
      .select({ workspaceRole: shareLinks.workspaceRole, linkRole: shareLinks.linkRole })
      .from(shareLinks)
      .where(eq(shareLinks.docId, docId));
    expect(link!.workspaceRole).toBe("commenter");
    expect(link!.linkRole).toBeNull();
  });

  test("AS-022: MOVE + accessChoice=make_private → doc moved AND share_links {null,null}, in one tx (atomic)", async () => {
    const { slug, docId, privateId } = await freshSharedDocAndPrivateTarget("Crossing Make-Private");
    const move = await app.handle(
      withCookie(`/api/w/${WA}/docs/${slug}/move`, A.cookie, "POST", {
        projectId: privateId,
        accessChoice: "make_private",
      }),
    );
    expect(move.status).toBe(200);
    // BOTH effects committed together: relocated AND restricted (no half-state).
    const [after] = await h.db.select().from(docs).where(eq(docs.id, docId));
    expect(after!.projectId).toBe(privateId);
    const [link] = await h.db
      .select({ workspaceRole: shareLinks.workspaceRole, linkRole: shareLinks.linkRole })
      .from(shareLinks)
      .where(eq(shareLinks.docId, docId));
    expect(link!.workspaceRole).toBeNull();
    expect(link!.linkRole).toBeNull();
    expect(deriveLevel(link!.workspaceRole, link!.linkRole)).toBe("restricted");
  });

  test("AS-023: MOVE + accessChoice=keep_sharing → doc moved, share_links still {commenter,null} (soft-private)", async () => {
    const { slug, docId, privateId } = await freshSharedDocAndPrivateTarget("Crossing Keep");
    const move = await app.handle(
      withCookie(`/api/w/${WA}/docs/${slug}/move`, A.cookie, "POST", {
        projectId: privateId,
        accessChoice: "keep_sharing",
      }),
    );
    expect(move.status).toBe(200);
    // Moved into the private project but the access is UNCHANGED — soft-private.
    const [after] = await h.db.select().from(docs).where(eq(docs.id, docId));
    expect(after!.projectId).toBe(privateId);
    const [link] = await h.db
      .select({ workspaceRole: shareLinks.workspaceRole, linkRole: shareLinks.linkRole })
      .from(shareLinks)
      .where(eq(shareLinks.docId, docId));
    expect(link!.workspaceRole).toBe("commenter");
    expect(link!.linkRole).toBeNull();
  });

  test("MOVE to a bogus (non-existent) project → 404, nothing mutated", async () => {
    const bogus = "00000000-0000-4000-8000-000000000000";
    const move = await app.handle(
      withCookie(`/api/w/${WA}/docs/${docSlug}/move`, A.cookie, "POST", { projectId: bogus }),
    );
    expect(move.status).toBe(404);
    const [after] = await h.db.select().from(docs).where(eq(docs.id, docId));
    expect(after!.projectId).toBe(paymentsId); // still where AS-008 left it
  });
});
