// Drizzle-backed WorkspaceRepo (workspace-project S-001). THIN glue between the
// bootstrap service (setup.ts) and Postgres. No business logic lives here; the
// single-workspace rule, name validation, and slug derivation run in the service.
//
// The ONE thing this layer owns is the RACE-SAFE single-workspace guard (C-001):
// createWorkspaceWithAdmin re-counts inside the transaction and refuses if a
// workspace already exists, so two concurrent setup calls cannot both insert — the
// loser sees the winner's row and throws SetupRejected("already_set_up"). This is
// portable (a count-then-insert in a tx), NOT a Postgres-only partial-unique trick,
// so a future SQLite build stays open. The unique slug is a second backstop.
//
// Integration-verified against real Postgres in test/integration/workspace-setup.itest.ts.

import { sql } from "drizzle-orm";
import { workspaces, workspaceMembers } from "../db/schema";
import type { DB } from "../db/client";
import {
  SetupRejected,
  type WorkspaceRepo,
  type CreatedWorkspace,
} from "./setup";

/** Construct a WorkspaceRepo backed by a Drizzle DB handle. */
export function createWorkspaceRepo(db: DB): WorkspaceRepo {
  return {
    async countWorkspaces(): Promise<number> {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(workspaces);
      return row?.n ?? 0;
    },

    async createWorkspaceWithAdmin(input): Promise<CreatedWorkspace> {
      return db.transaction(async (tx) => {
        // C-001 in-tx guard: re-check zero workspaces under the transaction so a
        // concurrent setup loser refuses instead of inserting a second workspace.
        const [{ n }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(workspaces);
        if ((n ?? 0) > 0) {
          throw new SetupRejected("instance already set up", "already_set_up");
        }

        const [ws] = await tx
          .insert(workspaces)
          .values({ name: input.name, slug: input.slug, settings: input.settings })
          .returning({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name });

        await tx.insert(workspaceMembers).values({
          workspaceId: ws.id,
          userId: input.adminUserId,
          role: "admin",
        });

        return {
          workspaceId: ws.id,
          slug: ws.slug,
          name: ws.name,
          adminUserId: input.adminUserId,
        };
      });
    },

    async currentWorkspaceId(): Promise<string | null> {
      const [row] = await db.select({ id: workspaces.id }).from(workspaces).limit(1);
      return row?.id ?? null;
    },

    async addMember(workspaceId, userId, role): Promise<void> {
      // Idempotent on (workspace_id, user_id) via the composite unique index: a
      // re-run (e.g. a retried signup hook) is a no-op, never a duplicate row.
      await db
        .insert(workspaceMembers)
        .values({ workspaceId, userId, role })
        .onConflictDoNothing({
          target: [workspaceMembers.workspaceId, workspaceMembers.userId],
        });
    },
  };
}
