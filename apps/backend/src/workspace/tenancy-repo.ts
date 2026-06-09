// Drizzle-backed TenancyRepo (workspaces S-001..S-005). THIN glue — all rules live in
// tenancy.ts. Integration-verified against real Postgres in the workspaces itests.

import { and, eq, sql } from "drizzle-orm";
import {
  user,
  workspaces,
  workspaceMembers,
  workspaceInvitations,
} from "../db/schema";
import type { DB } from "../db/client";
import type {
  TenancyRepo,
  WorkspaceListItem,
  MemberDirectoryRow,
  InvitationRow,
  WorkspaceRole,
  InvitationStatus,
} from "./tenancy";

export function createTenancyRepo(db: DB): TenancyRepo {
  return {
    async createWorkspace(input) {
      const [ws] = await db
        .insert(workspaces)
        .values({ name: input.name, slug: input.slug, settings: {} })
        .returning({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name });
      return ws!;
    },

    async addMember(workspaceId, userId, role) {
      await db
        .insert(workspaceMembers)
        .values({ workspaceId, userId, role })
        .onConflictDoNothing({
          target: [workspaceMembers.workspaceId, workspaceMembers.userId],
        });
    },

    async setWorkspaceName(workspaceId, name) {
      await db.update(workspaces).set({ name }).where(eq(workspaces.id, workspaceId));
    },

    async findWorkspace(workspaceId) {
      const [row] = await db
        .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      return row ?? null;
    },

    async listMyWorkspaces(userId): Promise<WorkspaceListItem[]> {
      // The caller's memberships, each with the workspace + the caller's role.
      const mine = await db
        .select({
          id: workspaces.id,
          name: workspaces.name,
          slug: workspaces.slug,
          role: workspaceMembers.role,
        })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
        .where(eq(workspaceMembers.userId, userId));

      // The creating admin's display name per workspace (the EARLIEST admin row),
      // so two "default"s disambiguate (GAP-002/AS-006). One small query per workspace
      // keeps this portable (no window functions); the list is short (a user's own).
      const result: WorkspaceListItem[] = [];
      for (const w of mine) {
        const [admin] = await db
          .select({ name: user.name })
          .from(workspaceMembers)
          .innerJoin(user, eq(user.id, workspaceMembers.userId))
          .where(and(eq(workspaceMembers.workspaceId, w.id), eq(workspaceMembers.role, "admin")))
          .orderBy(workspaceMembers.createdAt)
          .limit(1);
        result.push({
          id: w.id,
          name: w.name,
          slug: w.slug,
          role: w.role as WorkspaceRole,
          adminName: admin?.name ?? null,
        });
      }
      return result;
    },

    async findMemberRole(workspaceId, userId): Promise<WorkspaceRole | null> {
      const [row] = await db
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
        );
      return (row?.role as WorkspaceRole | undefined) ?? null;
    },

    async setMemberRole(workspaceId, userId, role) {
      await db
        .update(workspaceMembers)
        .set({ role })
        .where(
          and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
        );
    },

    async removeMember(workspaceId, userId) {
      const deleted = await db
        .delete(workspaceMembers)
        .where(
          and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
        )
        .returning({ id: workspaceMembers.id });
      return deleted.length > 0;
    },

    async countAdmins(workspaceId) {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(workspaceMembers)
        .where(
          and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "admin")),
        );
      return row?.n ?? 0;
    },

    async listMembers(workspaceId): Promise<MemberDirectoryRow[]> {
      const rows = await db
        .select({
          userId: workspaceMembers.userId,
          role: workspaceMembers.role,
          name: user.name,
          email: user.email,
        })
        .from(workspaceMembers)
        .innerJoin(user, eq(user.id, workspaceMembers.userId))
        .where(eq(workspaceMembers.workspaceId, workspaceId));
      return rows.map((r) => ({
        userId: r.userId,
        role: r.role as WorkspaceRole,
        name: r.name,
        email: r.email,
      }));
    },

    async listInvitations(workspaceId): Promise<InvitationRow[]> {
      const rows = await db
        .select({
          id: workspaceInvitations.id,
          email: workspaceInvitations.email,
          role: workspaceInvitations.role,
          status: workspaceInvitations.status,
        })
        .from(workspaceInvitations)
        .where(
          and(
            eq(workspaceInvitations.workspaceId, workspaceId),
            eq(workspaceInvitations.status, "pending"),
          ),
        );
      return rows.map((r) => ({
        id: r.id,
        email: r.email,
        role: r.role as WorkspaceRole,
        status: r.status as InvitationStatus,
      }));
    },

    async createInvitation(input) {
      const [row] = await db
        .insert(workspaceInvitations)
        .values({
          workspaceId: input.workspaceId,
          email: input.email,
          role: input.role,
          token: input.token,
          invitedBy: input.invitedBy,
          expiresAt: input.expiresAt,
        })
        .returning({ id: workspaceInvitations.id, token: workspaceInvitations.token });
      return row!;
    },

    async findInvitation(id) {
      const [row] = await db
        .select({
          id: workspaceInvitations.id,
          workspaceId: workspaceInvitations.workspaceId,
          email: workspaceInvitations.email,
          role: workspaceInvitations.role,
          token: workspaceInvitations.token,
          status: workspaceInvitations.status,
          expiresAt: workspaceInvitations.expiresAt,
        })
        .from(workspaceInvitations)
        .where(eq(workspaceInvitations.id, id));
      if (!row) return null;
      return {
        ...row,
        role: row.role as WorkspaceRole,
        status: row.status as InvitationStatus,
      };
    },

    async setInvitationStatus(id, status) {
      await db
        .update(workspaceInvitations)
        .set({ status })
        .where(eq(workspaceInvitations.id, id));
    },

    async userName(userId) {
      const [row] = await db.select({ name: user.name }).from(user).where(eq(user.id, userId));
      return row?.name ?? null;
    },
  };
}

/**
 * Scoped membership reads for the route gate + access predicates (C-002).
 *  - isWorkspaceMember(workspaceId, userId): a member of THIS workspace (never "any").
 *  - workspaceRoleOf(workspaceId, userId): the caller's role, or null.
 *  - isWorkspaceAdminFor(workspaceId, userId): role === "admin" in THIS workspace.
 */
export function createWorkspaceAccess(db: DB) {
  return {
    async isWorkspaceMember(workspaceId: string, userId: string): Promise<boolean> {
      const [row] = await db
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .where(
          and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
        )
        .limit(1);
      return !!row;
    },
    async workspaceRoleOf(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
      const [row] = await db
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
        );
      return (row?.role as WorkspaceRole | undefined) ?? null;
    },
    async isWorkspaceAdminFor(workspaceId: string, userId: string): Promise<boolean> {
      const role = await this.workspaceRoleOf(workspaceId, userId);
      return role === "admin";
    },
    /** The doc's workspace (docs.project_id → projects.workspace_id), or null. */
    async workspaceOfDoc(docId: string): Promise<string | null> {
      const rows = await db.execute(sql`
        select p.workspace_id as workspace_id
        from docs d
        join projects p on p.id = d.project_id
        where d.id = ${docId}
        limit 1
      `);
      const list = (rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown as unknown[]);
      const first = (list as Array<Record<string, unknown>>)[0];
      return first ? String(first.workspace_id) : null;
    },
  };
}
