// Integration tier (guarded by RUN_INTEGRATION): the Drizzle-backed DocRepo's
// createDocWithV1 against a REAL Postgres. Proves the doc + its version-1 row land
// in ONE transaction and are readable, and that the unique(doc_id, version) index
// actually rejects a duplicate version-1 insert (render-publish C-004 persistence).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { docVersions, docs, projects, shareLinks, user as userTable } from "../../src/db/schema";
import { createDocRepo } from "../../src/publish/repo";
import { publishDoc } from "../../src/publish/service";
import { createMcpCreateDocumentPort } from "../../src/mcp/tools/publish-tools-wiring";
import { createResolveAccess } from "../../src/sharing/resolve-access";
import { createResolveDocRole, createIsDocOwner } from "../../src/sharing/resolve-doc-role-repo";
import { createWorkspaceAccess } from "../../src/workspace/tenancy-repo";
import { can } from "../../src/sharing/roles";
import type { Viewer } from "../../src/sharing/access";
import { withMigratedDb, seedWorkspace, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;

describe.skipIf(!RUN)("publish repo (real Postgres)", () => {
  let h: MigratedDb;

  beforeAll(async () => {
    h = await withMigratedDb();
  });

  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  });

  test("createDocWithV1 inserts doc + version-1 in one tx; both rows are readable", async () => {
    const slug = `publish-itest-${process.pid}-1`;
    const { id } = await createDocRepo(h.db).createDocWithV1({
      slug,
      title: "Hello",
      kind: "html",
      content: "<h1>hi</h1>",
      contentHash: "h1-hash",
    });

    const docRows = await h.db.select().from(docs).where(eq(docs.id, id));
    expect(docRows).toHaveLength(1);
    expect(docRows[0]?.slug).toBe(slug);
    expect(docRows[0]?.kind).toBe("html");

    const verRows = await h.db.select().from(docVersions).where(eq(docVersions.docId, id));
    expect(verRows).toHaveLength(1);
    expect(verRows[0]?.version).toBe(1);
    expect(verRows[0]?.content).toBe("<h1>hi</h1>");
    expect(verRows[0]?.contentHash).toBe("h1-hash");
  });

  test("unique(doc_id, version) rejects a duplicate version-1 insert", async () => {
    const slug = `publish-itest-${process.pid}-2`;
    const { id } = await createDocRepo(h.db).createDocWithV1({
      slug,
      title: "Dup",
      kind: "markdown",
      content: "# dup",
      contentHash: "dup-hash",
    });

    // A second version-1 for the same doc must violate doc_version_uq.
    let threw = false;
    try {
      await h.db.insert(docVersions).values({
        docId: id,
        version: 1,
        content: "# dup again",
        contentHash: "dup-hash-2",
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // The original version-1 row is untouched by the failed insert.
    const verRows = await h.db.select().from(docVersions).where(eq(docVersions.docId, id));
    expect(verRows).toHaveLength(1);
    expect(verRows[0]?.content).toBe("# dup");
  });
});

// ── doc-access-two-axis S-002 + project-visibility S-004 (C-007 / AS-005 / AS-006 / AS-025):
//    a freshly published doc's access now DERIVES from its TARGET project (project-visibility
//    S-004), verified END-TO-END (publish write → share_links row → the access resolver) against
//    a real Postgres, because the assertion spans the publish path and the read gate. These
//    AS-005/006/025 cases publish into the DEFAULT project (seedWorkspace withProject = isDefault),
//    so the S-004 carve-out applies → still {commenter,null} (the default project is private-SHELL
//    but its new docs stay workspace-shared — the agent loop). The web surface (AS-005/006) and
//    the MCP surface (AS-025) BOTH route through the publish repo, so both derive identically.
//    The non-default public/private derivation is the S-004 block further below. ─────────────
describe.skipIf(!RUN)("publish new-doc default access (S-002, real Postgres)", () => {
  let h: MigratedDb;

  beforeAll(async () => {
    h = await withMigratedDb();
  });

  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  });

  /** Seed a user row (FK target for owner/member). */
  async function seedUser(id: string, email: string): Promise<string> {
    await h.db.insert(userTable).values({ id, name: id, email });
    return id;
  }

  /** Build the production access resolver wired against this DB (doc's-own-workspace scoped). */
  function makeResolveAccess() {
    const wsAccess = createWorkspaceAccess(h.db);
    const isWorkspaceMemberOfDoc = async (docId: string, userId: string): Promise<boolean> => {
      const wsId = await wsAccess.workspaceOfDoc(docId);
      return wsId ? wsAccess.isWorkspaceMember(wsId, userId) : false;
    };
    const resolveDocRole = createResolveDocRole(h.db, {
      isOwner: createIsDocOwner(h.db),
      isWorkspaceMember: isWorkspaceMemberOfDoc,
    });
    return createResolveAccess(h.db, { resolveDocRole });
  }

  test("AS-005 / C-007: a web-published doc is created with workspace_role=commenter/link_role=null and member B can view+comment", async () => {
    const ownerId = await seedUser(`u_a_${process.pid}_5`, `a${process.pid}5@x.test`);
    const { workspaceId, projectId } = await seedWorkspace(h.db, {
      userId: ownerId,
      withProject: true,
    });
    // Member B: a SECOND member of the same workspace (not the owner, not invited).
    const memberB = await seedUser(`u_b_${process.pid}_5`, `b${process.pid}5@x.test`);
    await seedWorkspace(h.db, { userId: memberB }); // gives B their own ws; add B to owner's ws:
    const { workspaceMembers } = await import("../../src/db/schema");
    await h.db.insert(workspaceMembers).values({ workspaceId, userId: memberB, role: "member" });

    // Publish via the real web path (publishDoc + the Drizzle repo), touching NO sharing.
    const { docId } = await publishDoc(
      {
        bytes: new TextEncoder().encode("# Spec body"),
        declaredKind: "markdown",
        ownerId,
        workspaceId,
        projectId,
      },
      { repo: createDocRepo(h.db), resolveProjectId: async () => projectId! },
    );

    // C-007: the share_links row exists with the FIXED new-doc default.
    const [link] = await h.db.select().from(shareLinks).where(eq(shareLinks.docId, docId));
    expect(link).toBeTruthy();
    expect(link!.workspaceRole).toBe("commenter");
    expect(link!.linkRole).toBeNull();

    // AS-005: member B (not owner, not invited) resolves to commenter and may comment.
    const resolveAccess = makeResolveAccess();
    const bViewer: Viewer = { kind: "user", userId: memberB };
    const bAccess = await resolveAccess(docId, bViewer);
    expect(bAccess.canView).toBe(true);
    expect(bAccess.role).toBe("commenter");
    expect(can(bAccess.role!, "comment")).toBe(true);
  });

  test("AS-006: a freshly published doc has no public link → a logged-out opener is denied", async () => {
    const ownerId = await seedUser(`u_a_${process.pid}_6`, `a${process.pid}6@x.test`);
    const { workspaceId, projectId } = await seedWorkspace(h.db, {
      userId: ownerId,
      withProject: true,
    });

    const { docId } = await publishDoc(
      {
        bytes: new TextEncoder().encode("# No link"),
        declaredKind: "markdown",
        ownerId,
        workspaceId,
        projectId,
      },
      { repo: createDocRepo(h.db), resolveProjectId: async () => projectId! },
    );

    // link_role is null → no capability token minted → an anon is refused at the readable address.
    const [link] = await h.db.select().from(shareLinks).where(eq(shareLinks.docId, docId));
    expect(link!.linkRole).toBeNull();
    expect(link!.capabilityToken).toBeNull();

    const resolveAccess = makeResolveAccess();
    const anon: Viewer = { kind: "anon" };
    const anonAccess = await resolveAccess(docId, anon);
    expect(anonAccess.canView).toBe(false);
    expect(anonAccess.role).toBeNull();
  });

  test("AS-025: a doc published over MCP gets the SAME default (workspace_role=commenter/link_role=null), member B can view+comment, no link", async () => {
    const ownerId = await seedUser(`u_a_${process.pid}_25`, `a${process.pid}25@x.test`);
    const { workspaceId, projectId } = await seedWorkspace(h.db, {
      userId: ownerId,
      withProject: true,
    });
    const memberB = await seedUser(`u_b_${process.pid}_25`, `b${process.pid}25@x.test`);
    const { workspaceMembers } = await import("../../src/db/schema");
    await h.db.insert(workspaceMembers).values({ workspaceId, userId: memberB, role: "member" });

    // Publish via the MCP create port — the SAME publish repo, so the SAME default applies.
    const createPort = createMcpCreateDocumentPort(h.db, "https://anchord.test");
    const res = await createPort({
      workspaceId,
      ownerId,
      content: "# MCP doc",
      format: "markdown",
      projectId,
    });

    // C-007 at the MCP surface: the share_links row carries the new-doc default (NOT the old restricted).
    const [link] = await h.db.select().from(shareLinks).where(eq(shareLinks.docId, res.docId));
    expect(link).toBeTruthy();
    expect(link!.workspaceRole).toBe("commenter");
    expect(link!.linkRole).toBeNull();
    expect(link!.capabilityToken).toBeNull();

    // member B can view + comment.
    const resolveAccess = makeResolveAccess();
    const bAccess = await resolveAccess(res.docId, { kind: "user", userId: memberB });
    expect(bAccess.canView).toBe(true);
    expect(bAccess.role).toBe("commenter");
    expect(can(bAccess.role!, "comment")).toBe(true);

    // no public link → anon denied.
    const anonAccess = await resolveAccess(res.docId, { kind: "anon" });
    expect(anonAccess.canView).toBe(false);
  });
});

