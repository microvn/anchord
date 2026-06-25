// Integration tier (RUN_INTEGRATION): doc-delete-trash S-005 over REAL Postgres + the REAL MCP
// delete/restore wiring. Guards the D-2 regression: `restore_document` gates on an ALREADY-DELETED
// doc, so the role resolver MUST ignore the tombstone. The original wiring built the gate from the
// deletion-AWARE resolveAccess (role:null for a deleted doc), which forbade restore for everyone —
// including the owner. This drives delete → restore through the real `createMcpDeleteToolsPorts` +
// real `createResolveDocRole` and asserts the owner can restore (AS-031). The no-DB unit suite uses
// fake ports and cannot see this seam.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { docs, shareLinks, user as userTable } from "../../src/db/schema";
import { createResolveDocRole, createIsDocOwner } from "../../src/sharing/resolve-doc-role-repo";
import {
  createMcpDeleteToolsPorts,
  type DeleteToolsWiringDeps,
} from "../../src/mcp/tools/delete-tools-wiring";
import { deleteDocumentHandler, restoreDocumentHandler } from "../../src/mcp/tools/delete-tools";
import { seedWorkspace, withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;

describe.skipIf(!RUN)("doc-delete-trash S-005: MCP delete → restore (real Postgres + real wiring)", () => {
  let h: MigratedDb;
  let WS = "";
  let PROJ = "";
  const OWNER = `u-mcp-${process.pid}`;
  const OTHER = `u-mcp-other-${process.pid}`;

  beforeAll(async () => {
    h = await withMigratedDb();
    await h.db.insert(userTable).values([
      { id: OWNER, name: "Owner", email: `${OWNER}@t.test`, emailVerified: true },
      { id: OTHER, name: "Other", email: `${OTHER}@t.test`, emailVerified: true },
    ]);
    const seeded = await seedWorkspace(h.db, { userId: OWNER, role: "admin", withProject: true });
    WS = seeded.workspaceId;
    PROJ = seeded.projectId!;
  });
  afterAll(async () => {
    await h.close();
    await h.stop();
  });

  // The REAL MCP ports, exactly as index.ts wires them: a DELETION-IGNORING resolveDocRole
  // (the D-2 fix) over the real owner read. isWorkspaceMember is irrelevant here (the doc is
  // owner-held), so a false stub is enough.
  function realPorts() {
    const resolveDocRole = createResolveDocRole(h.db, {
      isOwner: createIsDocOwner(h.db),
      isWorkspaceMember: async () => false,
    });
    const deps: DeleteToolsWiringDeps = {
      db: h.db,
      resolveDocRole,
      resolveActorName: async () => "Owner",
    };
    return createMcpDeleteToolsPorts(deps);
  }

  async function mkDoc(slug: string): Promise<void> {
    const [doc] = await h.db
      .insert(docs)
      .values({ slug, title: slug, kind: "markdown", ownerId: OWNER, projectId: PROJ })
      .returning({ id: docs.id });
    await h.db
      .insert(shareLinks)
      .values({ docId: doc!.id, workspaceRole: "commenter", linkRole: null, capabilityToken: `tok-${slug}` });
  }

  test("AS-031: the OWNER restores a doc they deleted over MCP — the role resolver ignores the tombstone", async () => {
    await mkDoc("mcp-roundtrip-doc");
    const ports = realPorts();
    const del = deleteDocumentHandler(ports);
    const restore = restoreDocumentHandler(ports);
    const ctx = { userId: OWNER, workspaceId: WS } as never;

    // delete → tombstoned
    const d = await del({ slug: "mcp-roundtrip-doc" }, ctx);
    expect(d.deleted).toBe(true);
    const afterDelete = await h.db.select().from(docs).where(eq(docs.slug, "mcp-roundtrip-doc"));
    expect(afterDelete[0]!.deletedAt).not.toBeNull();

    // restore → THE D-2 ASSERTION: succeeds for the owner even though the doc is deleted.
    const r = await restore({ slug: "mcp-roundtrip-doc" }, ctx);
    expect(r.restored).toBe(true);
    const afterRestore = await h.db.select().from(docs).where(eq(docs.slug, "mcp-roundtrip-doc"));
    expect(afterRestore[0]!.deletedAt).toBeNull();
    // C-008: restored private — both axes off + token rotated.
    const sl = await h.db.select().from(shareLinks).where(eq(shareLinks.docId, afterRestore[0]!.id));
    expect(sl[0]!.workspaceRole).toBeNull();
    expect(sl[0]!.linkRole).toBeNull();
  });

  test("AS-030: a NON-owner (no per-doc role) cannot restore over MCP — gate still refuses", async () => {
    await mkDoc("mcp-gate-doc");
    const ports = realPorts();
    const ownerCtx = { userId: OWNER, workspaceId: WS } as never;
    const otherCtx = { userId: OTHER, workspaceId: WS } as never;
    await deleteDocumentHandler(ports)({ slug: "mcp-gate-doc" }, ownerCtx);
    // OTHER has no per-doc role and there is NO admin arm over MCP → refused, doc stays deleted.
    await expect(restoreDocumentHandler(ports)({ slug: "mcp-gate-doc" }, otherCtx)).rejects.toThrow();
    const row = await h.db.select().from(docs).where(eq(docs.slug, "mcp-gate-doc"));
    expect(row[0]!.deletedAt).not.toBeNull();
  });
});
