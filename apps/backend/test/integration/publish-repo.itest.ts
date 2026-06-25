// Integration tier (guarded by RUN_INTEGRATION): the Drizzle-backed DocRepo's
// createDocWithV1 against a REAL Postgres. Proves the doc + its version-1 row land
// in ONE transaction and are readable, and that the unique(doc_id, version) index
// actually rejects a duplicate version-1 insert (render-publish C-004 persistence).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { docVersions, docs, shareLinks, user as userTable } from "../../src/db/schema";
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

// ── doc-access-two-axis S-002 (C-007 / AS-005 / AS-006 / AS-025): a freshly published
//    doc is shared with its workspace at the comment level by default and has no public
//    link — verified END-TO-END (publish write → share_links row → the access resolver)
//    against a real Postgres, because the assertion spans the publish path and the read
//    gate. The web surface (AS-005/006) and the MCP surface (AS-025) BOTH route through
//    the publish repo, so both get the identical default. ─────────────────────────────
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