// ── project-visibility S-004 (C-007 / C-013): a new doc's access DERIVES from its TARGET
//    project — non-default PUBLIC → {commenter,null} (AS-016), non-default PRIVATE →
//    {null,null}/restricted (AS-017), the DEFAULT project → {commenter,null} despite its
//    private shell (AS-018 carve-out), MCP-no-projectId → default project → reviewable
//    (AS-019). Verified END-TO-END (publish write → derived share_links row → resolveAccess)
//    against a real Postgres. ─────────────────────────────────────────────────────────────
describe.skipIf(!RUN)("publish new-doc access DERIVES from project (S-004, real Postgres)", () => {
  let h: MigratedDb;

  beforeAll(async () => {
    h = await withMigratedDb();
  });

  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  });

  async function seedUser(id: string, email: string): Promise<string> {
    await h.db.insert(userTable).values({ id, name: id, email });
    return id;
  }

  /** Insert a project with an explicit { isDefault, visibility } and return its id. */
  async function seedProject(
    workspaceId: string,
    ownerId: string,
    opts: { isDefault: boolean; visibility: "private" | "public"; name?: string },
  ): Promise<string> {
    const [p] = await h.db
      .insert(projects)
      .values({
        workspaceId,
        name: opts.name ?? "Project",
        ownerId,
        isDefault: opts.isDefault,
        visibility: opts.visibility,
      })
      .returning({ id: projects.id });
    return p!.id;
  }

  function makeResolveAccess() {
    const wsAccess = createWorkspaceAccess(h.db);
    const isWorkspaceMemberOfDoc = async (docId: string, userId: string): Promise<boolean> => {
      const wsId = await wsAccess.workspaceOfDoc(docId);
      return wsId ? wsAccess.isWorkspaceMember(wsId, userId) : false;
    };
    const resolveDocRole = createResolveDocRole(h.db, {
      isOwner: createIsDocOwner(h.db),
      isWorkspaceMember: isWorkspaceMemberOfDoc,
    });
    return createResolveAccess(h.db, { resolveDocRole });
  }

  /** Add member B to the owner's workspace (a real second member, not invited). */
  async function addMemberB(workspaceId: string, tag: string): Promise<string> {
    const memberB = await seedUser(`u_b_${process.pid}_${tag}`, `b${process.pid}${tag}@x.test`);
    const { workspaceMembers } = await import("../../src/db/schema");
    await h.db.insert(workspaceMembers).values({ workspaceId, userId: memberB, role: "member" });
    return memberB;
  }

  test("AS-016: publish into a non-default PUBLIC project → share_links {commenter, null}; member B can view+comment", async () => {
    const ownerId = await seedUser(`u_a_${process.pid}_16`, `a${process.pid}16@x.test`);
    const { workspaceId } = await seedWorkspace(h.db, { userId: ownerId });
    const projectId = await seedProject(workspaceId, ownerId, { isDefault: false, visibility: "public", name: "Pub" });
    const memberB = await addMemberB(workspaceId, "16");

    const { docId } = await publishDoc(
      { bytes: new TextEncoder().encode("# In public"), declaredKind: "markdown", ownerId, workspaceId, projectId },
      { repo: createDocRepo(h.db), resolveProjectId: async () => projectId },
    );

    const [link] = await h.db.select().from(shareLinks).where(eq(shareLinks.docId, docId));
    expect(link!.workspaceRole).toBe("commenter");
    expect(link!.linkRole).toBeNull();

    const bAccess = await makeResolveAccess()(docId, { kind: "user", userId: memberB });
    expect(bAccess.canView).toBe(true);
    expect(bAccess.role).toBe("commenter");
  });

  test("AS-017: publish into a non-default PRIVATE project → share_links {null, null}; member B cannot see it (restricted)", async () => {
    const ownerId = await seedUser(`u_a_${process.pid}_17`, `a${process.pid}17@x.test`);
    const { workspaceId } = await seedWorkspace(h.db, { userId: ownerId });
    const projectId = await seedProject(workspaceId, ownerId, { isDefault: false, visibility: "private", name: "Priv" });
    const memberB = await addMemberB(workspaceId, "17");

    const { docId } = await publishDoc(
      { bytes: new TextEncoder().encode("# In private"), declaredKind: "markdown", ownerId, workspaceId, projectId },
      { repo: createDocRepo(h.db), resolveProjectId: async () => projectId },
    );

    const [link] = await h.db.select().from(shareLinks).where(eq(shareLinks.docId, docId));
    expect(link!.workspaceRole).toBeNull();
    expect(link!.linkRole).toBeNull();

    // Derived restricted → only the owner reaches it; member B is denied.
    const resolveAccess = makeResolveAccess();
    expect((await resolveAccess(docId, { kind: "user", userId: memberB })).canView).toBe(false);
    expect((await resolveAccess(docId, { kind: "user", userId: ownerId })).canView).toBe(true);
  });

  test("AS-018: publish into the DEFAULT project (private shell) → {commenter, null} (carve-out holds); member B can view+comment", async () => {
    const ownerId = await seedUser(`u_a_${process.pid}_18`, `a${process.pid}18@x.test`);
    const { workspaceId } = await seedWorkspace(h.db, { userId: ownerId });
    // The default project is is_default + PRIVATE shell (the auto per-member default).
    const projectId = await seedProject(workspaceId, ownerId, { isDefault: true, visibility: "private", name: "A's docs" });
    const memberB = await addMemberB(workspaceId, "18");

    const { docId } = await publishDoc(
      { bytes: new TextEncoder().encode("# Quick publish"), declaredKind: "markdown", ownerId, workspaceId, projectId },
      { repo: createDocRepo(h.db), resolveProjectId: async () => projectId },
    );

    // Carve-out: despite the private shell, the default project's new docs stay workspace-shared.
    const [link] = await h.db.select().from(shareLinks).where(eq(shareLinks.docId, docId));
    expect(link!.workspaceRole).toBe("commenter");
    expect(link!.linkRole).toBeNull();

    const bAccess = await makeResolveAccess()(docId, { kind: "user", userId: memberB });
    expect(bAccess.canView).toBe(true);
    expect(bAccess.role).toBe("commenter");
  });

  test("AS-019: MCP create_document with NO projectId → lands in the owner's DEFAULT project → reviewer gets commenter (agent loop)", async () => {
    const ownerId = await seedUser(`u_a_${process.pid}_19`, `a${process.pid}19@x.test`);
    const { workspaceId } = await seedWorkspace(h.db, { userId: ownerId });
    const memberB = await addMemberB(workspaceId, "19");

    // No projectId → the real publish resolver (createPublishProjectResolver) ensureDefaultProject's
    // the owner's default (is_default + private shell) → the carve-out → {commenter,null}.
    const createPort = createMcpCreateDocumentPort(h.db, "https://anchord.test");
    const res = await createPort({ workspaceId, ownerId, content: "# Agent doc", format: "markdown" });

    const [link] = await h.db.select().from(shareLinks).where(eq(shareLinks.docId, res.docId));
    expect(link!.workspaceRole).toBe("commenter");
    expect(link!.linkRole).toBeNull();

    // The human reviewer (member B) can view + comment → the round-trip is reviewable.
    const bAccess = await makeResolveAccess()(res.docId, { kind: "user", userId: memberB });
    expect(bAccess.canView).toBe(true);
    expect(bAccess.role).toBe("commenter");

    // AS-029 / C-013: the create response reports the target (default) project + resulting access.
    expect(res.project).toBeTruthy();
    expect(res.access).toBe("anyone_in_workspace");
  });
});
