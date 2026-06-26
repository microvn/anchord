// mcp-roundtrip S-006 — concrete Drizzle/service wiring for the project tools.
//
// Maps the tools' injectable ports onto the EXISTING workspace-project service (no new
// behaviour):
//   • listActiveProjects → ProjectRepo.listActive(workspaceId) (workspace-project S-003) —
//     non-archived projects in the workspace, to any member (C-010 workspace-member visibility,
//     no per-owner ACL). Scoped to the token's workspace_id (C-013).
//   • findProjectById    → ProjectRepo.findById(workspaceId, projectId) — already filters by
//     workspaceId, so a project in another workspace resolves to null (rejected-not-disclosed,
//     C-013/AS-017). Projects have no slug — id only.
//   • createProject      → the createProject service (workspace-project, C-002 any member) over
//     the same repo: a non-default project owned by the token-owner in the token's workspace.
//
// This module is THIN glue; the testable logic is in project-tools.ts. Kept separate so the
// unit suite never needs a DB. The repo reads are integration-verified in workspace-project.

import type { DB } from "../../db/client";
import { createProjectRepo } from "../../workspace/repo";
import { createProject, canViewProject } from "../../workspace/projects";
import { projectTools, type ProjectPorts, type ProjectSummary } from "./project-tools";
import type { ToolDef } from "../server";

/**
 * Concrete project ports over the workspace-project ProjectRepo + createProject service. All
 * three are scoped by the TOKEN's workspace_id at the call site (the handler passes
 * ctx.workspaceId) — C-013. createProject makes a non-default project owned by the token-owner.
 */
export function createMcpProjectPorts(db: DB): ProjectPorts {
  const repo = createProjectRepo(db);
  const toSummary = (p: {
    id: string;
    name: string;
    visibility: "private" | "public";
  }): ProjectSummary => ({
    projectId: p.id,
    name: p.name,
    // project-visibility S-001: surface the project's visibility (AS-003/AS-004).
    visibility: p.visibility,
  });
  return {
    async listActiveProjects(input): Promise<ProjectSummary[]> {
      // C-010/C-013: the workspace's ACTIVE (non-archived) projects, workspace-scoped.
      // project-visibility S-002 / C-002 / C-003: filtered to the projects the TOKEN USER may
      // VIEW (own + public, no admin exception) — another member's private project is absent.
      const rows = await repo.listActive(input.workspaceId);
      return rows.filter((p) => canViewProject(input.userId, p)).map(toSummary);
    },
    async findProjectById(input): Promise<ProjectSummary | null> {
      // findById is scoped to (workspaceId, projectId): a foreign id → null → rejected (C-013).
      // project-visibility S-002 / C-002: a project the token user can't view (another member's
      // private) ALSO resolves to null → rejected identically (existence-hiding, AS-010).
      const row = await repo.findById(input.workspaceId, input.projectId);
      if (!row || !canViewProject(input.userId, row)) return null;
      return toSummary(row);
    },
    async createProject(input): Promise<ProjectSummary> {
      // Reuse the workspace-project createProject service (C-002 any member) — a non-default
      // project owned by the token-owner in the token's workspace (C-010).
      const row = await createProject(
        {
          workspaceId: input.workspaceId,
          ownerId: input.ownerId,
          name: input.name,
          // project-visibility S-001: thread the optional override; the service defaults to public.
          visibility: input.visibility,
        },
        { repo },
      );
      return toSummary(row);
    },
  };
}

/** Build the concrete project tool registry fragment for the MCP server. */
export function createProjectToolsForDb(db: DB): Record<string, ToolDef> {
  return projectTools(createMcpProjectPorts(db));
}
